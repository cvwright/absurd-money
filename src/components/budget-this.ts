/**
 * The "Budget this" checkbox on an expense account (0050), shared by the chart of accounts
 * and the Budget page so both ask the same questions. Checking it gives the account an
 * envelope of its own (core's `withOwnEnvelope`). Unchecking it unpairs the account
 * (`withoutEnvelope`), and offers to close the envelope if that leaves it funding nothing
 * and holding nothing. Pairing is timeless, so either way the view first says how much
 * spending, past and future, moves.
 */

import { add, isZero, type Commodity } from '@/core/amount.js';
import { pairedTo, pairings, withoutEnvelope, withOwnEnvelope } from '@/core/budget.js';
import { accountLabel, type Chart } from '@/core/chart.js';
import { balanceOf } from '@/core/fold/ledger.js';
import { newEnvelopeId, type AccountId, type IsoDate } from '@/core/ids.js';
import type { BudgetDoc } from '@/core/messages.js';
import type { ProjectionClient } from '@/projection/client.js';
import type { LedgerSpace } from '@/services/ledger-space.js';
import { today } from './dates.js';
import { formatAmount } from './forms.js';

/** Whether the checkbox shows checked: the account is spent from some envelope. */
export function isBudgeted(budget: BudgetDoc, account: AccountId): boolean {
  return Object.hasOwn(budget.spent_from, account);
}

/**
 * Checks or unchecks "Budget this" on `account`, asking first where the view would. Returns
 * the budget written, or `null` if the person cancelled. `budget` is the caller's newest
 * copy, which the questions are about; the write applies to the latest in the space.
 */
export async function setBudgetThis(
  ledger: LedgerSpace,
  projection: ProjectionClient,
  chart: Chart,
  budget: BudgetDoc,
  account: AccountId,
  on: boolean,
): Promise<BudgetDoc | null> {
  const [balances, available] = await Promise.all([projection.call('balances'), projection.call('available')]);
  const label = accountLabel(chart, account);
  const spent = balanceOf(balances, account, chart.get(account)!.cur as Commodity);
  const spending = `${label} has ${formatAmount(spent)} ${spent.cur} of spending, including past months.`;

  if (on) {
    const name = chart.get(account)!.name;
    if (!isZero(spent) && !confirm(`${spending} All of it will count against its envelope, “${name}”. Continue?`)) {
      return null;
    }
    const fresh = newEnvelopeId(crypto.getRandomValues(new Uint8Array(15)));
    return ledger.updateBudget((doc) => withOwnEnvelope(doc, chart, account, fresh));
  }

  if (!isBudgeted(budget, account)) return budget;
  const env = budget.spent_from[account];
  const e = Object.hasOwn(budget.envelopes, env) ? budget.envelopes[env] : undefined;
  const name = `“${e?.name ?? env}”`;
  if (!isZero(spent) && !confirm(`${spending} All of it will count against no envelope instead of ${name}. Continue?`)) {
    return null;
  }
  let closeOn: IsoDate | undefined;
  if (e && e.closed_at === undefined && pairedTo(budget, env).length === 1) {
    // What the envelope will hold once this account's spending no longer counts against it.
    const avail = available.get(env) ?? { amount: 0n, exp: 0, cur: e.cur };
    const after = pairings(budget, chart).has(account) ? add(avail, spent) : avail;
    if (isZero(after) && confirm(`Nothing else is spent from ${name}, and it holds nothing. Close it too?`)) {
      closeOn = today();
    }
  }
  return ledger.updateBudget((doc) => withoutEnvelope(doc, account, closeOn));
}
