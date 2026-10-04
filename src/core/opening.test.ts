import { describe, expect, it } from 'vitest';
import { commodity, type Decimal } from './amount.js';
import { accountLabel, accountPath, chartOf } from './chart.js';
import type { AccountId } from './ids.js';
import { encodeMessage, type AccountsDoc } from './messages.js';
import {
  findOpeningEquity, openingCommodities, openingEntry, openingEquityAccount, OPENING_EQUITY_NAME,
  type OpeningLine,
} from './opening.js';
import { A, accountsDoc, acct, chart, day } from './testing.js';

const USD = commodity('USD');
const VTI = commodity('VTI');
const dec = (amount: bigint, exp = 2): Decimal => ({ amount, exp });
const D = day('2026-10-01');
const equity = new Map([[USD, A.equity], [VTI, A.tradingVti]]);

describe('openingEntry', () => {
  it('posts assets as debits and liabilities owed as credits, against equity', () => {
    const lines: OpeningLine[] = [
      { account: A.checking, balance: dec(250000n) },
      { account: A.visa, balance: dec(42017n) },
    ];
    const { entry, problems } = openingEntry({ date: D, lines, equity }, chart);
    expect(problems).toBeUndefined();
    expect(entry!.date).toBe(D);
    expect(entry!.memo).toBe(OPENING_EQUITY_NAME);
    expect(entry!.splits.map((s) => [s.account, s.amount])).toEqual([
      [A.checking, 250000n],
      [A.visa, -42017n],
      [A.equity, -(250000n - 42017n)],
    ]);
    // It round-trips through the codec, so it can be posted.
    expect(() => encodeMessage('ledger.entry', entry!)).not.toThrow();
  });

  it('skips zero balances and needs no equity split when positions net to zero', () => {
    const lines: OpeningLine[] = [
      { account: A.checking, balance: dec(1000n) },
      { account: A.visa, balance: dec(10n, 0) },
      { account: A.vti, balance: dec(0n, 0) },
    ];
    expect(openingCommodities(D, lines, chart)).toEqual([]);
    const { entry } = openingEntry({ date: D, lines, equity: new Map() }, chart);
    expect(entry!.splits.map((s) => s.account)).toEqual([A.checking, A.visa]);
  });

  it('handles an overdrawn asset and a liability in credit', () => {
    const lines: OpeningLine[] = [
      { account: A.checking, balance: dec(-500n) },
      { account: A.visa, balance: dec(-300n) },
    ];
    const { entry } = openingEntry({ date: D, lines, equity }, chart);
    expect(entry!.splits.map((s) => s.amount)).toEqual([-500n, 300n, 200n]);
  });

  it('balances different exponents exactly', () => {
    const lines: OpeningLine[] = [
      { account: A.checking, balance: dec(12n, 0) },
      { account: A.visa, balance: dec(1234n, 3) },
    ];
    const { entry } = openingEntry({ date: D, lines, equity }, chart);
    expect(entry!.splits.at(-1)).toEqual({ account: A.equity, amount: -10766n, exp: 3, cur: USD });
  });

  it('creates one lot per opening lot, with its real acquisition date', () => {
    const lines: OpeningLine[] = [
      {
        account: A.vti,
        lots: [
          { qty: dec(100n, 0), cost: { amount: 500000n, exp: 2, cur: USD }, acquired: day('2019-03-04') },
          { qty: dec(25n, 0), cost: { amount: 190000n, exp: 2, cur: USD }, acquired: day('2021-06-30') },
        ],
      },
    ];
    expect(openingCommodities(D, lines, chart)).toEqual([VTI]);
    const { entry, problems } = openingEntry({ date: D, lines, equity }, chart);
    expect(problems).toBeUndefined();
    expect(entry!.splits).toEqual([
      { account: A.vti, amount: 100n, exp: 0, cur: VTI, cost: { amount: 500000n, exp: 2, cur: USD }, acquired: '2019-03-04' },
      { account: A.vti, amount: 25n, exp: 0, cur: VTI, cost: { amount: 190000n, exp: 2, cur: USD }, acquired: '2021-06-30' },
      { account: A.tradingVti, amount: -125n, exp: 0, cur: VTI },
    ]);
  });

  it('keeps a custom memo', () => {
    const lines: OpeningLine[] = [{ account: A.checking, balance: dec(1n) }];
    expect(openingEntry({ date: D, lines, equity, memo: '  Start  ' }, chart).entry!.memo).toBe('Start');
  });

  it('reports every problem at once', () => {
    const lots = [
      { qty: dec(0n, 0), cost: { amount: -1n, exp: 0, cur: VTI }, acquired: day('2027-01-01') },
      { qty: dec(1n, 0), cost: { amount: 1n, exp: 2, cur: USD }, acquired: D },
    ];
    const lines: OpeningLine[] = [
      { account: acct('missing'), balance: dec(1n) },
      { account: A.salary, balance: dec(1n) },
      { account: A.checking, balance: dec(1n) },
      { account: A.checking, balance: dec(2n) },
      { account: A.visa, lots },
    ];
    const { problems } = openingEntry({ date: D, lines, equity: new Map() }, chart);
    expect(problems).toEqual([
      `${acct('missing')}: unknown account`,
      '"Salary": only asset and liability accounts have opening balances',
      '"Checking": listed twice',
      '"Visa": only asset accounts hold lots',
      '"Visa" lot 1: quantity must be positive',
      '"Visa" lot 1: cost must not be negative',
      '"Visa" lot 1: acquired after the opening date',
      '"Visa" lot 2: cost must be in another commodity',
      'no equity account for USD',
    ]);
  });

  it('rejects a closed account, an empty entry, and an unusable equity account', () => {
    const closed: AccountsDoc = {
      ...accountsDoc,
      accounts: { ...accountsDoc.accounts, [A.checking]: { ...accountsDoc.accounts[A.checking], closed_at: day('2026-01-01') } },
    };
    const lines: OpeningLine[] = [{ account: A.checking, balance: dec(1n) }];
    expect(openingEntry({ date: D, lines, equity }, chartOf(closed)).problems).toEqual(['"Checking": account is closed']);
    expect(openingEntry({ date: D, lines: [], equity }, chart).problems).toEqual(['every balance is zero']);
    const income = new Map([[USD, A.salary]]);
    expect(openingEntry({ date: D, lines, equity: income }, chart).problems).toEqual([
      'the equity account for USD must be an open USD equity account',
    ]);
  });
});

