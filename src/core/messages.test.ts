import { describe, expect, it } from 'vitest';
import { chartProblems, chartUpdateProblems } from './chart.js';
import { CodecError } from './errors.js';
import {
  decodeMessage, decodeState, encodeMessage, encodeState, parseMessage, UnknownTypeError,
  UnknownVersionError, type AccountsDoc, type Entry,
} from './messages.js';
import { A, accountsDoc, chart, E, entry, lbl, msg, usd } from './testing.js';
import { entryPostProblems, entryProblems } from './validate.js';

const blob = { blob: `B${'b'.repeat(43)}`, dek: 'k'.repeat(43) };
const groceries = entry('2026-09-14', [usd(A.checking, -8423), usd(A.groceries, 6112), usd(A.dining, 2311)], {
  payee: 'payee_kR3nQ8vZ1mH7bWxT2yLp',
  memo: 'groceries + household',
  receipts: [blob],
});

describe('ledger.entry', () => {
  it('decodes amounts to bigint and round-trips', () => {
    const e = decodeMessage('ledger.entry', groceries);
    expect(e.splits[0].amount).toBe(-8423n);
    expect(JSON.parse(encodeMessage('ledger.entry', e))).toEqual(groceries);
  });
  it('parses from JSON text', () => {
    expect(parseMessage('ledger.entry', JSON.stringify(groceries)).date).toBe('2026-09-14');
  });
  it.each([
    ['an unknown field', { ...groceries, extra: 1 }],
    ['one split', entry('2026-09-14', [usd(A.checking, -1)])],
    ['a zero split', entry('2026-09-14', [usd(A.checking, 0), usd(A.groceries, 0)])],
    ['a numeric amount', entry('2026-09-14', [{ ...usd(A.checking, -1), amount: -1 }, usd(A.groceries, 1)])],
    ['an empty memo', { ...groceries, memo: '' }],
    ['empty receipts', { ...groceries, receipts: [] }],
    ['a bad date', entry('2026-02-30', [usd(A.checking, -1), usd(A.groceries, 1)])],
    ['a null optional field', { ...groceries, payee: null }],
    ['a missing v', { date: '2026-09-14', splits: groceries.splits }],
  ])('rejects %s', (_, data) => {
    expect(() => decodeMessage('ledger.entry', data)).toThrow(CodecError);
  });
  it('reports an unknown version before unknown fields', () => {
    expect(() => decodeMessage('ledger.entry', { ...groceries, v: 2, newField: true })).toThrow(UnknownVersionError);
  });
  it('rejects an unknown type', () => {
    expect(() => decodeMessage('ledger.mystery', {})).toThrow(UnknownTypeError);
  });
  it('refuses to encode a malformed message', () => {
    const bad = { ...decodeMessage('ledger.entry', groceries), memo: '' } as Entry;
    expect(() => encodeMessage('ledger.entry', bad)).toThrow(CodecError);
  });
});

