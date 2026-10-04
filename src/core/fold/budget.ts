/**
 * The `budget` topic fold and the envelope figures derived from it. See "Envelope
 * budgeting" in design/ACCOUNTING.md, and `ledger.allocation` and `ledger/budget` in
 * design/SCHEMAS.md.
 */

import { add, sub, type Amount, type Commodity } from '../amount.js';
import { budgetableAccounts, pairings } from '../budget.js';
import type { Chart } from '../chart.js';
import { CodecError } from '../errors.js';
import type { EnvelopeId, Label, MsgId } from '../ids.js';
import {
  decodeMessage, UnknownTypeError, UnknownVersionError, type Allocation, type BudgetDoc, type Envelope,
} from '../messages.js';
import { allocationProblems } from '../validate.js';
import { balanceOf, type Balances } from './ledger.js';
import type { Anomaly, RawMessage } from './segment.js';

export interface BudgetFold {
  /** The allocations that count, in chain order. */
  readonly allocations: readonly { readonly id: MsgId; readonly msg: Allocation }[];
  /** Σ allocations per envelope. */
  readonly allocated: ReadonlyMap<EnvelopeId, Amount>;
  readonly anomalies: readonly Anomaly[];
  readonly halted?: { readonly at: MsgId; readonly error: UnknownTypeError | UnknownVersionError };
}

/**
 * Folds the `budget` chain. If two allocations carry the same `idem`, only the first that
 * counts is kept; the others are duplicates from a materialization race and are ignored
 * silently.
 */
export function foldBudget(messages: readonly RawMessage[], budget: BudgetDoc): BudgetFold {
  const allocations: { id: MsgId; msg: Allocation }[] = [];
  const allocated = new Map<EnvelopeId, Amount>();
  const anomalies: Anomaly[] = [];
  const idems = new Set<Label>();
  let halted: BudgetFold['halted'];

  for (const { id, type, data } of messages) {
    let msg: Allocation;
    try {
      if (type !== 'ledger.allocation') throw new UnknownTypeError(type);
      msg = decodeMessage('ledger.allocation', data);
    } catch (e) {
      if (e instanceof UnknownTypeError || e instanceof UnknownVersionError) {
        halted = { at: id, error: e };
        break;
      }
      if (e instanceof CodecError) {
        anomalies.push({ kind: 'malformed', msg: id, detail: e.message });
        continue;
      }
      throw e;
    }
    const problems = allocationProblems(msg, budget);
    if (problems.length > 0) {
      anomalies.push({ kind: 'invalid', msg: id, detail: problems.join('; ') });
      continue;
    }
    if (msg.idem !== undefined) {
      if (idems.has(msg.idem)) continue;
      idems.add(msg.idem);
    }
    allocations.push({ id, msg });
    const prev = allocated.get(msg.envelope);
    allocated.set(msg.envelope, prev ? add(prev, msg) : { amount: msg.amount, exp: msg.exp, cur: msg.cur });
  }
  return { allocations, allocated, anomalies, halted };
}

/**
 * `available(e) = Σ allocations to e − Σ spend in the expense accounts spent from e`,
 * unclamped, so rollover is what you get by default. Pairings that don't count (see
 * `budgetRefProblems`) are ignored.
 */
export function envelopeAvailable(
  budget: BudgetDoc,
  chart: Chart,
  allocated: ReadonlyMap<EnvelopeId, Amount>,
  balances: Balances,
): Map<EnvelopeId, Amount> {
  const out = new Map<EnvelopeId, Amount>();
  for (const [id, e] of Object.entries(budget.envelopes) as [EnvelopeId, Envelope][]) {
    out.set(id, allocated.get(id) ?? { amount: 0n, exp: 0, cur: e.cur });
  }
  for (const [account, env] of pairings(budget, chart)) {
    const avail = out.get(env)!;
    out.set(env, sub(avail, balanceOf(balances, account, avail.cur)));
  }
  return out;
}

/**
 * `To Be Budgeted = Σ budgetable asset and liability balances − Σ envelope available`, per
 * commodity.
 */
export function toBeBudgeted(
  budget: BudgetDoc,
  chart: Chart,
  balances: Balances,
  available: ReadonlyMap<EnvelopeId, Amount>,
): Map<Commodity, Amount> {
  const out = new Map<Commodity, Amount>();
  const plus = (a: Amount) => {
    const prev = out.get(a.cur);
    out.set(a.cur, prev ? add(prev, a) : a);
  };
  for (const id of budgetableAccounts(budget, chart)) plus(balanceOf(balances, id, chart.get(id)!.cur));
  for (const env of available.values()) plus({ ...env, amount: -env.amount });
  return out;
}