describe('findOpeningEquity', () => {
  it('finds an open "Opening Balances" equity account in the commodity', () => {
    const id = (s: string) => acct(s) as AccountId;
    const doc: AccountsDoc = {
      ...accountsDoc,
      accounts: {
        ...accountsDoc.accounts,
        [id('ob-b')]: openingEquityAccount(USD),
        [id('ob-a')]: { ...openingEquityAccount(USD), name: 'opening balances ' },
        [id('ob-closed')]: { ...openingEquityAccount(VTI), closed_at: day('2026-01-01') },
      },
    };
    expect(findOpeningEquity(chartOf(doc), USD)).toBe(id('ob-a'));
    expect(findOpeningEquity(chartOf(doc), VTI)).toBeUndefined();
    expect(findOpeningEquity(chart, USD)).toBeUndefined();
  });
});

describe('accountPath', () => {
  it('names an account by its ancestors, so same-named positions differ', () => {
    const asset = (name: string, parent: AccountId | null, cur = VTI) => ({ name, type: 'asset' as const, cur, parent });
    const doc: AccountsDoc = {
      ...accountsDoc,
      accounts: {
        ...accountsDoc.accounts,
        [acct('vanguard')]: asset('Vanguard', null, USD),
        [acct('vg-vti')]: asset('VTI', acct('vanguard')),
        [acct('fidelity')]: asset('Fidelity', null, USD),
        [acct('fi-vti')]: asset('VTI', acct('fidelity')),
      },
    };
    const c = chartOf(doc);
    expect(accountPath(c, acct('vg-vti'))).toEqual(['Vanguard', 'VTI']);
    expect(accountLabel(c, acct('fi-vti'))).toBe('Fidelity › VTI');
    expect(accountPath(c, A.checking)).toEqual(['Checking']);
    expect(accountPath(c, acct('missing'))).toEqual([]);
    const lines: OpeningLine[] = [{ account: acct('fi-vti'), balance: dec(1n, 0) }, { account: acct('fi-vti'), balance: dec(1n, 0) }];
    expect(openingEntry({ date: D, lines, equity }, c).problems).toContain('"Fidelity › VTI": listed twice');
  });

  it('stops at a parent cycle', () => {
    const loop: AccountsDoc = {
      ...accountsDoc,
      accounts: {
        [acct('x')]: { name: 'X', type: 'asset', cur: USD, parent: acct('y') },
        [acct('y')]: { name: 'Y', type: 'asset', cur: USD, parent: acct('x') },
      },
    };
    expect(accountPath(chartOf(loop), acct('x')).length).toBeLessThanOrEqual(3);
  });
});
