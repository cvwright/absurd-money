import { describe, expect, it } from 'vitest';
import { commodity } from './amount.js';
import {
  budgetableAccounts, budgetUpdateProblems, EMPTY_BUDGET, moveBetween, pairedTo, pairings, soleAccount,
  withBudgetable, withEnvelope, withoutEnvelope, withOwnEnvelope, withPairing,
} from './budget.js';
import type { EnvelopeId } from './ids.js';
import type { Allocation, BudgetDoc, Reallocation } from './messages.js';
import { A, acct, budgetDoc, chart, E, envelope, day } from './testing.js';
import { allocationPostProblems, reallocationPostProblems } from './validate.js';

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

describe('reallocationPostProblems', () => {
  const move = (legs: [EnvelopeId, bigint][], cur = 'USD'): Reallocation => ({
    v: 1, date: day('2026-10-14'), cur: commodity(cur),
    legs: legs.map(([envelope, amount]) => ({ envelope, amount, exp: 2 })),
  });

  it('accepts a move between open envelopes that sums to zero', () => {
    expect(reallocationPostProblems(move([[E.dining, -2000n], [E.groceries, 2000n]]), budgetDoc)).toEqual([]);
  });

  it('applies the fold-time rules', () => {
    expect(reallocationPostProblems(move([[E.dining, -2000n], [envelope('missing'), 2000n]]), budgetDoc)).toEqual([
      'leg 1: unknown envelope',
    ]);
    expect(reallocationPostProblems(move([[E.dining, -2000n], [E.groceries, 2000n]], 'EUR'), budgetDoc)).toEqual([
      'leg 0: EUR moved to a USD envelope',
      'leg 1: EUR moved to a USD envelope',
    ]);
    expect(reallocationPostProblems(move([[E.dining, -2000n], [E.groceries, 1999n]]), budgetDoc)).toEqual([
      'legs do not sum to zero',
    ]);
  });

  it('rejects a leg naming a closed envelope, from either side', () => {
    const closed = withEnvelope(budgetDoc, E.dining, (e) => ({ ...e, closed_at: day('2026-01-01') }));
    expect(reallocationPostProblems(move([[E.dining, -2000n], [E.groceries, 2000n]]), closed)).toEqual([
      'leg 0: envelope is closed',
    ]);
    expect(reallocationPostProblems(move([[E.groceries, -2000n], [E.dining, 2000n]]), closed)).toEqual([
      'leg 1: envelope is closed',
    ]);
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

  it('adds and removes budgetable accounts without repeats', () => {
    const off = withBudgetable(budgetDoc, A.checking, false);
    expect(off.budgetable).toEqual([A.visa]);
    expect(withBudgetable(off, A.checking, false).budgetable).toEqual([A.visa]);
    const on = withBudgetable(off, A.vti, true);
    expect(withBudgetable(on, A.vti, true).budgetable).toEqual([A.visa, A.vti]);
    expect(budgetUpdateProblems(budgetDoc, { ...on, rev: 2 }, chart)).toEqual([]);
    expect(budgetUpdateProblems(budgetDoc, { ...withBudgetable(on, A.salary, true), rev: 2 }, chart)).toEqual([
      `budgetable ${A.salary}: not an asset or liability account`,
    ]);
  });
});

describe('budget this', () => {
  const fresh = envelope('fresh');
  const bare: BudgetDoc = { ...EMPTY_BUDGET, rev: 1 };

  it('creates an envelope named for the account and pairs it, in one write', () => {
    const doc = withOwnEnvelope(bare, chart, A.groceries, fresh);
    expect(doc.envelopes).toEqual({ [fresh]: { name: 'Groceries', cur: 'USD' } });
    expect(doc.spent_from).toEqual({ [A.groceries]: fresh });
    expect(budgetUpdateProblems(bare, { ...doc, rev: 2 }, chart)).toEqual([]);
    expect(soleAccount(doc, chart, fresh)).toBe(A.groceries);
  });

  it('leaves an account whose pairing counts as it is', () => {
    expect(withOwnEnvelope(budgetDoc, chart, A.groceries, fresh)).toBe(budgetDoc);
    const shared = withPairing(budgetDoc, A.dining, E.groceries);
    expect(withOwnEnvelope(shared, chart, A.dining, fresh)).toBe(shared);
  });

  it('pairs with an open envelope of that name that nothing is spent from', () => {
    const unpaired = withPairing(budgetDoc, A.groceries, null);
    const doc = withOwnEnvelope(unpaired, chart, A.groceries, fresh);
    expect(doc.envelopes).toBe(unpaired.envelopes);
    expect(doc.spent_from[A.groceries]).toBe(E.groceries);
  });

  it('makes a new envelope rather than reuse one that is closed, funds another account, or differs', () => {
    const closed = withEnvelope(withPairing(budgetDoc, A.groceries, null), E.groceries, (e) => ({
      ...e, closed_at: day('2026-01-01'),
    }));
    expect(withOwnEnvelope(closed, chart, A.groceries, fresh).spent_from[A.groceries]).toBe(fresh);
    const elsewhere = withPairing(withPairing(budgetDoc, A.groceries, null), A.dining, E.groceries);
    expect(withOwnEnvelope(elsewhere, chart, A.groceries, fresh).spent_from[A.groceries]).toBe(fresh);
    const euros = withEnvelope(withPairing(budgetDoc, A.groceries, null), E.groceries, (e) => ({ ...e, cur: EUR }));
    expect(withOwnEnvelope(euros, chart, A.groceries, fresh).spent_from[A.groceries]).toBe(fresh);
  });

  it('replaces a pairing that does not count', () => {
    const broken = withPairing(budgetDoc, A.groceries, envelope('missing'));
    expect(withOwnEnvelope(broken, chart, A.groceries, fresh).spent_from[A.groceries]).toBe(E.groceries);
  });

  it('refuses anything but an expense account, and an ID already taken', () => {
    expect(() => withOwnEnvelope(bare, chart, A.checking, fresh)).toThrow();
    expect(() => withOwnEnvelope(bare, chart, acct('missing'), fresh)).toThrow();
    expect(() => withOwnEnvelope(budgetDoc, chart, A.rent, E.dining)).toThrow();
  });

  it('unpairs, and closes the envelope only when asked and nothing else is spent from it', () => {
    const kept = withoutEnvelope(budgetDoc, A.groceries);
    expect(kept.spent_from).toEqual({ [A.dining]: E.dining });
    expect(kept.envelopes).toBe(budgetDoc.envelopes);
    const closed = withoutEnvelope(budgetDoc, A.groceries, day('2026-10-08'));
    expect(closed.envelopes[E.groceries]).toEqual({ name: 'Groceries', cur: 'USD', closed_at: '2026-10-08' });
    expect(budgetUpdateProblems(budgetDoc, { ...closed, rev: 2 }, chart)).toEqual([]);
    const shared = withPairing(budgetDoc, A.dining, E.groceries);
    expect(withoutEnvelope(shared, A.groceries, day('2026-10-08')).envelopes).toBe(shared.envelopes);
    expect(withoutEnvelope(kept, A.groceries, day('2026-10-08'))).toBe(kept);
  });

  it('shows an envelope as its account only when it funds exactly that one, of the same name', () => {
    expect(soleAccount(budgetDoc, chart, E.dining)).toBe(A.dining);
    const shared = withPairing(budgetDoc, A.dining, E.groceries);
    expect(soleAccount(shared, chart, E.groceries)).toBeUndefined();
    expect(soleAccount(shared, chart, E.dining)).toBeUndefined();
    const renamed = withEnvelope(budgetDoc, E.dining, (e) => ({ ...e, name: 'Eating out' }));
    expect(soleAccount(renamed, chart, E.dining)).toBeUndefined();
    expect(soleAccount(budgetDoc, chart, envelope('missing'))).toBeUndefined();
  });
});

describe('moveBetween', () => {
  const amount = { amount: 5000n, exp: 2, cur: commodity('USD') };

  it('builds a two-leg reallocation that passes the post-time rules', () => {
    const m = moveBetween(E.dining, E.groceries, amount, day('2026-10-14'), 'Hosting');
    expect(m).toEqual({
      v: 1, date: '2026-10-14', cur: 'USD', memo: 'Hosting',
      legs: [{ envelope: E.dining, amount: -5000n, exp: 2 }, { envelope: E.groceries, amount: 5000n, exp: 2 }],
    });
    expect(reallocationPostProblems(m, budgetDoc)).toEqual([]);
    expect(moveBetween(E.dining, E.groceries, amount, day('2026-10-14'))).not.toHaveProperty('memo');
  });

  it('refuses a move to the same envelope or of nothing', () => {
    expect(() => moveBetween(E.dining, E.dining, amount, day('2026-10-14'))).toThrow();
    expect(() => moveBetween(E.dining, E.groceries, { ...amount, amount: 0n }, day('2026-10-14'))).toThrow();
    expect(() => moveBetween(E.dining, E.groceries, { ...amount, amount: -1n }, day('2026-10-14'))).toThrow();
  });
});
