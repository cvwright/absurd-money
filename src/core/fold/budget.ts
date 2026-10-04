/**
 * The `budget` topic fold and the envelope figures derived from it. See "Envelope
 * budgeting" in design/ACCOUNTING.md and `ledger.allocation` in design/SCHEMAS.md.
 */

import { add, sub, type Amount, type Commodity } from '../amount.js';
import type { Chart } from '../chart.js';
import { CodecError } from '../errors.js';
import type { AccountId, Label, MsgId } from '../ids.js';
import { decodeMessage, UnknownTypeError, UnknownVersionError, type Allocation } from '../messages.js';
import { allocationProblems } from '../validate.js';
import { balanceOf, type Balances } from './ledger.js';
import type { Anomaly, RawMessage } from './segment.js';

export interface BudgetFold {
  /** The allocations that count, in chain order. */
  readonly allocations: readonly { readonly id: MsgId; readonly msg: Allocation }[];
  /** Σ allocations per envelope. */
  readonly allocated: ReadonlyMap<AccountId, Amount>;
  readonly anomalies: readonly Anomaly[];
  readonly halted?: { readonly at: MsgId; readonly error: UnknownTypeError | UnknownVersionError };
}

/**
 * Folds the `budget` chain. If two allocations carry the same `idem`, only the first that
 * counts is kept; the others are duplicates from a materialization race and are ignored
 * silently.
 */
export function foldBudget(messages: readonly RawMessage[], chart: Chart): BudgetFold {
  const allocations: { id: MsgId; msg: Allocation }[] = [];
  const allocated = new Map<AccountId, Amount>();
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
    const problems = allocationProblems(msg, chart);
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
 * `available(e) = Σ allocations to e − Σ spend in the expense accounts paired with e`,
 * unclamped, so rollover is what you get by default.
 */
export function envelopeAvailable(
  chart: Chart,
  allocated: ReadonlyMap<AccountId, Amount>,
  balances: Balances,
): Map<AccountId, Amount> {
  const out = new Map<AccountId, Amount>();
  for (const [id, a] of chart) {
    if (a.type === 'equity' && a.envelope) {
      out.set(id, allocated.get(id) ?? { amount: 0n, exp: 0, cur: a.cur });
    }
  }
  for (const [id, a] of chart) {
    if (a.type !== 'expense' || a.envelope_account === undefined) continue;
    const env = out.get(a.envelope_account);
    if (!env || env.cur !== a.cur) continue;
    out.set(a.envelope_account, sub(env, balanceOf(balances, id, a.cur)));
  }
  return out;
}

/**
 * `To Be Budgeted = Σ budgetable asset and liability balances − Σ envelope available`, per
 * commodity.
 */
export function toBeBudgeted(
  chart: Chart,
  balances: Balances,
  available: ReadonlyMap<AccountId, Amount>,
): Map<Commodity, Amount> {
  const out = new Map<Commodity, Amount>();
  const plus = (a: Amount) => {
    const prev = out.get(a.cur);
    out.set(a.cur, prev ? add(prev, a) : a);
  };
  for (const [id, a] of chart) {
    if (a.budgetable && (a.type === 'asset' || a.type === 'liability')) plus(balanceOf(balances, id, a.cur));
  }
  for (const env of available.values()) plus({ ...env, amount: -env.amount });
  return out;
}
