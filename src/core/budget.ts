/**
 * The budget document (`ledger/budget` in design/SCHEMAS.md): the envelopes, which expense
 * account is spent from which envelope, and which accounts are budgetable. Its references
 * into the chart, and the rules for rewriting it.
 *
 * The chart is a separate document, but accounts are never removed and their `type` and
 * `cur` never change, so a reference that was valid when written stays valid.
 */

import type { Chart } from './chart.js';
import type { AccountId, EnvelopeId } from './ids.js';
import type { BudgetDoc, Envelope } from './messages.js';

/**
 * The budget before its first write. Its `rev` is 0, so the first write is rev 1. It is
 * never written itself.
 */
export const EMPTY_BUDGET: BudgetDoc = { v: 1, rev: 0, envelopes: {}, spent_from: {}, budgetable: [] };

export function envelopeOf(doc: BudgetDoc, id: EnvelopeId): Envelope | undefined {
  return Object.hasOwn(doc.envelopes, id) ? doc.envelopes[id] : undefined;
}

/** Why a `spent_from` pairing doesn't count, or `undefined` if it does. */
function pairingProblem(doc: BudgetDoc, chart: Chart, account: AccountId, env: EnvelopeId): string | undefined {
  const a = chart.get(account);
  const e = envelopeOf(doc, env);
  if (!a || a.type !== 'expense') return `spent_from ${account}: not an expense account`;
  if (!e) return `spent_from ${account}: unknown envelope ${env}`;
  if (e.cur !== a.cur) return `spent_from ${account}: ${a.cur} spent from a ${e.cur} envelope`;
  return undefined;
}

function budgetableProblem(chart: Chart, account: AccountId): string | undefined {
  const t = chart.get(account)?.type;
  return t === 'asset' || t === 'liability' ? undefined : `budgetable ${account}: not an asset or liability account`;
}

/** The `spent_from` pairings that count. Each expense account has at most one envelope. */
export function pairings(doc: BudgetDoc, chart: Chart): Map<AccountId, EnvelopeId> {
  const out = new Map<AccountId, EnvelopeId>();
  for (const [account, env] of Object.entries(doc.spent_from) as [AccountId, EnvelopeId][]) {
    if (pairingProblem(doc, chart, account, env) === undefined) out.set(account, env);
  }
  return out;
}

/** The budgetable accounts that count. */
export function budgetableAccounts(doc: BudgetDoc, chart: Chart): AccountId[] {
  return doc.budgetable.filter((id) => budgetableProblem(chart, id) === undefined);
}

/**
 * Fold-time: the references that don't count, to surface. The fold ignores each one,
 * never the whole document.
 */
export function budgetRefProblems(doc: BudgetDoc, chart: Chart): string[] {
  const problems: string[] = [];
  for (const [account, env] of Object.entries(doc.spent_from) as [AccountId, EnvelopeId][]) {
    const p = pairingProblem(doc, chart, account, env);
    if (p) problems.push(p);
  }
  for (const id of doc.budgetable) {
    const p = budgetableProblem(chart, id);
    if (p) problems.push(p);
  }
  return problems;
}

/**
 * Post-time rules for replacing `prev` with `next`, against the current chart: every
 * reference counts, no pairing names a closed envelope, `rev` goes up by one, and no
 * envelope is removed or changes `cur`.
 */
export function budgetUpdateProblems(prev: BudgetDoc, next: BudgetDoc, chart: Chart): string[] {
  const problems = budgetRefProblems(next, chart);
  for (const [account, env] of Object.entries(next.spent_from) as [AccountId, EnvelopeId][]) {
    if (envelopeOf(next, env)?.closed_at !== undefined) problems.push(`spent_from ${account}: envelope ${env} is closed`);
  }
  if (next.rev !== prev.rev + 1) problems.push(`rev must be ${prev.rev + 1}`);
  for (const [id, e] of Object.entries(prev.envelopes) as [EnvelopeId, Envelope][]) {
    const after = envelopeOf(next, id);
    if (!after) problems.push(`${id}: envelopes are never removed`);
    else if (after.cur !== e.cur) problems.push(`${id}: cur is immutable`);
  }
  return problems;
}

/** The expense accounts `doc` says are spent from `env`, whether or not each pairing counts. */
export function pairedTo(doc: BudgetDoc, env: EnvelopeId): AccountId[] {
  return (Object.entries(doc.spent_from) as [AccountId, EnvelopeId][]).filter(([, e]) => e === env).map(([a]) => a);
}

/**
 * `doc` with `account` spent from `env`, or from no envelope if `env` is null. Pairing is
 * timeless: the account's spending, past and future, moves to the new envelope.
 */
export function withPairing(doc: BudgetDoc, account: AccountId, env: EnvelopeId | null): BudgetDoc {
  const { [account]: _, ...rest } = doc.spent_from;
  return { ...doc, spent_from: env === null ? rest : { ...rest, [account]: env } };
}

/** `doc` with envelope `id` changed by `f`. Throws if there is no such envelope. */
export function withEnvelope(doc: BudgetDoc, id: EnvelopeId, f: (e: Envelope) => Envelope): BudgetDoc {
  const e = envelopeOf(doc, id);
  if (!e) throw new Error('That envelope is no longer in the budget.');
  return { ...doc, envelopes: { ...doc.envelopes, [id]: f(e) } };
}