describe('fold-time entry rules', () => {
  const problems = (data: unknown, year?: number) => entryProblems(decodeMessage('ledger.entry', data), chart, year);
  const cost = { cost: { amount: '500000', exp: 2, cur: 'USD' }, acquired: '2026-10-03' };
  const vti = (qty: number, extra: object = {}) => ({ account: A.vti, amount: String(qty), exp: 0, cur: 'VTI', ...extra });
  const tvti = (qty: number) => ({ account: A.tradingVti, amount: String(qty), exp: 0, cur: 'VTI' });

  it('accepts a balanced entry', () => expect(problems(groceries, 2026)).toEqual([]));
  it('checks routing', () => expect(problems(groceries, 2025)).toHaveLength(1));
  it('checks sums per commodity', () => {
    expect(problems(entry('2026-01-01', [usd(A.checking, -100), usd(A.groceries, 99)]))).toHaveLength(1);
  });
  it('checks accounts and commodities', () => {
    expect(problems(entry('2026-01-01', [usd(A.vti, -100), usd(A.groceries, 100)]))).toHaveLength(1);
  });
  it('accepts a lot-creating buy', () => {
    const buy = entry('2026-10-03', [vti(100, cost), tvti(-100), usd(A.tradingUsd, 500000), usd(A.checking, -500000)]);
    expect(problems(buy)).toEqual([]);
  });
  it('rejects cost without acquired, and cost on a negative split', () => {
    const noAcq = entry('2026-10-03', [vti(100, { cost: cost.cost }), tvti(-100)]);
    expect(problems(noAcq)).toHaveLength(1);
    const neg = entry('2026-10-03', [vti(-100, cost), tvti(100)]);
    expect(problems(neg)).toHaveLength(1);
  });
  it('checks from_lots quantities', () => {
    const draw = (qty: string) => ({
      lot: `${msg('buy')}#0`, qty, acquired: '2026-10-03', basis: { amount: '250000', exp: 2, cur: 'USD' },
    });
    const sell = (q: string) => entry('2026-11-01', [vti(-50, { from_lots: [draw(q)] }), tvti(50)]);
    expect(problems(sell('50'))).toEqual([]);
    expect(problems(sell('40'))).toHaveLength(1);
  });
  it('rejects duplicate import_ids', () => {
    const dup = entry('2026-01-01', [usd(A.checking, -1, { import_id: lbl('a') }), usd(A.visa, 1, { import_id: lbl('a') })]);
    expect(problems(dup)).toHaveLength(1);
  });
  it('post-time: closed accounts, unknown payees, consumed rows, frozen segments', () => {
    const e = decodeMessage(
      'ledger.entry',
      entry('2026-01-01', [usd(A.checking, -1, { import_id: lbl('a') }), usd(A.rent, 1)], {
        payee: 'payee_kR3nQ8vZ1mH7bWxT2yLp',
      }),
    );
    const payees = decodeState('ledger/payees', { v: 1, rev: 1, payees: {} });
    expect(entryPostProblems(e, { chart, payees, isConsumed: () => true, segmentOpen: false })).toHaveLength(4);
  });
});

describe('other messages', () => {
  it('ledger.edit needs a field besides target', () => {
    expect(() => decodeMessage('ledger.edit', { v: 1, edits: [{ target: msg('a') }] })).toThrow(CodecError);
    expect(() => decodeMessage('ledger.edit', { v: 1, edits: [{ target: msg('a'), splits: { '01': A.dining } }] })).toThrow(
      CodecError,
    );
    const ok = decodeMessage('ledger.edit', { v: 1, edits: [{ target: msg('a'), payee: null, receipts: [] }] });
    expect(ok.edits[0].payee).toBeNull();
  });
  it('ledger.dismiss rejects duplicates', () => {
    expect(() => decodeMessage('ledger.dismiss', { v: 1, import_ids: [lbl('a'), lbl('a')] })).toThrow(CodecError);
  });
  it('ledger.checkpoint', () => {
    const close = { v: 1, period: '2025-12', rounding: 'v1', heads: [{ topic: 'journal-2025', hash: msg('h'), final: true }] };
    expect(decodeMessage('ledger.checkpoint', close).heads[0].final).toBe(true);
    const finalBudget = { ...close, heads: [{ topic: 'budget', hash: msg('h'), final: true }] };
    expect(() => decodeMessage('ledger.checkpoint', finalBudget)).toThrow(CodecError);
    expect(() => decodeMessage('ledger.checkpoint', { ...close, lots: [] })).toThrow(CodecError);
    expect(() => decodeMessage('ledger.checkpoint', { ...close, period: '2025-13' })).toThrow(CodecError);
  });
  describe('ledger.reallocation', () => {
    const move = {
      v: 1, date: '2026-10-14', cur: 'USD', memo: 'cover groceries overspend',
      legs: [{ envelope: E.dining, amount: '-2000', exp: 2 }, { envelope: E.groceries, amount: '2000', exp: 2 }],
    };
    it('decodes amounts to bigint and round-trips', () => {
      const r = decodeMessage('ledger.reallocation', move);
      expect(r.legs.map((l) => l.amount)).toEqual([-2000n, 2000n]);
      expect(JSON.parse(encodeMessage('ledger.reallocation', r))).toEqual(move);
    });
    it.each([
      ['one leg', { ...move, legs: [move.legs[0]] }],
      ['a repeated envelope', { ...move, legs: [move.legs[0], { ...move.legs[1], envelope: E.dining }] }],
      ['a zero leg', { ...move, legs: [move.legs[0], { ...move.legs[1], amount: '0' }] }],
      ['a leg with its own cur', { ...move, legs: [move.legs[0], { ...move.legs[1], cur: 'USD' }] }],
      ['an empty memo', { ...move, memo: '' }],
      ['no cur', { v: 1, date: move.date, legs: move.legs }],
    ])('rejects %s', (_, data) => {
      expect(() => decodeMessage('ledger.reallocation', data)).toThrow(CodecError);
    });
  });
  it('ledger.recon rejects duplicate cleared entries', () => {
    const recon = {
      v: 1, account: A.checking, statement_date: '2026-09-30',
      closing_balance: { amount: '412377', exp: 2, cur: 'USD' }, cleared: [msg('a'), msg('a')],
    };
    expect(() => decodeMessage('ledger.recon', recon)).toThrow(CodecError);
  });
});

