/**
 * The `budget` topic fold and the envelope figures derived from it. See "Envelope
 * budgeting" in design/ACCOUNTING.md, and `ledger.allocation`, `ledger.reallocation`, and
 * `ledger/budget` in design/SCHEMAS.md.
 */

import { add, sub, type Amount, type Commodity } from '../amount.js';
import { budgetableAccounts, pairings } from '../budget.js';
import type { Chart } from '../chart.js';
import { CodecError } from '../errors.js';
import type { EnvelopeId, Label, MsgId } from '../ids.js';
import {
  decodeMessage, UnknownTypeError, UnknownVersionError, type Allocation, type BudgetDoc, type Envelope,
  type Reallocation,
} from '../messages.js';
import { allocationProblems, reallocationProblems } from '../validate.js';
import { balanceOf, type Balances } from './ledger.js';
import type { Anomaly, RawMessage } from './segment.js';

export interface BudgetFold {
  /** The allocations that count, in chain order. */
  readonly allocations: readonly { readonly id: MsgId; readonly msg: Allocation }[];
  /** The reallocations that count, in chain order. */
  readonly reallocations: readonly { readonly id: MsgId; readonly msg: Reallocation }[];
  /** Σ allocations and reallocation legs per envelope. */
  readonly allocated: ReadonlyMap<EnvelopeId, Amount>;
  readonly anomalies: readonly Anomaly[];
  readonly halted?: { readonly at: MsgId; readonly error: UnknownTypeError | UnknownVersionError };
}

type BudgetMessage =
  | { readonly type: 'ledger.allocation'; readonly msg: Allocation }
  | { readonly type: 'ledger.reallocation'; readonly msg: Reallocation };

function decodeBudgetMessage(type: string, data: unknown): BudgetMessage {
  if (type === 'ledger.allocation') return { type, msg: decodeMessage(type, data) };
  if (type === 'ledger.reallocation') return { type, msg: decodeMessage(type, data) };
  throw new UnknownTypeError(type);
}

/**
 * Folds the `budget` chain. If two allocations carry the same `idem`, only the first that
 * counts is kept; the others are duplicates from a materialization race and are ignored
 * silently. A reallocation that breaks a fold-time rule is ignored whole; otherwise each
 * leg adds to its envelope as an allocation would.
 */
export function foldBudget(messages: readonly RawMessage[], budget: BudgetDoc): BudgetFold {
  const allocations: { id: MsgId; msg: Allocation }[] = [];
  const reallocations: { id: MsgId; msg: Reallocation }[] = [];
  const allocated = new Map<EnvelopeId, Amount>();
  const anomalies: Anomaly[] = [];
  const idems = new Set<Label>();
  let halted: BudgetFold['halted'];

  const allocate = (env: EnvelopeId, a: Amount) => {
    const prev = allocated.get(env);
    allocated.set(env, prev ? add(prev, a) : { amount: a.amount, exp: a.exp, cur: a.cur });
  };

  for (const { id, type, data } of messages) {
    let m: BudgetMessage;
    try {
      m = decodeBudgetMessage(type, data);
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
    const problems =
      m.type === 'ledger.allocation' ? allocationProblems(m.msg, budget) : reallocationProblems(m.msg, budget);
    if (problems.length > 0) {
      anomalies.push({ kind: 'invalid', msg: id, detail: problems.join('; ') });
      continue;
    }
    if (m.type === 'ledger.reallocation') {
      reallocations.push({ id, msg: m.msg });
      for (const leg of m.msg.legs) allocate(leg.envelope, { ...leg, cur: m.msg.cur });
      continue;
    }
    const msg = m.msg;
    if (msg.idem !== undefined) {
      if (idems.has(msg.idem)) continue;
      idems.add(msg.idem);
    }
    allocations.push({ id, msg });
    allocate(msg.envelope, msg);
  }
  return { allocations, reallocations, allocated, anomalies, halted };
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
