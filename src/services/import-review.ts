/**
 * Approving a reviewed import (0022): what each row's decision posts, in an order that
 * never leaves a row half-handled. See "CSV import, client-side" in design/ACCOUNTING.md
 * and "Import consumption and matching" in design/SCHEMAS.md.
 *
 * - **Dismiss** posts `ledger.dismiss`, as does a match whose split's segment is frozen.
 * - **Match** posts a `ledger.edit` setting the split's `import_id`.
 * - **Add** posts a `ledger.entry` carrying the row's label and the uploaded file.
 * - **Replace** reverses the pending entry, then posts the row as its replacement.
 *
 * Rows are posted one decision at a time where they can fail separately, so one bad row
 * doesn't stop the rest. Whatever posted stays posted, and its rows are consumed, so
 * approving again only retries the rest.
 */

import type { Commodity } from '@/core/amount.js';
import type { EditTarget } from '@/core/edit.js';
import { yearOf, type AccountId, type BlobRef, type IsoDate, type Label, type MsgId, type PayeeId } from '@/core/ids.js';
import type { LabeledRow } from '@/core/import-ids.js';
import type { Edit, PayeesDoc } from '@/core/messages.js';
import { normalizeDescription } from '@/core/normalize.js';
import { cleanPayeeName, findPayee } from '@/core/payees.js';
import { defaultReversalDate, reversalOf, type ReversalTarget } from '@/core/reversal.js';
import { importEntry, type JournalSplit } from '@/core/review.js';
import type { LedgerSpace } from './ledger-space.js';

export type Decision =
  | { readonly kind: 'add'; readonly category: AccountId; readonly payee: string; readonly memo: string }
  | { readonly kind: 'match'; readonly split: JournalSplit }
  | {
      readonly kind: 'replace';
      readonly target: JournalSplit;
      readonly category: AccountId;
      readonly payee: string;
      readonly memo: string;
    }
  | { readonly kind: 'dismiss' };

export interface Approval {
  readonly row: LabeledRow;
  readonly decision: Decision;
}

/** The projection queries approval needs, as the projection client answers them. */
export interface ReviewProjection {
  consumed(labels: readonly Label[]): Promise<ReadonlySet<Label>>;
  editTarget(id: MsgId): Promise<EditTarget | undefined>;
  reversalTarget(id: MsgId): Promise<ReversalTarget | undefined>;
  segmentOpen(year: number): Promise<boolean>;
}

export type ReviewLedger = Pick<
  LedgerSpace,
  'postEntry' | 'postEdits' | 'postDismissals' | 'postReversal' | 'addPayee' | 'uploadReceipt'
>;

export interface ApproveContext {
  readonly account: AccountId;
  readonly cur: Commodity;
  /** The imported file, uploaded as the entries' `source` if any row is added. */
  readonly file: Uint8Array;
  readonly payees: PayeesDoc | undefined;
  readonly today: IsoDate;
}

