import { describe, expect, it } from 'vitest';
import { commodity } from './amount.js';
import { encodeMessage, type Split } from './messages.js';
import { defaultReversalDate, isInverse, reversalOf, reversalPostProblems, type ReversalTarget } from './reversal.js';
import { A, chart, day, lbl, msg } from './testing.js';

const USD = commodity('USD');
const split = (account: Split['account'], amount: bigint, extra: Partial<Split> = {}): Split => ({
  account, amount, exp: 2, cur: USD, ...extra,
});

/** Groceries, posted to Groceries and since recategorized to Dining. */
const target: ReversalTarget = {
  id: msg('food'),
  date: day('2026-02-01'),
  splits: [split(A.checking, -900n, { import_id: lbl('row') }), split(A.groceries, 900n)],
  accounts: [A.checking, A.dining],
  locked: false,
  segmentOpen: true,
};

describe('reversalOf', () => {
  it('inverts each split with the effective accounts, in order, without import labels', () => {
    const rev = reversalOf(target, { date: day('2026-02-01'), memo: ' wrong card ' });
    expect(rev).toEqual({
      v: 1,
      date: '2026-02-01',
      reverses: target.id,
      memo: 'wrong card',
      splits: [
        { account: A.checking, amount: 900n, exp: 2, cur: USD },
        { account: A.dining, amount: -900n, exp: 2, cur: USD },
      ],
    });
    expect(isInverse(target, rev.splits)).toBe(true);
    expect(() => encodeMessage('ledger.reversal', rev)).not.toThrow();
    expect(reversalOf(target, { date: day('2026-02-01'), memo: '  ' })).not.toHaveProperty('memo');
  });

  it('keeps the target exponents', () => {
    const t = { ...target, splits: [split(A.checking, -9000n, { exp: 3 }), split(A.groceries, 900n)] };
    expect(reversalOf(t, { date: t.date }).splits.map((s) => s.exp)).toEqual([3, 2]);
  });
});

describe('defaultReversalDate', () => {
  const today = day('2026-10-04');
  it('is the target date while the target is open', () => {
    expect(defaultReversalDate(target, today)).toBe('2026-02-01');
  });
  it('is today once the target is locked or its segment frozen', () => {
    expect(defaultReversalDate({ ...target, locked: true }, today)).toBe(today);
    expect(defaultReversalDate({ ...target, segmentOpen: false }, today)).toBe(today);
  });
});

describe('isInverse', () => {
  it('compares amounts by value and accounts by effective account', () => {
    expect(isInverse(target, [split(A.checking, 9000n, { exp: 3 }), split(A.dining, -900n)])).toBe(true);
    expect(isInverse(target, [split(A.checking, 900n), split(A.groceries, -900n)])).toBe(false);
    expect(isInverse(target, [split(A.dining, -900n), split(A.checking, 900n)])).toBe(false);
    expect(isInverse(target, [split(A.checking, 900n)])).toBe(false);
  });
});

describe('reversalPostProblems', () => {
  const ctx = { chart, target, segmentOpen: true };
  const rev = reversalOf(target, { date: day('2026-02-01') });

  it('accepts the inverse of an unreversed entry', () => {
    expect(reversalPostProblems(rev, ctx)).toEqual([]);
    // A later year is fine: a reversal routes by its own date.
    expect(reversalPostProblems({ ...rev, date: day('2027-01-05') }, ctx)).toEqual([]);
  });

  it('refuses an unknown or already reversed target', () => {
    expect(reversalPostProblems(rev, { ...ctx, target: undefined })).toEqual(['the reversed message is not a known entry']);
    expect(reversalPostProblems({ ...rev, reverses: msg('other') }, ctx)).toEqual(['the reversed message is not a known entry']);
    expect(reversalPostProblems(rev, { ...ctx, target: { ...target, reversedBy: msg('rev') } }))
      .toEqual([`the entry was already reversed by ${msg('rev')}`]);
  });

  it('refuses splits that are not the inverse, or unbalanced', () => {
    const wrong = { ...rev, splits: [split(A.checking, 900n), split(A.groceries, -900n)] };
    expect(reversalPostProblems(wrong, ctx)).toEqual(['splits are not the inverse of the entry']);
    const unbalanced = { ...rev, splits: [split(A.checking, 900n), split(A.dining, -800n)] };
    expect(reversalPostProblems(unbalanced, ctx)).toContain('splits do not sum to zero per commodity');
  });

  it('refuses a frozen segment', () => {
    expect(reversalPostProblems(rev, { ...ctx, segmentOpen: false })).toEqual(['journal-2026 is frozen']);
  });
});
