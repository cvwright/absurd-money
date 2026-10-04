import { describe, expect, it } from 'vitest';
import { commodity, type Decimal } from './amount.js';
import { encodeMessage } from './messages.js';
import { describeImbalance, imbalances, isPostable, manualEntry, type ManualLine } from './manual.js';
import { A, acct, chart, day } from './testing.js';

const USD = commodity('USD');
const VTI = commodity('VTI');
const dec = (amount: bigint, exp = 2): Decimal => ({ amount, exp });
const D = day('2026-09-14');

describe('manualEntry', () => {
  it('posts N splits in order, with debits positive', () => {
    const lines: ManualLine[] = [
      { account: A.visa, amount: dec(-8423n) },
      { account: A.groceries, amount: dec(6112n) },
      { account: A.dining, amount: dec(2311n) },
    ];
    const { entry, problems } = manualEntry({ date: D, lines, memo: '  groceries + household ' }, chart);
    expect(problems).toBeUndefined();
    expect(entry).toEqual({
      v: 1,
      date: D,
      memo: 'groceries + household',
      splits: [
        { account: A.visa, amount: -8423n, exp: 2, cur: USD },
        { account: A.groceries, amount: 6112n, exp: 2, cur: USD },
        { account: A.dining, amount: 2311n, exp: 2, cur: USD },
      ],
    });
    // It round-trips through the codec, so it can be posted.
    expect(() => encodeMessage('ledger.entry', entry!)).not.toThrow();
  });

  it('leaves out a blank memo', () => {
    const lines: ManualLine[] = [
      { account: A.checking, amount: dec(-100n) },
      { account: A.dining, amount: dec(100n) },
    ];
    expect(manualEntry({ date: D, lines, memo: '   ' }, chart).entry).not.toHaveProperty('memo');
  });

  it('fills a blank amount with the remainder, exactly across exponents', () => {
    const lines: ManualLine[] = [
      { account: A.groceries, amount: dec(12n, 0) },
      { account: A.dining, amount: dec(1234n, 3) },
      { account: A.checking },
    ];
    const { entry } = manualEntry({ date: D, lines }, chart);
    expect(entry!.splits[2]).toEqual({ account: A.checking, amount: -13234n, exp: 3, cur: USD });
  });

  it('balances each commodity separately, with one blank per commodity', () => {
    const lines: ManualLine[] = [
      { account: A.vti, amount: dec(10n, 0) },
      { account: A.tradingVti },
      { account: A.tradingUsd, amount: dec(250000n) },
      { account: A.checking },
    ];
    const { entry, problems } = manualEntry({ date: D, lines }, chart);
    expect(problems).toBeUndefined();
    expect(entry!.splits.map((s) => [s.amount, s.cur])).toEqual([
      [10n, VTI],
      [-10n, VTI],
      [250000n, USD],
      [-250000n, USD],
    ]);
  });

  it('allows the same account on two lines', () => {
    const lines: ManualLine[] = [
      { account: A.groceries, amount: dec(100n) },
      { account: A.groceries, amount: dec(200n) },
      { account: A.checking, amount: dec(-300n) },
    ];
    expect(manualEntry({ date: D, lines }, chart).problems).toBeUndefined();
  });

  it('describes what is out of balance', () => {
    const lines: ManualLine[] = [
      { account: A.checking, amount: dec(-1000n) },
      { account: A.dining, amount: dec(1234n) },
      { account: A.vti, amount: dec(-3n, 0) },
      { account: A.tradingVti, amount: dec(1n, 0) },
    ];
    expect(manualEntry({ date: D, lines }, chart).problems).toEqual([
      'USD debits exceed credits by 2.34',
      'VTI credits exceed debits by 2',
    ]);
  });

  it('reports every line problem at once', () => {
    const lines: ManualLine[] = [
      { account: acct('missing'), amount: dec(1n) },
      { account: A.rent, amount: dec(1n) },
      { account: A.dining, amount: dec(0n) },
      { account: A.checking },
      { account: A.visa },
    ];
    expect(manualEntry({ date: D, lines }, chart).problems).toEqual([
      'line 1: unknown account',
      'line 2 ("Rent"): account is closed',
      'line 3 ("Dining"): amount must not be zero',
      'line 5 ("Visa"): only one USD line may leave its amount blank',
    ]);
  });

  it('rejects a blank with nothing to fill and an entry with one line', () => {
    const balanced: ManualLine[] = [
      { account: A.checking, amount: dec(-100n) },
      { account: A.dining, amount: dec(100n) },
      { account: A.groceries },
    ];
    expect(manualEntry({ date: D, lines: balanced }, chart).problems).toEqual([
      'line 3: USD already balances, so there is nothing to fill in',
    ]);
    const one: ManualLine[] = [{ account: A.checking }];
    expect(manualEntry({ date: D, lines: one }, chart).problems).toEqual(['an entry needs at least two lines']);
  });
});

describe('imbalances', () => {
  it('sums lines with amounts on known accounts, leaving balanced commodities out', () => {
    const lines: ManualLine[] = [
      { account: A.checking, amount: dec(-100n) },
      { account: A.dining, amount: dec(150n) },
      { account: A.groceries },
      { account: acct('missing'), amount: dec(5n) },
      { account: A.vti, amount: dec(1n, 0) },
      { account: A.tradingVti, amount: dec(-1n, 0) },
    ];
    expect(imbalances(lines, chart)).toEqual([{ amount: 50n, exp: 2, cur: USD }]);
    expect(describeImbalance({ amount: -5n, exp: 1, cur: USD })).toBe('USD credits exceed debits by 0.5');
  });
});

describe('isPostable', () => {
  it('excludes closed accounts', () => {
    expect(isPostable(chart.get(A.checking))).toBe(true);
    expect(isPostable(chart.get(A.rent))).toBe(false);
    expect(isPostable(undefined)).toBe(false);
  });
});
