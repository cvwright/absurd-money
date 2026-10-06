/**
 * Reviewing an import (0022): matching new rows against the journal, suggesting which
 * rows replace a pending charge imported earlier, and building the entry a row posts as.
 * See "CSV import, client-side" in design/ACCOUNTING.md and "Import consumption and
 * matching" in design/SCHEMAS.md.
 *
 * Everything here only suggests. The heuristics (the date window, how ties break) are
 * client behavior, not schema, so they can change without touching anything posted.
 */

import { cmpDecimal, rescale, type Amount, type Commodity, type Decimal } from './amount.js';
import type { AccountId, BlobRef, IsoDate, Label, MsgId, PayeeId } from './ids.js';
import type { LabeledRow } from './import-ids.js';
import type { Entry } from './messages.js';
import { trimWhitespace } from './normalize.js';

/**
 * A split on the account being imported into, from an unreversed entry: one the projection
 * holds. With no `importId` it is unconfirmed, a candidate for a match. With one, it came
 * from an earlier import, and may be a pending charge a new row replaces.
 */
export interface JournalSplit {
  readonly txn: MsgId;
  readonly split: number;
  readonly date: IsoDate;
  /** As posted to the account. */
  readonly amount: Amount;
  readonly importId?: Label;
  readonly payee?: PayeeId;
  readonly memo?: string;
  /** The entry's other effective accounts, each once, in split order. */
  readonly others: readonly AccountId[];
}

/** How many days apart a row and a split may be dated and still be suggested. */
export const MATCH_DAYS = 7;

/** Whole days from `a` to `b`. */
export function dayDiff(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** `date` moved by `days`, which may be negative. */
export function shiftDate(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10) as IsoDate;
}

interface Row {
  readonly date: IsoDate;
  readonly amount: Decimal;
}

/**
 * Pairs rows with splits, each at most once, closest dates first; ties go to the earlier
 * row, then the earlier split in `splits`.
 */
function pairUp<S>(
  rows: readonly Row[],
  splits: readonly S[],
  score: (row: Row, split: S) => readonly bigint[] | undefined,
): Map<number, S> {
  const pairs: { i: number; j: number; score: readonly bigint[] }[] = [];
  rows.forEach((row, i) =>
    splits.forEach((split, j) => {
      const s = score(row, split);
      if (s) pairs.push({ i, j, score: s });
    }),
  );
  const order = (a: readonly bigint[], b: readonly bigint[]) => {
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
    return 0;
  };
  pairs.sort((x, y) => order(x.score, y.score) || x.i - y.i || x.j - y.j);
  const out = new Map<number, S>();
  const used = new Set<number>();
  for (const p of pairs) {
    if (out.has(p.i) || used.has(p.j)) continue;
    out.set(p.i, splits[p.j]);
    used.add(p.j);
  }
  return out;
}

/**
 * Each row's match, by index into `rows`: an unconfirmed split with the same amount
 * dated within `days`. That covers the other side of a transfer, posted when the other
 * account's file was imported, and an entry made by hand before the row was exported.
 */
export function findMatches(
  rows: readonly Row[],
  splits: readonly JournalSplit[],
  days = MATCH_DAYS,
): Map<number, JournalSplit> {
  const open = splits.filter((s) => s.importId === undefined);
  return pairUp(rows, open, (row, s) => {
    const d = Math.abs(dayDiff(s.date, row.date));
    return cmpDecimal(row.amount, s.amount) === 0 && d <= days ? [BigInt(d)] : undefined;
  });
}

/**
 * Each row's suggested replacement, by index into `rows`: an imported split this file
 * should list but doesn't. Its label is missing from `fileLabels` though its date is
 * within the file's dates, it has the row's sign, and it is dated within `days` of the
 * row. That is a pending charge that posted with another amount, date, or description,
 * such as a tip added. Closest dates first, then closest amounts.
 */
export function findReplacements(
  rows: readonly Row[],
  splits: readonly JournalSplit[],
  file: { readonly labels: ReadonlySet<Label>; readonly from: IsoDate; readonly to: IsoDate },
  days = MATCH_DAYS,
): Map<number, JournalSplit> {
  const gone = splits.filter(
    (s) => s.importId !== undefined && !file.labels.has(s.importId) && s.date >= file.from && s.date <= file.to,
  );
  return pairUp(rows, gone, (row, s) => {
    const d = Math.abs(dayDiff(s.date, row.date));
    if (d > days || row.amount.amount < 0n !== s.amount.amount < 0n) return undefined;
    const exp = Math.max(row.amount.exp, s.amount.exp);
    const diff = rescale(row.amount, exp).amount - rescale(s.amount, exp).amount;
    return [BigInt(d), diff < 0n ? -diff : diff];
  });
}

/** A row's description as a memo: trimmed, with runs of whitespace made one space. */
export function rowMemo(row: { readonly description: string }): string {
  return trimWhitespace(row.description).replace(/\s+/g, ' ');
}

/** What a row posts as, besides the row itself. */
export interface ImportEntryOptions {
  readonly account: AccountId;
  readonly cur: Commodity;
  /** The other side: an expense or income account, or another account for a transfer. */
  readonly category: AccountId;
  readonly payee?: PayeeId;
  readonly memo?: string;
  /** The imported file, uploaded once per import. */
  readonly source?: BlobRef;
  /** The reversed entry this one replaces: a pending charge that posted changed. */
  readonly replaces?: MsgId;
}

/**
 * The entry for a row: the row's amount on the account, carrying its label, and the
 * opposite on the category.
 */
export function importEntry(row: LabeledRow, o: ImportEntryOptions): Entry {
  const { amount, exp } = row.amount;
  const memo = o.memo?.trim();
  return {
    v: 1,
    date: row.date,
    splits: [
      { account: o.account, amount, exp, cur: o.cur, import_id: row.importId },
      { account: o.category, amount: -amount, exp, cur: o.cur },
    ],
    ...(o.payee && { payee: o.payee }),
    ...(memo && { memo }),
    ...(o.source && { source: o.source }),
    ...(o.replaces && { replaces: o.replaces }),
  };
}
