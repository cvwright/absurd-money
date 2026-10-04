/**
 * The fold of one `journal-YYYY` segment, in chain order: which messages count, and each
 * entry's effective fields after `ledger.edit` overlays. Rules: "Journal segment
 * messages" in design/SCHEMAS.md.
 *
 * Cross-segment facts (balances, reversal anomalies, import consumption, lots) are folded
 * from the results of this in ledger.ts and lots.ts.
 */

import { isNominal, type Chart } from '../chart.js';
import { CodecError } from '../errors.js';
import { segmentYear, type AccountId, type BlobRef, type Label, type MsgId, type PayeeId } from '../ids.js';
import {
  decodeMessage, TOPIC_TYPES, UnknownTypeError, UnknownVersionError,
  type Dismiss, type Edit, type Entry, type LotAdjust, type Reversal,
} from '../messages.js';
import { entryProblems, lotAdjustProblems, reversalProblems } from '../validate.js';

/** A decrypted message, before decoding. `data` is the parsed JSON (see json.ts). */
export interface RawMessage {
  readonly id: MsgId;
  readonly type: string;
  readonly data: unknown;
  /** Why the payload couldn't be decrypted or parsed, if it couldn't. It counts as malformed. */
  readonly error?: string;
}

export type AnomalyKind =
  | 'malformed'
  | 'invalid'
  | 'after-final-close'
  | 'edit-ignored'
  | 'reversal-mismatch'
  | 'reversed-twice'
  | 'import-id-reused'
  | 'lot';

export interface Anomaly {
  readonly kind: AnomalyKind;
  readonly msg: MsgId;
  readonly detail: string;
  /** For `edit-ignored`: the index of the edit within its message. */
  readonly edit?: number;
}

export interface EntryView {
  readonly id: MsgId;
  /** Position in the segment's chain. */
  readonly index: number;
  readonly entry: Entry;
  /** Effective account of each split, after edits. */
  readonly accounts: AccountId[];
  /** Effective `import_id` of each split, after edits. */
  readonly importIds: (Label | undefined)[];
  memo: string | undefined;
  payee: PayeeId | undefined;
  receipts: readonly BlobRef[];
  /** Valid reversals of this entry earlier in this segment's chain. */
  readonly reversedBy: MsgId[];
}

export interface ReversalView {
  readonly id: MsgId;
  readonly index: number;
  readonly reversal: Reversal;
}

export interface LotAdjustView {
  readonly id: MsgId;
  readonly index: number;
  readonly msg: LotAdjust;
}

export interface DismissView {
  readonly id: MsgId;
  readonly index: number;
  readonly msg: Dismiss;
}

export interface SegmentFold {
  readonly topic: string;
  readonly year: number;
  readonly entries: ReadonlyMap<MsgId, EntryView>;
  readonly reversals: ReadonlyMap<MsgId, ReversalView>;
  readonly lotAdjusts: readonly LotAdjustView[];
  readonly dismissals: readonly DismissView[];
  readonly anomalies: readonly Anomaly[];
  /**
   * Set when the fold stopped at a message type or `v` this client doesn't know. Nothing
   * from that message on is folded, so balances are incomplete; ask the user to update.
   */
  readonly halted?: { readonly at: MsgId; readonly error: UnknownTypeError | UnknownVersionError };
}

export interface SegmentContext {
  readonly chart: Chart;
  /** Every head in this segment cited by a `ledger.checkpoint`. Locking is positional. */
  readonly lockHeads?: readonly MsgId[];
  /** Heads in this segment cited with `final: true`. */
  readonly finalHeads?: readonly MsgId[];
}

const JOURNAL_TYPES: readonly string[] = TOPIC_TYPES.journal;

