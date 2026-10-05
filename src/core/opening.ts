/**
 * The opening-balances entry: one `ledger.entry` that brings each balance-sheet account to
 * its balance on the day the books start, against an equity account per commodity. See
 * "One logical ledger for all time" in design/ACCOUNTING.md (0009).
 *
 * It is an ordinary entry with no special type or flag. Opening lots are lot-creating
 * splits whose `acquired` is the real acquisition date, earlier than the entry's.
 */

import { neg, sumByCommodity, type Amount, type Commodity, type Decimal } from './amount.js';
import { accountLabel, type Chart } from './chart.js';
import type { AccountId, IsoDate } from './ids.js';
import type { Account, Entry, Split } from './messages.js';
import { entryProblems } from './validate.js';

/** The name given to the equity accounts that opening balances post against. */
export const OPENING_EQUITY_NAME = 'Opening Balances';

export interface OpeningLot {
  /** Quantity held, in the account's commodity. Positive. */
  readonly qty: Decimal;
  /** Total cost of the lot, never per unit. */
  readonly cost: Amount;
  readonly acquired: IsoDate;
}

/**
 * One account's opening position. `balance` is in the account's natural sign: what an
 * asset holds, or what a liability owes. A negative balance is an overdrawn asset or a
 * liability in credit. An asset holding lots gives `lots` instead.
 */
export type OpeningLine =
  | { readonly account: AccountId; readonly balance: Decimal }
  | { readonly account: AccountId; readonly lots: readonly OpeningLot[] };

export interface OpeningInput {
  readonly date: IsoDate;
  readonly lines: readonly OpeningLine[];
  /** The equity account that balances each commodity. See `findOpeningEquity`. */
  readonly equity: ReadonlyMap<Commodity, AccountId>;
  readonly memo?: string;
}

export type OpeningResult =
  | { readonly entry: Entry; readonly problems?: undefined }
  | { readonly entry?: undefined; readonly problems: readonly string[] };

/** Whether an account can be the equity side of opening balances in `cur`. */
export function isOpeningEquity(a: Account | undefined, cur: Commodity): boolean {
  return a !== undefined && a.type === 'equity' && a.cur === cur && a.closed_at === undefined;
}

/**
 * The open equity account named "Opening Balances" in `cur`, if the chart has one. Names
 * are not unique, so with several it takes the first by ID, which is stable.
 */
export function findOpeningEquity(chart: Chart, cur: Commodity): AccountId | undefined {
  const ids = [...chart.keys()].sort();
  return ids.find((id) => {
    const a = chart.get(id);
    return isOpeningEquity(a, cur) && a!.name.trim().toLowerCase() === OPENING_EQUITY_NAME.toLowerCase();
  });
}

/**
 * Every equity account named "Opening Balances", in any commodity, open or closed: the
 * accounts whose entries count as opening balances already posted (0035). An opening entry
 * has no flag, so this is how one is recognized.
 */
export function openingEquityAccounts(chart: Chart): AccountId[] {
  return [...chart]
    .filter(([, a]) => a.type === 'equity' && a.name.trim().toLowerCase() === OPENING_EQUITY_NAME.toLowerCase())
    .map(([id]) => id)
    .sort();
}

/** A new chart entry for the opening equity account in `cur`. */
export function openingEquityAccount(cur: Commodity): Account {
  return { name: OPENING_EQUITY_NAME, type: 'equity', cur, parent: null };
}

/**
 * The splits for each account's opening position, without the equity side. Zero balances
 * are left out. Each lot is its own split, so an account with three lots gets three.
 */
function positionSplits(date: IsoDate, lines: readonly OpeningLine[], chart: Chart, problems: string[]): Split[] {
  const splits: Split[] = [];
  const seen = new Set<AccountId>();

  for (const line of lines) {
    const a = chart.get(line.account);
    const name = a ? `"${accountLabel(chart, line.account)}"` : line.account;
    if (!a) {
      problems.push(`${name}: unknown account`);
      continue;
    }
    if (seen.has(line.account)) problems.push(`${name}: listed twice`);
    seen.add(line.account);
    if (a.type !== 'asset' && a.type !== 'liability') {
      problems.push(`${name}: only asset and liability accounts have opening balances`);
      continue;
    }
    if (a.closed_at !== undefined) problems.push(`${name}: account is closed`);

    if ('balance' in line) {
      if (line.balance.amount === 0n) continue;
      const amount = a.type === 'liability' ? -line.balance.amount : line.balance.amount;
      splits.push({ account: line.account, amount, exp: line.balance.exp, cur: a.cur });
      continue;
    }

    if (a.type !== 'asset') problems.push(`${name}: only asset accounts hold lots`);
    line.lots.forEach((lot, i) => {
      const at = `${name} lot ${i + 1}`;
      if (lot.qty.amount <= 0n) problems.push(`${at}: quantity must be positive`);
      if (lot.cost.amount < 0n) problems.push(`${at}: cost must not be negative`);
      if (lot.cost.cur === a.cur) problems.push(`${at}: cost must be in another commodity`);
      if (lot.acquired > date) problems.push(`${at}: acquired after the opening date`);
      if (lot.qty.amount <= 0n) return;
      splits.push({
        account: line.account,
        amount: lot.qty.amount,
        exp: lot.qty.exp,
        cur: a.cur,
        cost: lot.cost,
        acquired: lot.acquired,
      });
    });
  }
  return splits;
}

/**
 * The commodities whose positions don't net to zero, so need an equity account. An asset
 * and a liability of equal balance in one commodity need none.
 */
export function openingCommodities(date: IsoDate, lines: readonly OpeningLine[], chart: Chart): Commodity[] {
  const sums = sumByCommodity(positionSplits(date, lines, chart, []));
  return [...sums.values()].filter((s) => s.amount !== 0n).map((s) => s.cur);
}

/**
 * Builds the opening entry, or returns why it can't. Splits come in the order of
 * `lines`, then one equity split per commodity that doesn't already net to zero.
 */
export function openingEntry(input: OpeningInput, chart: Chart): OpeningResult {
  const problems: string[] = [];
  const splits = positionSplits(input.date, input.lines, chart, problems);

  for (const [cur, sum] of sumByCommodity([...splits])) {
    if (sum.amount === 0n) continue;
    const equity = input.equity.get(cur);
    if (equity === undefined) {
      problems.push(`no equity account for ${cur}`);
      continue;
    }
    if (!isOpeningEquity(chart.get(equity), cur)) {
      problems.push(`the equity account for ${cur} must be an open ${cur} equity account`);
      continue;
    }
    const offset = neg(sum);
    splits.push({ account: equity, amount: offset.amount, exp: offset.exp, cur });
  }

  if (splits.length === 0) problems.push('every balance is zero');
  if (problems.length > 0) return { problems };

  const entry: Entry = {
    v: 1,
    date: input.date,
    splits,
    memo: input.memo?.trim() || OPENING_EQUITY_NAME,
  };
  // The construction above should already guarantee these; check anyway.
  const invalid = entryProblems(entry, chart);
  return invalid.length > 0 ? { problems: invalid } : { entry };
}
