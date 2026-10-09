import { describe, expect, it } from 'vitest';
import { commodity } from './amount.js';
import {
  budgetableAccounts, budgetUpdateProblems, EMPTY_BUDGET, pairedTo, pairings, withEnvelope, withPairing,
} from './budget.js';
import type { EnvelopeId } from './ids.js';
import type { Allocation, BudgetDoc } from './messages.js';
import { A, budgetDoc, chart, E, envelope, day } from './testing.js';
import { allocationPostProblems } from './validate.js';

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

describe('allocationPostProblems', () => {
  const alloc = (envelope: EnvelopeId, cur = 'USD'): Allocation => ({
    v: 1, date: day('2026-10-01'), envelope, amount: 60000n, exp: 2, cur: commodity(cur),
  });

  it('accepts an allocation to an open envelope in its commodity', () => {
    expect(allocationPostProblems(alloc(E.groceries), budgetDoc)).toEqual([]);
  });

  it('applies the fold-time rules', () => {
    expect(allocationPostProblems(alloc(envelope('missing')), budgetDoc)).toEqual(['unknown envelope']);
    expect(allocationPostProblems(alloc(E.groceries, 'EUR'), budgetDoc)).toEqual(['EUR allocated to a USD envelope']);
  });

  it('rejects a closed envelope', () => {
    const closed = {
      ...budgetDoc,
      envelopes: { ...budgetDoc.envelopes, [E.dining]: { ...budgetDoc.envelopes[E.dining], closed_at: day('2026-01-01') } },
    };
    expect(allocationPostProblems(alloc(E.dining), closed)).toEqual(['envelope is closed']);
  });
});

describe('editing the budget', () => {
  it('re-pairs, unpairs, and lists the accounts spent from an envelope', () => {
    const moved = withPairing(budgetDoc, A.dining, E.groceries);
    expect(pairedTo(moved, E.groceries)).toEqual([A.groceries, A.dining]);
    expect(pairedTo(moved, E.dining)).toEqual([]);
    const unpaired = withPairing(moved, A.groceries, null);
    expect(unpaired.spent_from).toEqual({ [A.dining]: E.groceries });
    expect(budgetUpdateProblems(budgetDoc, { ...unpaired, rev: 2 }, chart)).toEqual([]);
  });

  it('changes one envelope', () => {
    const renamed = withEnvelope(budgetDoc, E.dining, (e) => ({ ...e, name: 'Eating out' }));
    expect(renamed.envelopes[E.dining]).toEqual({ name: 'Eating out', cur: 'USD' });
    expect(renamed.envelopes[E.groceries]).toBe(budgetDoc.envelopes[E.groceries]);
    expect(() => withEnvelope(budgetDoc, envelope('missing'), (e) => e)).toThrow();
  });

  it('cannot close an envelope that is still spent from', () => {
    const closed = withEnvelope(budgetDoc, E.dining, (e) => ({ ...e, closed_at: day('2026-10-01') }));
    expect(budgetUpdateProblems(budgetDoc, { ...closed, rev: 2 }, chart)).toEqual([
      `spent_from ${A.dining}: envelope ${E.dining} is closed`,
    ]);
    const unpaired = withPairing(closed, A.dining, null);
    expect(budgetUpdateProblems(budgetDoc, { ...unpaired, rev: 2 }, chart)).toEqual([]);
  });
});
