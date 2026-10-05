/**
 * Edits: changing an entry's memo, payee, receipts, or the category of its income and
 * expense splits after it is posted, as a `ledger.edit` overlay (0015). Rules:
 * "ledger.edit" in design/SCHEMAS.md.
 *
 * An edit routes to its target's segment, so a message only carries edits of entries in
 * one segment. `packEdits` groups and splits them so each message stays under the
 * server's size limit.
 */

import { isNominal, type Chart } from './chart.js';
import { segmentOf, type AccountId, type BlobRef, type Label, type MsgId, type PayeeId } from './ids.js';
import { stringifyJson } from './json.js';
import { encodeMessage, type Edit, type EditMessage, type PayeesDoc } from './messages.js';
import type { ReversalTarget } from './reversal.js';
import { editProblem } from './validate.js';

/** What a client needs to know about an entry to edit it: its effective fields, after edits. */
export interface EditTarget extends ReversalTarget {
  /** The year of the entry's segment, which its edits route to. */
  readonly year: number;
  readonly memo?: string;
  readonly payee?: PayeeId;
  readonly receipts: readonly BlobRef[];
  /** Effective `import_id` of each split. */
  readonly importIds: readonly (Label | undefined)[];
}

/** The fields an edit sets, as the user left them. Absent fields are kept. */
export interface EditChanges {
  /** Blank clears the memo. */
  readonly memo?: string;
  /** `null` clears the payee. */
  readonly payee?: PayeeId | null;
  readonly receipts?: readonly BlobRef[];
  /** Split index to its new account. */
  readonly splits?: ReadonlyMap<number, AccountId>;
}

/**
 * Whether split `i` of `target` can be moved to another account: it is on an income or
 * expense account, and the entry is neither locked nor reversed.
 */
export function canRecategorize(target: EditTarget, chart: Chart, i: number): boolean {
  return !target.locked && target.reversedBy === undefined && isNominal(chart.get(target.accounts[i]));
}

const sameReceipts = (a: readonly BlobRef[], b: readonly BlobRef[]) =>
  a.length === b.length && a.every((r, i) => r.blob === b[i].blob && r.dek === b[i].dek);

/**
 * The edit that takes `target` to `changes`, naming only the fields that differ from
 * their effective values. Undefined if nothing differs.
 */
export function editOf(target: EditTarget, changes: EditChanges): Edit | undefined {
  const out: { -readonly [K in keyof Edit]: Edit[K] } = { target: target.id };
  if (changes.memo !== undefined) {
    const memo = changes.memo.trim() || undefined;
    if (memo !== target.memo) out.memo = memo ?? null;
  }
  if (changes.payee !== undefined && (changes.payee ?? undefined) !== target.payee) out.payee = changes.payee;
  if (changes.receipts !== undefined && !sameReceipts(changes.receipts, target.receipts)) {
    out.receipts = changes.receipts;
  }
  const splits: Record<string, AccountId> = {};
  for (const [i, account] of [...(changes.splits ?? [])].sort(([a], [b]) => a - b)) {
    if (target.accounts[i] !== account) splits[String(i)] = account;
  }
  if (Object.keys(splits).length > 0) out.splits = splits;
  return Object.keys(out).length > 1 ? out : undefined;
}

export interface EditPostContext {
  readonly chart: Chart;
  readonly payees?: PayeesDoc;
  /** The entry `edit.target` names, or undefined if the client holds no such entry. */
  readonly target: EditTarget | undefined;
  /** Every consumed import label. Needed to post an edit that sets `import_ids`. */
  readonly consumed?: ReadonlySet<Label>;
}

/**
 * Everything checked before posting one edit: the fold-time rules plus post-time ones.
 * Reversed means reversed anywhere: a reversal in a later segment can only follow a
 * final close of the target's, after which nothing more can be posted there.
 */
export function editPostProblems(edit: Edit, ctx: EditPostContext): string[] {
  const { target, chart } = ctx;
  if (!target || target.id !== edit.target) return ['the edited message is not a known entry'];
  const problems: string[] = [];
  for (const [k, label] of Object.entries(edit.import_ids ?? {})) {
    if (!ctx.consumed) problems.push('import matches need the consumed import labels');
    else if (ctx.consumed.has(label)) problems.push(`split ${k}: import row already consumed`);
  }
  const problem = editProblem(
    edit,
    {
      splits: target.splits,
      accounts: target.accounts,
      importIds: target.importIds,
      locked: target.locked,
      reversed: target.reversedBy !== undefined,
    },
    chart,
  );
  if (problem) problems.push(problem);
  for (const [k, account] of Object.entries(edit.splits ?? {})) {
    if (chart.get(account)?.closed_at !== undefined) problems.push(`split ${k}: account is closed`);
  }
  if (edit.payee && ctx.payees && !Object.hasOwn(ctx.payees.payees, edit.payee)) problems.push('unknown payee');
  if (!target.segmentOpen) problems.push(`${segmentOf(target.year)} is frozen`);
  return problems;
}

/**
 * The most plaintext a message may carry. The server allows 100 KB of payload, which is
 * the ciphertext in base64: 4/3 of the plaintext plus the AES-GCM nonce and tag.
 */
export const MAX_EDIT_BYTES = 72 * 1024;

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** `{"v":1,"edits":[]}`, the bytes of a message besides its edits and their commas. */
const ENVELOPE_BYTES = utf8Length(stringifyJson({ v: 1, edits: [] }));

/**
 * Packs edits into messages for their targets' segments, in order, each at most `max`
 * bytes once encoded. `yearOf` gives the segment year of each edit's target. Throws
 * `CodecError` if an edit is malformed, and `RangeError` if one alone is over the limit.
 */
export function packEdits(
  edits: readonly Edit[],
  yearOf: (target: MsgId) => number,
  max = MAX_EDIT_BYTES,
): { year: number; msg: EditMessage }[] {
  const out: { year: number; msg: EditMessage }[] = [];
  const open = new Map<number, { edits: Edit[]; bytes: number }>();
  for (const e of edits) {
    // Encoding checks the edit, and a message's JSON is its edits' JSON joined by commas.
    const bytes = utf8Length(encodeMessage('ledger.edit', { v: 1, edits: [e] })) - ENVELOPE_BYTES;
    if (ENVELOPE_BYTES + bytes > max) throw new RangeError(`an edit of ${e.target} is too large to post`);
    const year = yearOf(e.target);
    let batch = open.get(year);
    if (batch && batch.bytes + 1 + bytes > max) {
      out.push({ year, msg: { v: 1, edits: batch.edits } });
      batch = undefined;
    }
    if (!batch) open.set(year, (batch = { edits: [], bytes: ENVELOPE_BYTES - 1 }));
    batch.edits.push(e);
    batch.bytes += 1 + bytes;
  }
  for (const [year, batch] of open) out.push({ year, msg: { v: 1, edits: batch.edits } });
  return out;
}