export function foldSegment(
  topic: string,
  messages: readonly RawMessage[],
  ctx: SegmentContext,
): SegmentFold {
  const year = segmentYear(topic);
  if (year === undefined) throw new RangeError(`${topic} is not a journal segment`);

  const position = new Map<MsgId, number>();
  messages.forEach((m, i) => position.set(m.id, i));
  const lockIndices = (ctx.lockHeads ?? [])
    .map((h) => position.get(h))
    .filter((i): i is number => i !== undefined);
  const frozenAfter = Math.min(
    Infinity,
    ...(ctx.finalHeads ?? []).map((h) => position.get(h)).filter((i): i is number => i !== undefined),
  );

  const entries = new Map<MsgId, EntryView>();
  const reversals = new Map<MsgId, ReversalView>();
  const lotAdjusts: LotAdjustView[] = [];
  const dismissals: DismissView[] = [];
  const anomalies: Anomaly[] = [];
  let halted: SegmentFold['halted'];

  for (let index = 0; index < messages.length; index++) {
    const { id, type, data, error } = messages[index];
    if (index > frozenAfter) {
      anomalies.push({ kind: 'after-final-close', msg: id, detail: `posted after ${topic} was frozen` });
      continue;
    }

    let msg;
    try {
      if (!JOURNAL_TYPES.includes(type)) throw new UnknownTypeError(type);
      if (error !== undefined) throw new CodecError(error);
      msg = decodeMessage(type, data);
    } catch (e) {
      if (e instanceof UnknownTypeError || e instanceof UnknownVersionError) {
        halted = { at: id, error: e };
        break;
      }
      if (e instanceof CodecError) {
        anomalies.push({ kind: 'malformed', msg: id, detail: e.message });
        continue;
      }
      throw e;
    }

    const invalid = (problems: string[]) => {
      if (problems.length === 0) return false;
      anomalies.push({ kind: 'invalid', msg: id, detail: problems.join('; ') });
      return true;
    };

    switch (type) {
      case 'ledger.entry': {
        const entry = msg as Entry;
        if (invalid(entryProblems(entry, ctx.chart, year))) break;
        entries.set(id, {
          id,
          index,
          entry,
          accounts: entry.splits.map((s) => s.account),
          importIds: entry.splits.map((s) => s.import_id),
          memo: entry.memo,
          payee: entry.payee,
          receipts: entry.receipts ?? [],
          reversedBy: [],
        });
        break;
      }
      case 'ledger.reversal': {
        const reversal = msg as Reversal;
        if (invalid(reversalProblems(reversal, ctx.chart, year))) break;
        reversals.set(id, { id, index, reversal });
        entries.get(reversal.reverses)?.reversedBy.push(id);
        break;
      }
      case 'ledger.edit': {
        const locked = (target: EntryView) =>
          lockIndices.some((h) => target.index <= h && h < index);
        (msg as { edits: readonly Edit[] }).edits.forEach((edit, i) => {
          const problem = editProblem(edit, entries.get(edit.target), ctx.chart, locked);
          if (problem) {
            anomalies.push({ kind: 'edit-ignored', msg: id, edit: i, detail: problem });
          } else {
            applyEdit(edit, entries.get(edit.target)!);
          }
        });
        break;
      }
      case 'ledger.dismiss':
        dismissals.push({ id, index, msg: msg as Dismiss });
        break;
      case 'ledger.lotadjust': {
        const adj = msg as LotAdjust;
        if (invalid(lotAdjustProblems(adj, ctx.chart, year))) break;
        lotAdjusts.push({ id, index, msg: adj });
        break;
      }
    }
  }

  return { topic, year, entries, reversals, lotAdjusts, dismissals, anomalies, halted };
}

/** Why one edit is ignored, or `undefined` if it applies. All its fields stand or fall together. */
function editProblem(
  edit: Edit,
  target: EntryView | undefined,
  chart: Chart,
  locked: (target: EntryView) => boolean,
): string | undefined {
  if (!target) return 'target is not an entry earlier in this segment';
  const splits = target.entry.splits;

  if (edit.splits) {
    if (locked(target)) return 'target is locked';
    if (target.reversedBy.length > 0) return 'target is reversed';
    for (const [k, account] of Object.entries(edit.splits)) {
      const i = Number(k);
      if (i >= splits.length) return `no split ${k}`;
      const before = chart.get(target.accounts[i]);
      const after = chart.get(account);
      if (!isNominal(before) || !isNominal(after)) {
        return `split ${k}: only income and expense accounts can be recategorized`;
      }
      if (after!.cur !== splits[i].cur) return `split ${k}: new account holds ${after!.cur}`;
    }
  }
  if (edit.import_ids) {
    for (const k of Object.keys(edit.import_ids)) {
      const i = Number(k);
      if (i >= splits.length) return `no split ${k}`;
      if (target.importIds[i] !== undefined) return `split ${k} already has an import_id`;
    }
  }
  return undefined;
}

function applyEdit(edit: Edit, target: EntryView): void {
  if (edit.memo !== undefined) target.memo = edit.memo ?? undefined;
  if (edit.payee !== undefined) target.payee = edit.payee ?? undefined;
  if (edit.receipts !== undefined) target.receipts = edit.receipts;
  for (const [k, account] of Object.entries(edit.splits ?? {})) target.accounts[Number(k)] = account;
  for (const [k, label] of Object.entries(edit.import_ids ?? {})) target.importIds[Number(k)] = label;
}
