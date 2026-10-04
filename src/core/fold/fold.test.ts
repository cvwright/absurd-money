import { describe, expect, it } from 'vitest';
import { commodity } from '../amount.js';
import { allocationLabel, deriveLabelKeys } from '../labels.js';
import type { Month } from '../ids.js';
import { A, chart, entry, lbl, msg, usd } from '../testing.js';
import { envelopeAvailable, foldBudget, toBeBudgeted } from './budget.js';
import { balanceOf, balances, importConsumption, reversalAnomalies } from './ledger.js';
import { foldLots, openLots } from './lots.js';
import { foldSegment, type RawMessage } from './segment.js';

const USD = commodity('USD');
const VTI = commodity('VTI');
const m = (name: string, type: string, data: unknown): RawMessage => ({ id: msg(name), type, data });
const cents = (b: ReturnType<typeof balances>, account: (typeof A)[keyof typeof A]) =>
  balanceOf(b, account, USD).amount;

const e1 = m('e1', 'ledger.entry', entry('2026-09-14', [usd(A.checking, -8423), usd(A.groceries, 6112), usd(A.dining, 2311)]));
const pay = m('pay', 'ledger.entry', entry('2026-09-01', [usd(A.checking, 100000), usd(A.salary, -100000)]));

describe('foldSegment', () => {
  it('folds valid entries and surfaces invalid ones', () => {
    const bad = m('bad', 'ledger.entry', entry('2026-09-14', [usd(A.checking, -1), usd(A.groceries, 2)]));
    const wrongYear = m('yr', 'ledger.entry', entry('2025-12-31', [usd(A.checking, -1), usd(A.groceries, 1)]));
    const malformed = m('mal', 'ledger.entry', { v: 1 });
    const seg = foldSegment('journal-2026', [pay, e1, bad, wrongYear, malformed], { chart });
    expect([...seg.entries.keys()]).toEqual([pay.id, e1.id]);
    expect(seg.anomalies.map((a) => a.kind)).toEqual(['invalid', 'invalid', 'malformed']);
    const b = balances([seg]);
    expect(cents(b, A.checking)).toBe(100000n - 8423n);
    expect(cents(b, A.groceries)).toBe(6112n);
  });

  it('halts at an unknown version or type', () => {
    const future = m('fut', 'ledger.entry', { v: 2 });
    const seg = foldSegment('journal-2026', [pay, future, e1], { chart });
    expect(seg.halted?.at).toBe(future.id);
    expect([...seg.entries.keys()]).toEqual([pay.id]);
    const unknown = foldSegment('journal-2026', [m('x', 'ledger.allocation', {}), pay], { chart });
    expect(unknown.halted).toBeDefined();
  });

  it('applies edits in chain order, each one on its own', () => {
    const edit = m('ed', 'ledger.edit', {
      v: 1,
      edits: [
        { target: e1.id, memo: 'Thanksgiving', splits: { '2': A.groceries } },
        { target: e1.id, splits: { '0': A.visa } }, // asset: ignored
        { target: e1.id, splits: { '7': A.dining } }, // no such split: ignored
        { target: msg('nope'), memo: 'x' }, // unknown target: ignored
        { target: e1.id, import_ids: { '0': lbl('row') } },
        { target: e1.id, import_ids: { '0': lbl('other') } }, // already set: ignored
      ],
    });
    const seg = foldSegment('journal-2026', [e1, edit], { chart });
    const view = seg.entries.get(e1.id)!;
    expect(view.memo).toBe('Thanksgiving');
    expect(view.accounts).toEqual([A.checking, A.groceries, A.groceries]);
    expect(view.importIds[0]).toBe(lbl('row'));
    expect(seg.anomalies.map((a) => a.edit)).toEqual([1, 2, 3, 5]);
    const b = balances([seg]);
    expect(cents(b, A.groceries)).toBe(8423n);
    expect(cents(b, A.dining)).toBe(0n);
  });

  it('memo edits clear with null; receipts are replaced', () => {
    const blob = { blob: `B${'b'.repeat(43)}`, dek: 'k'.repeat(43) };
    const withMemo = m('wm', 'ledger.entry', entry('2026-01-02', [usd(A.checking, -1), usd(A.dining, 1)], { memo: 'm', receipts: [blob] }));
    const edit = m('ed', 'ledger.edit', { v: 1, edits: [{ target: withMemo.id, memo: null, receipts: [] }] });
    const view = foldSegment('journal-2026', [withMemo, edit], { chart }).entries.get(withMemo.id)!;
    expect(view.memo).toBeUndefined();
    expect(view.receipts).toEqual([]);
  });

  it('locks positionally: split edits after a cited head are ignored, memo edits are not', () => {
    const later = m('e2', 'ledger.entry', entry('2026-09-20', [usd(A.checking, -500), usd(A.dining, 500)]));
    const edit = m('ed', 'ledger.edit', {
      v: 1,
      edits: [
        { target: e1.id, splits: { '1': A.dining } }, // e1 is at or before the head: locked
        { target: e1.id, memo: 'still fine' },
        { target: later.id, splits: { '1': A.groceries } }, // after the head: unlocked
      ],
    });
    const seg = foldSegment('journal-2026', [e1, later, edit], { chart, lockHeads: [e1.id] });
    expect(seg.anomalies.map((a) => [a.edit, a.detail])).toEqual([[0, 'target is locked']]);
    expect(seg.entries.get(e1.id)!.memo).toBe('still fine');
    expect(seg.entries.get(later.id)!.accounts[1]).toBe(A.groceries);
  });

  it('a lock cited after the edit does not affect it', () => {
    const edit = m('ed', 'ledger.edit', { v: 1, edits: [{ target: e1.id, splits: { '1': A.dining } }] });
    const seg = foldSegment('journal-2026', [e1, edit], { chart, lockHeads: [edit.id] });
    expect(seg.anomalies).toEqual([]);
  });

  it('split edits on reversed entries are ignored', () => {
    const rev = m('rv', 'ledger.reversal', {
      v: 1, date: '2026-09-14', reverses: e1.id,
      splits: [usd(A.checking, 8423), usd(A.groceries, -6112), usd(A.dining, -2311)],
    });
    const edit = m('ed', 'ledger.edit', { v: 1, edits: [{ target: e1.id, splits: { '1': A.dining } }] });
    const seg = foldSegment('journal-2026', [e1, rev, edit], { chart });
    expect(seg.anomalies[0].detail).toBe('target is reversed');
    const b = balances([seg]);
    expect(cents(b, A.checking)).toBe(0n);
    expect(cents(b, A.groceries)).toBe(0n);
    expect(reversalAnomalies([seg])).toEqual([]);
  });

  it('ignores messages after a final close', () => {
    const seg = foldSegment('journal-2026', [pay, e1], { chart, finalHeads: [pay.id] });
    expect([...seg.entries.keys()]).toEqual([pay.id]);
    expect(seg.anomalies[0].kind).toBe('after-final-close');
  });
});