describe('State documents', () => {
  it('the fixture chart is valid', () => expect(chartProblems(accountsDoc)).toEqual([]));
  it('finds chart problems', () => {
    const bad = decodeState('ledger/accounts', {
      v: 1,
      rev: 1,
      accounts: {
        [A.checking]: { name: 'C', type: 'asset', cur: 'USD', parent: A.visa },
        [A.visa]: { name: 'V', type: 'asset', cur: 'USD', parent: A.checking },
        [A.dining]: { name: 'D', type: 'expense', cur: 'USD', parent: A.visa },
      },
    });
    const p = chartProblems(bad);
    expect(p.some((x) => x.includes('cycle'))).toBe(true);
    expect(p).toContain(`${A.dining}: parent has a different type`);
  });
  it('the chart has no budgeting fields', () => {
    for (const field of [{ budgetable: true }, { envelope: true }, { envelope_account: A.visa }]) {
      const doc = { v: 1, rev: 1, accounts: { [A.checking]: { name: 'C', type: 'asset', cur: 'USD', parent: null, ...field } } };
      expect(() => decodeState('ledger/accounts', doc)).toThrow(CodecError);
    }
  });
  it('chart updates keep accounts, types, and commodities', () => {
    const next: AccountsDoc = {
      ...accountsDoc,
      rev: 2,
      accounts: { ...accountsDoc.accounts, [A.checking]: { ...accountsDoc.accounts[A.checking], cur: 'EUR' as never } },
    };
    expect(chartUpdateProblems(accountsDoc, next)).toEqual([`${A.checking}: cur is immutable`]);
  });
  it('round-trips the budget document and rejects unsorted steps', () => {
    const schedule = [
      { from: '2024-01', amount: '60000', exp: 2 },
      { from: '2025-12', amount: '70000', exp: 2 },
    ];
    const doc = {
      v: 1,
      rev: 7,
      envelopes: {
        [E.groceries]: { name: 'Groceries', cur: 'USD', schedule },
        [E.dining]: { name: 'Dining', cur: 'USD', closed_at: '2026-01-01' },
      },
      spent_from: { [A.groceries]: E.groceries, [A.dining]: E.groceries },
      budgetable: [A.checking, A.visa],
    };
    expect(JSON.parse(encodeState('ledger/budget', decodeState('ledger/budget', doc)))).toEqual(doc);
    const unsorted = {
      ...doc,
      envelopes: { [E.groceries]: { name: 'Groceries', cur: 'USD', schedule: [...schedule].reverse() } },
    };
    expect(() => decodeState('ledger/budget', unsorted)).toThrow(CodecError);
    // Steps take the envelope's cur; envelope keys are EnvelopeIds; budgetable has no repeats.
    const withCur = { ...doc, envelopes: { [E.groceries]: { name: 'G', cur: 'USD', schedule: [{ ...schedule[0], cur: 'USD' }] } } };
    expect(() => decodeState('ledger/budget', withCur)).toThrow(CodecError);
    expect(() => decodeState('ledger/budget', { ...doc, envelopes: { [A.checking]: { name: 'G', cur: 'USD' } } })).toThrow(CodecError);
    expect(() => decodeState('ledger/budget', { ...doc, budgetable: [A.checking, A.checking] })).toThrow(CodecError);
  });
  it('payees may not chain merges', () => {
    const p = (s: string) => `payee_${s.padEnd(20, 'x')}`;
    const doc = {
      v: 1, rev: 1,
      payees: { [p('a')]: { name: 'A', merged_into: p('b') }, [p('b')]: { name: 'B', merged_into: p('c') }, [p('c')]: { name: 'C' } },
    };
    expect(() => decodeState('ledger/payees', doc)).toThrow(CodecError);
  });
  it('rules are stored normalized and set a payee or account', () => {
    const rule = { id: `rule_${'r'.repeat(20)}`, op: 'contains', pattern: 'blue bottle', account: A.dining };
    expect(decodeState('ledger/rules', { v: 1, rev: 1, rules: [rule] }).rules).toHaveLength(1);
    expect(() => decodeState('ledger/rules', { v: 1, rev: 1, rules: [{ ...rule, pattern: 'Blue Bottle' }] })).toThrow(CodecError);
    const { account: _, ...bare } = rule;
    expect(() => decodeState('ledger/rules', { v: 1, rev: 1, rules: [bare] })).toThrow(CodecError);
    const full = { ...rule, field: 'memo', sign: 'negative', scope: A.checking };
    expect(decodeState('ledger/rules', { v: 1, rev: 1, rules: [full] }).rules[0]).toEqual(full);
    for (const bad of [{ field: 'payee' }, { sign: 'debit' }, { op: 'regex' }, { pattern: '' }]) {
      expect(() => decodeState('ledger/rules', { v: 1, rev: 1, rules: [{ ...rule, ...bad }] }), JSON.stringify(bad)).toThrow(
        CodecError,
      );
    }
  });
  it('import profiles: columns follow header', () => {
    const profile = {
      delimiter: ',', skip_rows: 0, header: true,
      date: { column: 'Posting Date', format: 'MM/DD/YYYY' },
      amount: { column: 'Amount', negate: false },
      description: { column: 'Description' },
      exp: 2,
    };
    const doc = (p: object) => ({ v: 1, rev: 1, profiles: { [A.checking]: p } });
    expect(decodeState('ledger/import-profiles', doc(profile)).profiles[A.checking].exp).toBe(2);
    expect(() => decodeState('ledger/import-profiles', doc({ ...profile, header: false }))).toThrow(CodecError);
    expect(() => decodeState('ledger/import-profiles', doc({ ...profile, date: { column: 'D', format: 'MM/YYYY' } }))).toThrow(
      CodecError,
    );
    const debitCredit = { ...profile, header: false, date: { column: 0, format: 'YYYY-MM-DD' }, amount: { debit: 1, credit: 2 }, description: { column: 3 } };
    expect(decodeState('ledger/import-profiles', doc(debitCredit)).profiles[A.checking].amount).toEqual({ debit: 1, credit: 2 });
  });
  it('import profiles: encoding, skip_end_rows, memo, YY, and delimiter', () => {
    const profile = {
      delimiter: ',', skip_rows: 0, header: true,
      date: { column: 'Date', format: 'MM/DD/YY' },
      amount: { column: 'Amount', negate: false },
      description: { column: 'Description' },
      exp: 2,
    };
    const doc = (p: object) => ({ v: 1, rev: 1, profiles: { [A.checking]: { ...profile, ...p } } });
    const full = doc({ encoding: 'windows-1252', skip_end_rows: 2, memo: { column: 'Memo' } });
    expect(decodeState('ledger/import-profiles', full).profiles[A.checking]).toMatchObject({
      encoding: 'windows-1252', skip_end_rows: 2, memo: { column: 'Memo' },
    });
    for (const bad of [
      { encoding: 'latin1' },
      { encoding: 'UTF-8' },
      { skip_end_rows: -1 },
      { memo: { column: 3 } },
      { date: { column: 'Date', format: 'YY/YYYY/MM/DD' } },
      { delimiter: '"' },
      { delimiter: '\n' },
    ]) {
      expect(() => decodeState('ledger/import-profiles', doc(bad)), JSON.stringify(bad)).toThrow(CodecError);
    }
  });
});
