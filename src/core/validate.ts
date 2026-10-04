/**
 * Fold-time and post-time rules from design/SCHEMAS.md that need the chart.
 *
 * Fold-time rules depend only on the message and on chart facts that never change (an
 * account's existence, `type`, and `cur`), so every client reaches the same verdict. A
 * message that breaks one is ignored by the fold and surfaced. Each function returns the
 * problems found; empty means valid.
 */

import { sumsToZero } from './amount.js';
import { envelopeOf } from './budget.js';
import type { Chart } from './chart.js';
import { yearOf, type Label, type MsgId } from './ids.js';
import type {
  Allocation, BudgetDoc, Entry, LotAdjust, PayeesDoc, Reversal, ReversalSplit,
} from './messages.js';

function routingProblem(date: string, year: number | undefined): string[] {
  return year !== undefined && Number(date.slice(0, 4)) !== year
    ? [`dated ${date}, outside journal-${year}`]
    : [];
}

function splitAccountProblems(splits: readonly ReversalSplit[], chart: Chart): string[] {
  const problems: string[] = [];
  splits.forEach((s, i) => {
    const a = chart.get(s.account);
    if (!a) problems.push(`split ${i}: unknown account`);
    else if (a.cur !== s.cur) problems.push(`split ${i}: ${s.cur} on a ${a.cur} account`);
  });
  if (!sumsToZero(splits)) problems.push('splits do not sum to zero per commodity');
  return problems;
}

/** Fold-time rules for `ledger.entry`. `year` is the segment's, for the routing rule. */
export function entryProblems(entry: Entry, chart: Chart, year?: number): string[] {
  const problems = [...routingProblem(entry.date, year), ...splitAccountProblems(entry.splits, chart)];
  const labels = new Set<Label>();
  entry.splits.forEach((s, i) => {
    const asset = chart.get(s.account)?.type === 'asset';
    if ((s.cost === undefined) !== (s.acquired === undefined)) {
      problems.push(`split ${i}: cost and acquired appear together`);
    }
    if (s.cost !== undefined && !(asset && s.amount > 0n)) {
      problems.push(`split ${i}: cost only on a positive split to an asset account`);
    }
    if (s.from_lots !== undefined) {
      if (!(asset && s.amount < 0n)) {
        problems.push(`split ${i}: from_lots only on a negative split to an asset account`);
      }
      if (s.cost !== undefined) problems.push(`split ${i}: both cost and from_lots`);
      // Each draw's qty is in the split's own exp and cur, so the integers compare directly.
      const drawn = s.from_lots.reduce((sum, d) => sum + d.qty, 0n);
      if (drawn !== -s.amount) problems.push(`split ${i}: from_lots qty does not sum to the quantity drawn`);
    }
    if (s.import_id !== undefined) {
      if (labels.has(s.import_id)) problems.push(`split ${i}: duplicate import_id`);
      labels.add(s.import_id);
    }
  });
  return problems;
}

/** Fold-time rules for `ledger.reversal`. The inverse check is an anomaly, not a rule. */
export function reversalProblems(rev: Reversal, chart: Chart, year?: number): string[] {
  return [...routingProblem(rev.date, year), ...splitAccountProblems(rev.splits, chart)];
}

/** Fold-time rules for `ledger.lotadjust`. Lot mismatches are lot anomalies, not rules. */
export function lotAdjustProblems(msg: LotAdjust, chart: Chart, year?: number): string[] {
  const problems = routingProblem(msg.date, year);
  msg.adjustments.forEach((adj, i) => {
    const a = chart.get(adj.account);
    if (!a) problems.push(`adjustment ${i}: unknown account`);
    else if (a.cur !== adj.cur) problems.push(`adjustment ${i}: ${adj.cur} on a ${a.cur} account`);
  });
  return problems;
}

/**
 * Fold-time rules for `ledger.allocation`. Envelopes are never removed and their `cur`
 * never changes, so once the envelope exists the verdict never changes.
 */
export function allocationProblems(msg: Allocation, budget: BudgetDoc): string[] {
  const e = envelopeOf(budget, msg.envelope);
  if (!e) return ['unknown envelope'];
  if (e.cur !== msg.cur) return [`${msg.cur} allocated to a ${e.cur} envelope`];
  return [];
}

export interface EntryPostContext {
  readonly chart: Chart;
  readonly payees?: PayeesDoc;
  /** Whether an import label is already consumed. */
  readonly isConsumed?: (label: Label) => boolean;
  /** Whether the segment for this date is open (not frozen). */
  readonly segmentOpen: boolean;
  /**
   * For an entry with `replaces`: the entry it names, if the client holds it, with its
   * first reversal and first replacement.
   */
  readonly replaced?: { readonly id: MsgId; readonly reversedBy?: MsgId; readonly replacedBy?: MsgId };
}

/** Everything checked before posting an entry: the fold-time rules plus post-time ones. */
export function entryPostProblems(entry: Entry, ctx: EntryPostContext): string[] {
  const problems = entryProblems(entry, ctx.chart, yearOf(entry.date));
  entry.splits.forEach((s, i) => {
    if (ctx.chart.get(s.account)?.closed_at !== undefined) problems.push(`split ${i}: account is closed`);
    if (s.import_id !== undefined && ctx.isConsumed?.(s.import_id)) {
      problems.push(`split ${i}: import row already consumed`);
    }
  });
  if (entry.payee !== undefined && ctx.payees && !Object.hasOwn(ctx.payees.payees, entry.payee)) {
    problems.push('unknown payee');
  }
  if (entry.replaces !== undefined) {
    const r = ctx.replaced;
    if (!r || r.id !== entry.replaces) problems.push('the replaced message is not a known entry');
    else {
      if (r.reversedBy === undefined) problems.push('the replaced entry has not been reversed');
      if (r.replacedBy !== undefined) problems.push(`the replaced entry was already replaced by ${r.replacedBy}`);
    }
  }
  if (!ctx.segmentOpen) problems.push(`journal-${yearOf(entry.date)} is frozen`);
  return problems;
}