describe('cross-segment', () => {
  it('flags reversals that are not the inverse, and double reversals', () => {
    const s2025 = foldSegment('journal-2025', [m('old', 'ledger.entry', entry('2025-12-30', [usd(A.checking, -100), usd(A.dining, 100)]))], { chart });
    const rev = (name: string, amt: number) =>
      m(name, 'ledger.reversal', { v: 1, date: '2026-01-02', reverses: msg('old'), splits: [usd(A.checking, amt), usd(A.dining, -amt)] });
    const s2026 = foldSegment('journal-2026', [rev('r1', 100), rev('r2', 90)], { chart });
    expect(reversalAnomalies([s2025, s2026]).map((a) => a.kind)).toEqual(['reversed-twice', 'reversal-mismatch']);
  });

  it('balances respect a date window', () => {
    const seg = foldSegment('journal-2026', [pay, e1], { chart });
    expect(cents(balances([seg], { from: '2026-09-10' as never }), A.checking)).toBe(-8423n);
    expect(cents(balances([seg], { to: '2026-09-10' as never }), A.checking)).toBe(100000n);
  });

  it('import consumption and reuse', () => {
    const a = m('a', 'ledger.entry', entry('2026-01-01', [usd(A.checking, -1, { import_id: lbl('x') }), usd(A.dining, 1)]));
    const b = m('b', 'ledger.entry', entry('2026-01-02', [usd(A.checking, -1, { import_id: lbl('y') }), usd(A.dining, 1)]));
    const d = m('d', 'ledger.dismiss', { v: 1, import_ids: [lbl('y'), lbl('z')] });
    const d2 = m('d2', 'ledger.dismiss', { v: 1, import_ids: [lbl('z')] });
    const c = importConsumption([foldSegment('journal-2026', [a, b, d, d2], { chart })]);
    expect([...c.consumed.keys()].sort()).toEqual([lbl('x'), lbl('y'), lbl('z')].sort());
    expect(c.anomalies.map((x) => x.detail)).toEqual([`import label ${lbl('y')} is used 2 times`]);
  });
});

