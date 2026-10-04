/**
 * Reversals: cancelling a posted entry by posting its inverse (0014). Rules: "ledger.reversal"
 * in design/SCHEMAS.md.
 *
 * A reversal is built from its target's **effective** accounts, after edits, so it cancels
 * what the books actually show. Its splits copy the target's exponents (design/AMOUNTS.md),
 * and leave out lots and import labels: the target's lots are voided by the fold, and a
 * reversal consumes no import rows.
 */

import { eq, neg } from './amount.js';
import type { Chart } from './chart.js';
import { yearOf, type AccountId, type IsoDate, type MsgId } from './ids.js';
import type { Reversal, ReversalSplit, Split } from './messages.js';
import { reversalProblems } from './validate.js';

/** What a client needs to know about an entry to reverse it. */
export interface ReversalTarget {
  readonly id: MsgId;
  readonly date: IsoDate;
  readonly splits: readonly Split[];
  /** Effective account of each split, after edits. */
  readonly accounts: readonly AccountId[];
  /** Some period close cites a head at or after the entry in its segment. */
  readonly locked: boolean;
  /** The entry's segment has not been frozen by a final close. */
  readonly segmentOpen: boolean;
  /** The first reversal of the entry in any segment, if it has been reversed. */
  readonly reversedBy?: MsgId;
}

/**
 * The date a reversal defaults to: the target's own, so the pair lands in the same segment
 * and period and the register nets it to nothing, unless the target is locked or its
 * segment is frozen. Then `today`, like an accountant's reversing entry in the open period.
 */
export function defaultReversalDate(target: ReversalTarget, today: IsoDate): IsoDate {
  return !target.locked && target.segmentOpen ? target.date : today;
}

/** The inverse of the target's splits, in the same order, with the effective accounts. */
export function inverseSplits(target: Pick<ReversalTarget, 'splits' | 'accounts'>): ReversalSplit[] {
  return target.splits.map((s, i) => ({ account: target.accounts[i], amount: -s.amount, exp: s.exp, cur: s.cur }));
}

/** Whether `splits` are exactly the inverse of the target's effective splits. Amounts compare by value. */
export function isInverse(target: Pick<ReversalTarget, 'splits' | 'accounts'>, splits: readonly ReversalSplit[]): boolean {
  const ts = target.splits;
  return ts.length === splits.length && splits.every((s, i) => s.account === target.accounts[i] && eq(s, neg(ts[i])));
}

export function reversalOf(target: ReversalTarget, opts: { date: IsoDate; memo?: string }): Reversal {
  const memo = opts.memo?.trim();
  return { v: 1, date: opts.date, reverses: target.id, splits: inverseSplits(target), ...(memo ? { memo } : {}) };
}

export interface ReversalPostContext {
  readonly chart: Chart;
  /** The entry `reverses` names, or undefined if the client holds no such entry. */
  readonly target: ReversalTarget | undefined;
  /** Whether the segment for the reversal's date is open (not frozen). */
  readonly segmentOpen: boolean;
}

/** Everything checked before posting a reversal: the fold-time rules plus post-time ones. */
export function reversalPostProblems(rev: Reversal, ctx: ReversalPostContext): string[] {
  const problems = reversalProblems(rev, ctx.chart, yearOf(rev.date));
  const { target } = ctx;
  if (!target || target.id !== rev.reverses) problems.push('the reversed message is not a known entry');
  else {
    if (target.reversedBy !== undefined) problems.push(`the entry was already reversed by ${target.reversedBy}`);
    if (!isInverse(target, rev.splits)) problems.push('splits are not the inverse of the entry');
  }
  if (!ctx.segmentOpen) problems.push(`journal-${yearOf(rev.date)} is frozen`);
  return problems;
}
