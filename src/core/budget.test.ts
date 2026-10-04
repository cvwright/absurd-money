import { describe, expect, it } from 'vitest';
import { commodity } from './amount.js';
import { budgetableAccounts, budgetUpdateProblems, EMPTY_BUDGET, pairings } from './budget.js';
import type { BudgetDoc } from './messages.js';
import { A, budgetDoc, chart, E, envelope, day } from './testing.js';

const EUR = commodity('EUR');
const next = (doc: BudgetDoc, change: Partial<BudgetDoc>): BudgetDoc => ({ ...doc, rev: doc.rev + 1, ...change });

describe('budgetUpdateProblems', () => {
  it('accepts the fixture as a first write', () => {
    expect(budgetUpdateProblems(EMPTY_BUDGET, budgetDoc, chart)).toEqual([]);
  });

  it('lets one envelope fund several expense accounts', () => {
    const shared = next(budgetDoc, { spent_from: { [A.groceries]: E.groceries, [A.dining]: E.groceries } });
    expect(budgetUpdateProblems(budgetDoc, shared, chart)).toEqual([]);
    expect(pairings(shared, chart)).toEqual(new Map([[A.groceries, E.groceries], [A.dining, E.groceries]]));
  });

  it('keeps envelopes and their commodity, and bumps rev', () => {
    const { [E.dining]: _, ...rest } = budgetDoc.envelopes;
    const changed = {
      envelopes: { ...rest, [E.groceries]: { ...budgetDoc.envelopes[E.groceries], cur: EUR } },
      spent_from: { [A.groceries]: E.groceries },
    };
    expect(budgetUpdateProblems(budgetDoc, { ...budgetDoc, ...changed }, chart)).toEqual([
      `spent_from ${A.groceries}: USD spent from a EUR envelope`,
      'rev must be 2',
      `${E.groceries}: cur is immutable`,
      `${E.dining}: envelopes are never removed`,
    ]);
  });

  it('checks references into the chart and to open envelopes', () => {
    const closed = next(budgetDoc, {
      envelopes: { ...budgetDoc.envelopes, [E.dining]: { ...budgetDoc.envelopes[E.dining], closed_at: day('2026-01-01') } },
      spent_from: { [A.groceries]: envelope('missing'), [A.salary]: E.groceries, [A.dining]: E.dining },
      budgetable: [A.checking, A.groceries],
    });
    expect(budgetUpdateProblems(budgetDoc, closed, chart)).toEqual([
      `spent_from ${A.groceries}: unknown envelope ${envelope('missing')}`,
      `spent_from ${A.salary}: not an expense account`,
      `budgetable ${A.groceries}: not an asset or liability account`,
      `spent_from ${A.dining}: envelope ${E.dining} is closed`,
    ]);
    expect(budgetableAccounts(closed, chart)).toEqual([A.checking]);
  });
});