describe('foldLots', () => {
  const vti = (qty: number, extra: object = {}) => ({ account: A.vti, amount: String(qty), exp: 0, cur: 'VTI', ...extra });
  const tvti = (qty: number) => ({ account: A.tradingVti, amount: String(qty), exp: 0, cur: 'VTI' });
  const buy = m('buy', 'ledger.entry', entry('2026-01-05', [
    vti(7, { cost: { amount: '100000', exp: 2, cur: 'USD' }, acquired: '2026-01-05' }),
    tvti(-7), usd(A.tradingUsd, 100000), usd(A.checking, -100000),
  ]));
  const lot = `${buy.id}#0`;
  const sell = (name: string, date: string, qty: number, basis: number) =>
    m(name, 'ledger.entry', entry(date, [
      vti(-qty, { from_lots: [{ lot, qty: String(qty), acquired: '2026-01-05', basis: { amount: String(basis), exp: 2, cur: 'USD' } }] }),
      tvti(qty), usd(A.tradingUsd, -basis), usd(A.checking, basis),
    ]));

  it('checks draws in date order and conserves basis', () => {
    // Posted out of date order: the fold sorts by date.
    const seg = foldSegment('journal-2026', [buy, sell('s2', '2026-03-01', 3, 42857), sell('s1', '2026-02-01', 3, 42857), sell('s3', '2026-04-01', 1, 14286)], { chart });
    const fold = foldLots([seg], { complete: true });
    expect(fold.anomalies).toEqual([]);
    const l = fold.lots.get(lot as never)!;
    expect(l.qty.amount).toBe(0n);
    expect(l.basis.amount).toBe(0n);
    expect(openLots(fold)).toEqual([]);
  });

  it('flags a wrong basis once and keeps checking against the posted state', () => {
    const seg = foldSegment('journal-2026', [buy, sell('s1', '2026-02-01', 3, 50000), sell('s2', '2026-03-01', 4, 50000)], { chart });
    const fold = foldLots([seg], { complete: true });
    expect(fold.anomalies.map((a) => a.msg)).toEqual([msg('s1')]);
  });

  it('flags oversold and unknown lots; voided lots do not exist', () => {
    const seg = foldSegment('journal-2026', [buy, sell('s1', '2026-02-01', 8, 100000)], { chart });
    expect(foldLots([seg], { complete: true }).anomalies[0].detail).toContain('oversold');

    const rev = m('rv', 'ledger.reversal', {
      v: 1, date: '2026-01-06', reverses: buy.id,
      splits: [vti(-7), tvti(7), usd(A.tradingUsd, -100000), usd(A.checking, 100000)],
    });
    const voidedSeg = foldSegment('journal-2026', [buy, rev, sell('s1', '2026-02-01', 3, 42857)], { chart });
    expect(foldLots([voidedSeg], { complete: true }).anomalies[0].detail).toContain('unknown');
    expect(foldLots([voidedSeg], { complete: false }).anomalies).toEqual([]);
  });

  it('applies a stock split by date, and moves the account balance', () => {
    const split = m('split', 'ledger.lotadjust', {
      v: 1, date: '2026-02-15',
      adjustments: [{ lot, account: A.vti, exp: 0, cur: 'VTI', old_qty: '7', new_qty: '14' }],
    });
    // A 2:1 split of 7, then a draw of 3: ROUNDING.md's single-case vector.
    const seg = foldSegment('journal-2026', [buy, split, sell('s1', '2026-03-01', 3, 21428)], { chart });
    const fold = foldLots([seg], { complete: true });
    expect(fold.anomalies).toEqual([]);
    expect(fold.lots.get(lot as never)!.qty).toEqual({ amount: 11n, exp: 0 });
    expect(balanceOf(balances([seg]), A.vti, VTI).amount).toBe(11n);
  });
});

describe('budget', () => {
  const keys = deriveLabelKeys(new Uint8Array(32), `S${'A'.repeat(43)}`);
  const idem = allocationLabel(keys, A.envGroceries, '2026-09' as Month);
  const alloc = (name: string, envelope: string, amount: number, extra: object = {}) =>
    m(name, 'ledger.allocation', { v: 1, date: '2026-09-01', envelope, amount: String(amount), exp: 2, cur: 'USD', ...extra });

  it('dedupes materialized allocations by idem and rejects non-envelopes', () => {
    const fold = foldBudget(
      [alloc('a1', A.envGroceries, 60000, { idem }), alloc('a2', A.envGroceries, 60000, { idem }), alloc('a3', A.checking, 1)],
      chart,
    );
    expect(fold.allocations.map((a) => a.id)).toEqual([msg('a1')]);
    expect(fold.anomalies.map((a) => a.kind)).toEqual(['invalid']);
    expect(fold.allocated.get(A.envGroceries)!.amount).toBe(60000n);
  });

  it('To Be Budgeted is unchanged by spending from an envelope, even on a card', () => {
    // Paycheck 1000, allocate 600 to groceries, spend 550: TBB stays 400.
    const seg = foldSegment('journal-2026', [
      m('pay', 'ledger.entry', entry('2026-09-01', [usd(A.checking, 100000), usd(A.salary, -100000)])),
      m('shop', 'ledger.entry', entry('2026-09-02', [usd(A.checking, -30000), usd(A.groceries, 30000)])),
      m('card', 'ledger.entry', entry('2026-09-03', [usd(A.visa, -25000), usd(A.groceries, 25000)])),
    ], { chart });
    const b = balances([seg]);
    const budget = foldBudget([alloc('a1', A.envGroceries, 60000)], chart);
    const avail = envelopeAvailable(chart, budget.allocated, b);
    expect(avail.get(A.envGroceries)!.amount).toBe(5000n);
    expect(avail.get(A.envDining)!.amount).toBe(0n);
    expect(toBeBudgeted(chart, b, avail).get(USD)!.amount).toBe(40000n);
  });
});
