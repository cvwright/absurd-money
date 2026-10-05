/**
 * Import idempotency (0023): the `import/v1` label of each row of a statement, which rows
 * are new, and dismissing rows. The label inputs are pinned in design/NORMALIZATION.md;
 * consumption is "Import consumption and matching" in design/SCHEMAS.md.
 *
 * A row is consumed iff its label is the effective `import_id` of some split or appears in
 * a `ledger.dismiss`. Re-importing a file, or one that overlaps it, finds every row it has
 * already seen consumed, so nothing is posted twice.
 */

import { canonical } from './amount.js';
import type { ImportRow } from './csv-import.js';
import { segmentOf, yearOf, type AccountId, type IsoDate, type Label } from './ids.js';
import { importLabel, type LabelKeys } from './labels.js';
import type { Dismiss } from './messages.js';
import { importInputFitid, importInputRow, normalizeDescription } from './normalize.js';

/** A row with its `import/v1` label. */
export interface LabeledRow extends ImportRow {
  readonly importId: Label;
}

/**
 * The label input of each row, in order. Rows from a `fitid` profile use the `fitid`
 * scheme; the others use the row scheme, whose `n` counts earlier rows in the file with
 * the same date, amount (by value), and normalized description. Throws if the rows mix
 * schemes, which one account's file never may.
 */
export function importInputs(rows: readonly ImportRow[], account: AccountId): string[] {
  const fitid = rows.some((r) => r.fitid !== undefined);
  if (fitid && rows.some((r) => r.fitid === undefined)) {
    throw new RangeError('a file uses one import ID scheme, never both');
  }
  if (fitid) return rows.map((r) => importInputFitid(account, r.fitid!));
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const key = `${r.date}|${canonical(r.amount)}|${normalizeDescription(r.description)}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return importInputRow({ account, date: r.date, amount: r.amount, description: r.description, n });
  });
}

/** Each row with its label, for importing into `account`. */
export function labelRows(rows: readonly ImportRow[], account: AccountId, keys: LabelKeys): LabeledRow[] {
  const inputs = importInputs(rows, account);
  return rows.map((r, i) => ({ ...r, importId: importLabel(keys, inputs[i]) }));
}

/** The rows not yet consumed: the ones review shows. */
export function freshRows<R extends { readonly importId: Label }>(
  rows: readonly R[],
  consumed: ReadonlySet<Label>,
): R[] {
  return rows.filter((r) => !consumed.has(r.importId));
}

/** What dismissing a row needs: its label, and its date, which routes the dismissal. */
export interface DismissRow {
  readonly date: IsoDate;
  readonly importId: Label;
}

/**
 * The most labels one dismissal carries. A label is 20 characters, so a message stays
 * far under the server's limit (`MAX_EDIT_BYTES` in edit.ts).
 */
export const MAX_DISMISS_LABELS = 2000;

/**
 * `ledger.dismiss` messages for `rows`, routed to the segment of each row's year, with no
 * repeated label and at most `max` labels in each.
 */
export function packDismissals(
  rows: readonly DismissRow[],
  max = MAX_DISMISS_LABELS,
): { year: number; msg: Dismiss }[] {
  const byYear = new Map<number, Label[]>();
  const seen = new Set<Label>();
  for (const r of rows) {
    if (seen.has(r.importId)) continue;
    seen.add(r.importId);
    const year = yearOf(r.date);
    let list = byYear.get(year);
    if (!list) byYear.set(year, (list = []));
    list.push(r.importId);
  }
  const out: { year: number; msg: Dismiss }[] = [];
  for (const [year, labels] of [...byYear].sort(([a], [b]) => a - b)) {
    for (let i = 0; i < labels.length; i += max) {
      out.push({ year, msg: { v: 1, import_ids: labels.slice(i, i + max) } });
    }
  }
  return out;
}

/** Post-time rules for a dismissal in the segment of `year`. */
export function dismissPostProblems(
  msg: Dismiss,
  ctx: { readonly consumed: ReadonlySet<Label>; readonly segmentOpen: boolean; readonly year: number },
): string[] {
  const problems: string[] = [];
  for (const label of msg.import_ids) {
    if (ctx.consumed.has(label)) problems.push(`import row ${label} is already consumed`);
  }
  if (!ctx.segmentOpen) problems.push(`${segmentOf(ctx.year)} is frozen`);
  return problems;
}
