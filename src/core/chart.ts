/**
 * The chart of accounts (`ledger/accounts` in design/SCHEMAS.md): lookup, the rules that
 * span accounts, and the rules for rewriting the document.
 */

import type { AccountId } from './ids.js';
import type { Account, AccountsDoc } from './messages.js';

export type Chart = ReadonlyMap<AccountId, Account>;

/**
 * The chart before its first write. Its `rev` is 0, so the first write is rev 1. It is
 * never written itself, and the decoder rejects it.
 */
export const EMPTY_CHART: AccountsDoc = { v: 1, rev: 0, accounts: {} };

export function chartOf(doc: AccountsDoc): Chart {
  return new Map(Object.entries(doc.accounts) as [AccountId, Account][]);
}

/** The cross-account rules for one revision of the chart. Empty means valid. */
export function chartProblems(doc: AccountsDoc): string[] {
  const chart = chartOf(doc);
  const problems: string[] = [];
  for (const [id, a] of chart) {
    if (a.parent !== null) {
      const parent = chart.get(a.parent);
      if (!parent) problems.push(`${id}: unknown parent`);
      else if (parent.type !== a.type) problems.push(`${id}: parent has a different type`);
    }
  }
  // Parent cycles. Each walk is bounded by the chart's size.
  for (const id of chart.keys()) {
    let cur = chart.get(id)?.parent ?? null;
    for (let steps = 0; cur !== null && steps <= chart.size; steps++) {
      if (cur === id) {
        problems.push(`${id}: parent cycle`);
        break;
      }
      cur = chart.get(cur)?.parent ?? null;
    }
  }
  return problems;
}

/**
 * Post-time rules for replacing `prev` with `next`: `rev` goes up by one, no account is
 * removed, and `type` and `cur` never change. Plus every rule in `chartProblems`.
 */
export function chartUpdateProblems(prev: AccountsDoc, next: AccountsDoc): string[] {
  const problems = chartProblems(next);
  if (next.rev !== prev.rev + 1) problems.push(`rev must be ${prev.rev + 1}`);
  const after = chartOf(next);
  for (const [id, a] of chartOf(prev)) {
    const b = after.get(id);
    if (!b) problems.push(`${id}: accounts are never removed`);
    else {
      if (b.type !== a.type) problems.push(`${id}: type is immutable`);
      if (b.cur !== a.cur) problems.push(`${id}: cur is immutable`);
    }
  }
  return problems;
}

/**
 * The names from the top-level ancestor down to the account, so accounts with the same
 * name under different parents can be told apart. Empty for an unknown account. A parent
 * cycle (which `chartProblems` rejects) stops the walk rather than looping.
 */
export function accountPath(chart: Chart, id: AccountId): string[] {
  const names: string[] = [];
  for (let cur: AccountId | null = id; cur !== null && names.length <= chart.size; ) {
    const a = chart.get(cur);
    if (!a) break;
    names.unshift(a.name);
    cur = a.parent;
  }
  return names;
}

/** `accountPath` joined for display, e.g. "Vanguard › VTI". */
export function accountLabel(chart: Chart, id: AccountId): string {
  return accountPath(chart, id).join(' › ');
}

export function isNominal(a: Account | undefined): boolean {
  return a !== undefined && (a.type === 'income' || a.type === 'expense');
}