export interface ApproveResult {
  /** The labels of the rows handled. */
  readonly done: ReadonlySet<Label>;
  /** The rows that failed, by label, with why. */
  readonly failed: ReadonlyMap<Label, string>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function approve(
  ledger: ReviewLedger,
  projection: ReviewProjection,
  ctx: ApproveContext,
  approvals: readonly Approval[],
): Promise<ApproveResult> {
  const done = new Set<Label>();
  const failed = new Map<Label, string>();
  const fail = (rows: readonly LabeledRow[], err: unknown) => {
    for (const r of rows) failed.set(r.importId, message(err));
  };

  // Another device may have handled some rows since review loaded them.
  const consumed = new Set(await projection.consumed(approvals.map((a) => a.row.importId)));
  const todo = approvals.filter((a) => {
    if (!consumed.has(a.row.importId)) return true;
    failed.set(a.row.importId, 'already imported or dismissed');
    return false;
  });

  const open = new Map<number, boolean>();
  const segmentOpen = async (year: number) => {
    if (!open.has(year)) open.set(year, await projection.segmentOpen(year));
    return open.get(year)!;
  };

  // Matches: an edit on the split's entry, or a dismissal if its segment is frozen.
  const edits: Edit[] = [];
  const editRows: LabeledRow[] = [];
  const targets = new Map<MsgId, EditTarget>();
  const dismiss: LabeledRow[] = todo.filter((a) => a.decision.kind === 'dismiss').map((a) => a.row);
  for (const { row, decision } of todo) {
    if (decision.kind !== 'match') continue;
    const target = targets.get(decision.split.txn) ?? (await projection.editTarget(decision.split.txn));
    if (!target) {
      failed.set(row.importId, 'the matched entry is no longer in the journal');
      continue;
    }
    if (!target.segmentOpen) {
      dismiss.push(row);
      continue;
    }
    targets.set(target.id, target);
    edits.push({ target: target.id, import_ids: { [String(decision.split.split)]: row.importId } });
    editRows.push(row);
  }

  if (dismiss.length > 0) {
    try {
      for (const r of dismiss) await segmentOpen(yearOf(r.date));
      await ledger.postDismissals(dismiss, { consumed, segmentOpen: (y) => open.get(y)! });
      for (const r of dismiss) done.add(r.importId);
    } catch (err) {
      fail(dismiss, err);
    }
  }
  if (edits.length > 0) {
    try {
      await ledger.postEdits(edits, targets, consumed);
      for (const r of editRows) done.add(r.importId);
    } catch (err) {
      fail(editRows, err);
    }
  }

  // New entries: the file is uploaded once, and each new payee added once.
  const entries = todo.filter((a) => a.decision.kind === 'add' || a.decision.kind === 'replace');
  if (entries.length === 0) return { done, failed };
  let source: BlobRef;
  try {
    source = await ledger.uploadReceipt(ctx.file);
  } catch (err) {
    fail(entries.map((a) => a.row), err);
    return { done, failed };
  }
  const payeeIds = new Map<string, PayeeId>();
  const payeeOf = async (name: string): Promise<PayeeId | undefined> => {
    const clean = cleanPayeeName(name);
    if (clean === '') return undefined;
    // Payee names match after normalization, as `findPayee` matches them.
    const key = normalizeDescription(clean);
    const id = payeeIds.get(key) ?? findPayee(ctx.payees, clean) ?? (await ledger.addPayee(clean));
    payeeIds.set(key, id);
    return id;
  };

  for (const { row, decision } of entries) {
    if (decision.kind !== 'add' && decision.kind !== 'replace') continue;
    try {
      const payee = await payeeOf(decision.payee);
      const opts = { account: ctx.account, cur: ctx.cur, category: decision.category, memo: decision.memo, source, ...(payee && { payee }) };
      let replaced: ReversalTarget | undefined;
      if (decision.kind === 'replace') {
        replaced = await reversePending(ledger, projection, decision.target.txn, ctx.today, segmentOpen);
      }
      const entry = importEntry(row, { ...opts, ...(replaced && { replaces: replaced.id }) });
      await ledger.postEntry(entry, await segmentOpen(yearOf(row.date)), replaced, consumed);
      done.add(row.importId);
    } catch (err) {
      failed.set(row.importId, message(err));
    }
  }
  return { done, failed };
}

/**
 * Reverses the pending entry `id`, unless it already is, and returns it as the
 * replacement's `replaced` needs it. Its label stays consumed: the pending row was seen.
 */
async function reversePending(
  ledger: ReviewLedger,
  projection: ReviewProjection,
  id: MsgId,
  today: IsoDate,
  segmentOpen: (year: number) => Promise<boolean>,
): Promise<ReversalTarget> {
  const target = await projection.reversalTarget(id);
  if (!target) throw new Error('the pending entry is no longer in the journal');
  if (target.replacedBy !== undefined) throw new Error(`the pending entry was already replaced by ${target.replacedBy}`);
  if (target.reversedBy !== undefined) return target;
  const reversal = reversalOf(target, { date: defaultReversalDate(target, today), memo: 'Pending charge, replaced by import' });
  const reversedBy = await ledger.postReversal(reversal, target, await segmentOpen(yearOf(reversal.date)));
  return { ...target, reversedBy };
}
