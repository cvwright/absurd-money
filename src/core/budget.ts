/**
 * The budget document (`ledger/budget` in design/SCHEMAS.md): the envelopes, which expense
 * account is spent from which envelope, and which accounts are budgetable. Its references
 * into the chart, and the rules for rewriting it.
 *
 * The chart is a separate document, but accounts are never removed and their `type` and
 * `cur` never change, so a reference that was valid when written stays valid.
 */

import type { Amount } from './amount.js';
import type { Chart } from './chart.js';
import type { AccountId, EnvelopeId, IsoDate } from './ids.js';
import type { BudgetDoc, Envelope, Reallocation } from './messages.js';

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

/**
 * "Budget this" (0050): `doc` with expense account `account` spent from an envelope of its
 * own, named and denominated as the account is. That is an open envelope of the same name
 * and `cur` that nothing is spent from, if there is one (the first by ID), and otherwise a
 * new envelope `fresh`. `doc` itself if the account's pairing already counts. Throws if
 * `account` is not an expense account.
 */
export function withOwnEnvelope(doc: BudgetDoc, chart: Chart, account: AccountId, fresh: EnvelopeId): BudgetDoc {
  const a = chart.get(account);
  if (!a || a.type !== 'expense') throw new Error('Only an expense account can be budgeted.');
  if (pairings(doc, chart).has(account)) return doc;
  const reuse = (Object.entries(doc.envelopes) as [EnvelopeId, Envelope][])
    .filter(([id, e]) => e.name === a.name && e.cur === a.cur && e.closed_at === undefined && pairedTo(doc, id).length === 0)
    .map(([id]) => id)
    .sort()[0];
  if (reuse) return withPairing(doc, account, reuse);
  if (envelopeOf(doc, fresh)) throw new Error(`Envelope ${fresh} already exists.`);
  return withPairing({ ...doc, envelopes: { ...doc.envelopes, [fresh]: { name: a.name, cur: a.cur } } }, account, fresh);
}

/**
 * Unchecking "Budget this": `doc` with `account` spent from no envelope. If `closeOn` is
 * given, the envelope it was spent from is also closed that day, unless something else is
 * still spent from it or it is already closed. `doc` itself if the account is unpaired.
 */
export function withoutEnvelope(doc: BudgetDoc, account: AccountId, closeOn?: IsoDate): BudgetDoc {
  if (!Object.hasOwn(doc.spent_from, account)) return doc;
  const env = doc.spent_from[account];
  const unpaired = withPairing(doc, account, null);
  const e = envelopeOf(unpaired, env);
  if (closeOn === undefined || !e || e.closed_at !== undefined || pairedTo(unpaired, env).length > 0) return unpaired;
  return withEnvelope(unpaired, env, (x) => ({ ...x, closed_at: closeOn }));
}

/**
 * The one expense account `env` funds, if it funds exactly one and that account has the
 * envelope's name, so the two can show as one. Only pairings that count are considered.
 */
export function soleAccount(doc: BudgetDoc, chart: Chart, env: EnvelopeId): AccountId | undefined {
  const e = envelopeOf(doc, env);
  if (!e) return undefined;
  const funded = [...pairings(doc, chart)].filter(([, x]) => x === env).map(([a]) => a);
  return funded.length === 1 && chart.get(funded[0])?.name === e.name ? funded[0] : undefined;
}

/** `doc` with envelope `id` changed by `f`. Throws if there is no such envelope. */
export function withEnvelope(doc: BudgetDoc, id: EnvelopeId, f: (e: Envelope) => Envelope): BudgetDoc {
  const e = envelopeOf(doc, id);
  if (!e) throw new Error('That envelope is no longer in the budget.');
  return { ...doc, envelopes: { ...doc.envelopes, [id]: f(e) } };
}

/** `doc` with `account` counted toward To Be Budgeted if `on`, and not if not. */
export function withBudgetable(doc: BudgetDoc, account: AccountId, on: boolean): BudgetDoc {
  const rest = doc.budgetable.filter((id) => id !== account);
  return { ...doc, budgetable: on ? [...rest, account] : rest };
}

/**
 * A reallocation moving `amount` from envelope `from` to envelope `to`, in `amount`'s
 * commodity. `amount` must be positive and the envelopes distinct.
 */
export function moveBetween(
  from: EnvelopeId,
  to: EnvelopeId,
  amount: Amount,
  date: IsoDate,
  memo?: string,
): Reallocation {
  if (from === to) throw new Error('Choose a different envelope to move to.');
  if (amount.amount <= 0n) throw new Error('Move an amount greater than zero.');
  const { exp, cur } = amount;
  return {
    v: 1, date, cur,
    legs: [{ envelope: from, amount: -amount.amount, exp }, { envelope: to, amount: amount.amount, exp }],
    ...(memo && { memo }),
  };
}
