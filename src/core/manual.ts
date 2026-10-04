/**
 * Manual entry: a `ledger.entry` typed in by hand, with any number of splits (0010).
 *
 * Each line is an account and a signed amount, positive for a debit. Like a ledger-cli
 * posting, one line per commodity may leave its amount blank, and it takes whatever
 * balances that commodity. Every split is in its account's commodity, so an entry across
 * commodities balances each one separately, for example through trading accounts.
 *
 * Lots are not created or drawn here; investments come later (0027).
 */

import { canonical, neg, sumByCommodity, type Amount, type Commodity, type Decimal } from './amount.js';
import { accountLabel, type Chart } from './chart.js';
import type { AccountId, IsoDate } from './ids.js';
import type { Account, Entry, Split } from './messages.js';
import { entryProblems } from './validate.js';

export interface ManualLine {
  readonly account: AccountId;
  /** Positive is a debit. `undefined` takes the remainder of the account's commodity. */
  readonly amount?: Decimal;
}

export interface ManualInput {
  readonly date: IsoDate;
  readonly lines: readonly ManualLine[];
  readonly memo?: string;
}

export type ManualResult =
  | { readonly entry: Entry; readonly problems?: undefined }
  | { readonly entry?: undefined; readonly problems: readonly string[] };

/**
 * Whether a manual entry may post to `a`. Closed accounts take no new splits, and an
 * envelope's balance comes from allocations on the `budget` topic, never the journal.
 */
export function isPostable(a: Account | undefined): boolean {
  return a !== undefined && a.closed_at === undefined && !a.envelope;
}

/**
 * What each commodity is out of balance by, counting only lines with an amount on a known
 * account. Positive means the debits exceed the credits. Balanced commodities are left out.
 */
export function imbalances(lines: readonly ManualLine[], chart: Chart): Amount[] {
  const amounts: Amount[] = [];
  for (const l of lines) {
    const cur = chart.get(l.account)?.cur;
    if (cur !== undefined && l.amount !== undefined) amounts.push({ ...l.amount, cur });
  }
  return [...sumByCommodity(amounts).values()].filter((s) => s.amount !== 0n);
}

/** "USD debits exceed credits by 12.34", for a commodity's imbalance. */
export function describeImbalance(a: Amount): string {
  const [more, less] = a.amount > 0n ? ['debits', 'credits'] : ['credits', 'debits'];
  return `${a.cur} ${more} exceed ${less} by ${canonical(a.amount > 0n ? a : neg(a))}`;
}

/**
 * Builds the entry, or returns why it can't. Splits keep the order of `lines`, with each
 * blank amount filled in.
 */
export function manualEntry(input: ManualInput, chart: Chart): ManualResult {
  const problems: string[] = [];
  const blanks = new Map<Commodity, number>();

  input.lines.forEach((l, i) => {
    const a = chart.get(l.account);
    const at = a ? `line ${i + 1} ("${accountLabel(chart, l.account)}")` : `line ${i + 1}`;
    if (!a) problems.push(`${at}: unknown account`);
    else if (a.envelope) problems.push(`${at}: envelopes are funded by allocations, not entries`);
    else if (a.closed_at !== undefined) problems.push(`${at}: account is closed`);
    if (l.amount?.amount === 0n) problems.push(`${at}: amount must not be zero`);
    if (a && l.amount === undefined) {
      if (blanks.has(a.cur)) problems.push(`${at}: only one ${a.cur} line may leave its amount blank`);
      else blanks.set(a.cur, i);
    }
  });
  if (input.lines.length < 2) problems.push('an entry needs at least two lines');
  if (problems.length > 0) return { problems };

  const off = new Map(imbalances(input.lines, chart).map((s) => [s.cur, s]));
  for (const [cur, i] of blanks) {
    if (!off.has(cur)) problems.push(`line ${i + 1}: ${cur} already balances, so there is nothing to fill in`);
  }
  for (const s of off.values()) if (!blanks.has(s.cur)) problems.push(describeImbalance(s));
  if (problems.length > 0) return { problems };

  const splits: Split[] = input.lines.map((l) => {
    const cur = chart.get(l.account)!.cur;
    const amount = l.amount ?? neg(off.get(cur)!);
    return { account: l.account, amount: amount.amount, exp: amount.exp, cur };
  });

  const entry: Entry = { v: 1, date: input.date, splits, ...(input.memo?.trim() ? { memo: input.memo.trim() } : {}) };
  // The construction above should already guarantee these; check anyway.
  const invalid = entryProblems(entry, chart);
  return invalid.length > 0 ? { problems: invalid } : { entry };
}
