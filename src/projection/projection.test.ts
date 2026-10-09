import init, { type Database } from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { commodity } from '@/core/amount.js';
import { ChainBrokenError } from '@/core/chain.js';
import { chartOf } from '@/core/chart.js';
import { balances, balanceOf } from '@/core/fold/ledger.js';
import { foldSegment, type RawMessage } from '@/core/fold/segment.js';
import { stringifyJson } from '@/core/json.js';
import type { MsgId } from '@/core/ids.js';
import { encodeState } from '@/core/messages.js';
import { A, accountsDoc, budgetDoc, day, E, entry, lbl, msg, usd } from '@/core/testing.js';
import { Projection, PROJECTION_VERSION, type LogMessage } from './projection.js';

const USD = commodity('USD');
const SENDER = 'U-test';

let sqlite: Awaited<ReturnType<typeof init>>;
beforeAll(async () => {
  sqlite = await init();
});

const memoryDb = (): Database => new sqlite.oo1.DB(':memory:');

/** Builds one topic's chain: each message links to the one before. */
function chain(start = 1000) {
  let prev: string | null = null;
  let ts = start;
  return (name: string, type: string, data: unknown): LogMessage => {
    const m = { hash: msg(name), prev, type, sender: SENDER, ts: ts++, body: stringifyJson(data) };
    prev = m.hash;
    return m;
  };
}

const toRaw = (m: LogMessage): RawMessage => ({ id: m.hash as RawMessage['id'], type: m.type, data: JSON.parse(m.body!) });

function stateWith(next = chain(1)) {
  return [
    next('s-acct', 'ledger/accounts', JSON.parse(encodeState('ledger/accounts', accountsDoc))),
    next('s-journal', 'ledger/journal', { v: 1, rev: 1, years: [2025, 2026] }),
  ];
}

const cents = (p: Projection, account: (typeof A)[keyof typeof A]) => balanceOf(p.balances(), account, USD).amount;

describe('Projection', () => {
  it('folds a segment into balances and registers', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const pay = j('pay', 'ledger.entry', entry('2026-09-01', [usd(A.checking, 100000), usd(A.salary, -100000)]));
    const food = j('food', 'ledger.entry', entry('2026-08-14', [usd(A.checking, -8423), usd(A.groceries, 8423)], { memo: 'market' }));
    expect(p.append('journal-2026', [pay, food])).toBe(2);

    expect(cents(p, A.checking)).toBe(100000n - 8423n);
    expect(cents(p, A.groceries)).toBe(8423n);
    expect(p.years()).toEqual([2025, 2026]);

    const reg = p.register(A.checking);
    expect(reg.map((l) => l.txn)).toEqual([food.hash, pay.hash]); // by date, not chain order
    expect(reg[0]).toMatchObject({ kind: 'entry', date: '2026-08-14', memo: 'market', index: 1, ts: food.ts });
    expect(reg[0].amount).toEqual({ amount: -8423n, exp: 2, cur: USD });
  });

  it('gives each register line its running balance and the other accounts', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const y25 = chain(500);
    const open = y25('open', 'ledger.entry', entry('2025-12-31', [usd(A.checking, 50000), usd(A.equity, -50000)]));
    const shop = j('shop', 'ledger.entry', entry('2026-03-02', [
      usd(A.checking, -6000), usd(A.groceries, 4000), usd(A.dining, 1500), usd(A.groceries, 500),
    ]));
    const pay = j('pay', 'ledger.entry', entry('2026-03-01', [usd(A.checking, 100000), usd(A.salary, -100000)]));
    // Same date as `shop`, later in the chain.
    const back = j('back', 'ledger.entry', entry('2026-03-02', [usd(A.checking, 700), usd(A.checking, -200), usd(A.dining, -500)]));
    p.append('journal-2026', [shop, pay, back]);
    p.append('journal-2025', [open]);

    const reg = p.register(A.checking);
    expect(reg.map((l) => [l.txn, l.split])).toEqual([
      [open.hash, 0], [pay.hash, 0], [shop.hash, 0], [back.hash, 0], [back.hash, 1],
    ]);
    expect(reg.map((l) => l.balance.amount)).toEqual([50000n, 150000n, 144000n, 144700n, 144500n]);
    expect(reg.at(-1)!.balance).toEqual(balanceOf(p.balances(), A.checking, USD));
    expect(reg[2].others).toEqual([A.groceries, A.dining]); // each once, in split order
    expect(reg[3].others).toEqual([A.dining]); // not the account itself
    expect(p.register(A.groceries).map((l) => l.balance.amount)).toEqual([4000n, 4500n]);
  });

  it('skips messages it already has and refuses a broken chain', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const a = j('a', 'ledger.entry', entry('2026-01-01', [usd(A.checking, 1), usd(A.salary, -1)]));
    const b = j('b', 'ledger.entry', entry('2026-01-02', [usd(A.checking, 2), usd(A.salary, -2)]));
    const c = j('c', 'ledger.entry', entry('2026-01-03', [usd(A.checking, 4), usd(A.salary, -4)]));

    expect(p.append('journal-2026', [a])).toBe(1);
    // A page fetched from the watermark's timestamp repeats the head; order doesn't matter.
    expect(p.append('journal-2026', [b, a])).toBe(1);
    expect(p.append('journal-2026', [b])).toBe(0);
    expect(p.watermark('journal-2026')).toEqual({ head: b.hash, ts: b.ts, count: 2 });

    const d = j('d', 'ledger.entry', entry('2026-01-04', [usd(A.checking, 8), usd(A.salary, -8)]));
    expect(() => p.append('journal-2026', [d])).toThrow(ChainBrokenError); // c is missing
    expect(p.watermark('journal-2026')?.head).toBe(b.hash);
    expect(cents(p, A.checking)).toBe(3n);

    p.append('journal-2026', [c, d]);
    expect(cents(p, A.checking)).toBe(15n);
    expect(() => p.append('journal-2026', [j('fork', 'ledger.entry', {}), { ...a, hash: msg('other'), prev: null }]))
      .toThrow(ChainBrokenError);
    expect(() => p.append('import-staging', [])).toThrow(RangeError);
  });

  it('refolds every segment when the chart changes', () => {
    const p = Projection.open(memoryDb());
    const s = chain(1);
    const j = chain();
    p.append('journal-2026', [j('pay', 'ledger.entry', entry('2026-09-01', [usd(A.checking, 500), usd(A.salary, -500)]))]);
    // No chart yet, so the accounts don't resolve.
    expect(p.balances().size).toBe(0);
    expect(p.anomalies().map((a) => a.kind)).toEqual(['invalid']);

    p.append('state', [s('s-acct', 'ledger/accounts', JSON.parse(encodeState('ledger/accounts', accountsDoc)))]);
    expect(cents(p, A.checking)).toBe(500n);
    expect(p.anomalies()).toEqual([]);
  });

  it('applies edits, and reports anomalies and halts by topic', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const food = j('food', 'ledger.entry', entry('2026-02-01', [usd(A.checking, -900), usd(A.groceries, 900)]));
    const edit = j('edit', 'ledger.edit', {
      v: 1,
      edits: [{ target: food.hash, memo: 'takeout', splits: { '1': A.dining } }, { target: food.hash, splits: { '0': A.visa } }],
    });
    p.append('journal-2026', [food]);
    p.append('journal-2026', [edit]); // rewrites the target's row too
    expect(p.register(A.groceries)).toEqual([]);
    expect(p.register(A.dining)).toMatchObject([{ txn: food.hash, memo: 'takeout' }]);
    expect(p.anomalies()).toEqual([
      { topic: 'journal-2026', kind: 'edit-ignored', msg: edit.hash, edit: 1, detail: expect.any(String) },
    ]);

    const future = j('future', 'ledger.entry', { v: 2 });
    p.append('journal-2026', [future]);
    expect(p.halts()).toEqual([{ topic: 'journal-2026', at: future.hash, reason: expect.any(String) }]);
  });

  it('gives an edit target its effective fields', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const receipt = { blob: `B${'r'.repeat(43)}`, dek: 'k'.repeat(43) };
    const food = j('food', 'ledger.entry', entry('2026-02-01', [usd(A.checking, -900), usd(A.groceries, 900)], { memo: 'market' }));
    p.append('journal-2026', [food]);
    expect(p.editTarget(food.hash as MsgId)).toMatchObject({ year: 2026, memo: 'market', receipts: [], locked: false });
    expect(p.editTarget(food.hash as MsgId)).not.toHaveProperty('payee');

    p.append('journal-2026', [
      j('edit', 'ledger.edit', { v: 1, edits: [{ target: food.hash, memo: null, receipts: [receipt], splits: { '1': A.dining } }] }),
    ]);
    const t = p.editTarget(food.hash as MsgId)!;
    expect(t).not.toHaveProperty('memo');
    expect(t).toMatchObject({ accounts: [A.checking, A.dining], receipts: [receipt] });
    expect(p.editTarget(msg('nothing'))).toBeUndefined();
  });

  it('records reversals in both registers and links them', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const food = j('food', 'ledger.entry', entry('2026-02-01', [usd(A.checking, -900), usd(A.groceries, 900)]));
    const rev = j('rev', 'ledger.reversal', {
      v: 1, date: '2026-02-01', reverses: food.hash, splits: [usd(A.checking, 900), usd(A.groceries, -900)],
    });
    p.append('journal-2026', [food]);
    p.append('journal-2026', [rev]);
    expect(cents(p, A.checking)).toBe(0n);
    expect(p.register(A.checking)).toMatchObject([
      { txn: food.hash, kind: 'entry', reversedBy: rev.hash },
      { txn: rev.hash, kind: 'reversal', reverses: food.hash },
    ]);
  });

  it('links a reversal in a later segment, and keeps rows an edit there cannot touch', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const food = chain(500)('food', 'ledger.entry', entry('2025-12-30', [usd(A.checking, -900), usd(A.groceries, 900)]));
    p.append('journal-2025', [food]);
    const j = chain();
    const rev = j('rev', 'ledger.reversal', {
      v: 1, date: '2026-01-05', reverses: food.hash, splits: [usd(A.checking, 900), usd(A.groceries, -900)],
    });
    // An edit may only name an entry in its own segment; this one is ignored.
    const edit = j('edit', 'ledger.edit', { v: 1, edits: [{ target: food.hash, memo: 'x' }] });
    p.append('journal-2026', [rev]);
    p.append('journal-2026', [edit]);

    const reg = p.register(A.checking, true); // different dates: nothing collapses
    expect(reg).toMatchObject([
      { txn: food.hash, reversedBy: rev.hash, balance: { amount: -900n } },
      { txn: rev.hash, reverses: food.hash, balance: { amount: 0n } },
    ]);
    expect(p.reversalTarget(food.hash as MsgId)).toMatchObject({ reversedBy: rev.hash });
  });

  it('collapses a same-day reversal into its net, and lets a replacement stand for the pair', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const pay = j('pay', 'ledger.entry', entry('2026-02-01', [usd(A.checking, 5000), usd(A.salary, -5000)]));
    const food = j('food', 'ledger.entry', entry('2026-02-01', [usd(A.checking, -900), usd(A.groceries, 900)]));
    const coffee = j('coffee', 'ledger.entry', entry('2026-02-01', [usd(A.checking, -300), usd(A.dining, 300)]));
    const rev = j('rev', 'ledger.reversal', {
      v: 1, date: '2026-02-01', reverses: food.hash, splits: [usd(A.checking, 900), usd(A.groceries, -900)],
    });
    p.append('journal-2026', [pay, food, coffee, rev]);

    expect(p.register(A.checking)).toHaveLength(4); // as posted
    const reg = p.register(A.checking, true);
    expect(reg.map((l) => [l.txn, l.amount.amount, l.balance.amount])).toEqual([
      [pay.hash, 5000n, 5000n],
      [coffee.hash, -300n, 4700n],
      [food.hash, 0n, 4700n], // in the reversal's place
    ]);
    expect(reg[2]).toMatchObject({ kind: 'entry', collapsed: true, reversedBy: rev.hash, others: [A.groceries] });

    const fixed = j('fixed', 'ledger.entry', entry('2026-02-02', [usd(A.checking, -950), usd(A.groceries, 950)], { replaces: food.hash }));
    p.append('journal-2026', [fixed]);
    expect(p.register(A.checking, true).map((l) => l.txn)).toEqual([pay.hash, coffee.hash, fixed.hash]);
    expect(p.register(A.checking, true).at(-1)).toMatchObject({ replaces: food.hash, balance: { amount: 3750n } });
    expect(p.register(A.checking).find((l) => l.txn === food.hash)).toMatchObject({ replacedBy: fixed.hash });
    expect(p.reversalTarget(food.hash as MsgId)).toMatchObject({ reversedBy: rev.hash, replacedBy: fixed.hash });
  });

  it('finds a reversal target with its effective accounts, lock, and freeze', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const food = j('food', 'ledger.entry', entry('2026-02-01', [usd(A.checking, -900), usd(A.groceries, 900)]));
    const edit = j('edit', 'ledger.edit', { v: 1, edits: [{ target: food.hash, splits: { '1': A.dining } }] });
    const later = j('later', 'ledger.entry', entry('2026-03-01', [usd(A.checking, -1), usd(A.dining, 1)]));
    p.append('journal-2026', [food, edit, later]);

    expect(p.reversalTarget(food.hash as MsgId)).toEqual({
      id: food.hash,
      date: '2026-02-01',
      splits: [
        { account: A.checking, amount: -900n, exp: 2, cur: USD },
        { account: A.dining, amount: 900n, exp: 2, cur: USD },
      ],
      accounts: [A.checking, A.dining],
      locked: false,
      segmentOpen: true,
    });
    expect(p.reversalTarget(edit.hash as MsgId)).toBeUndefined();
    expect(p.segmentOpen(2026)).toBe(true);

    p.append('checkpoints', [
      chain(50)('close', 'ledger.checkpoint', { v: 1, period: '2026-02', rounding: 'floor-v1', heads: [{ topic: 'journal-2026', hash: edit.hash }] }),
    ]);
    expect(p.reversalTarget(food.hash as MsgId)).toMatchObject({ locked: true, segmentOpen: true });
    expect(p.reversalTarget(later.hash as MsgId)).toMatchObject({ locked: false });

    p.append('checkpoints', [
      chain(60)('final', 'ledger.checkpoint', { v: 1, period: '2026-12', rounding: 'floor-v1', heads: [{ topic: 'journal-2026', hash: later.hash, final: true }] }),
    ].map((m) => ({ ...m, prev: msg('close') })));
    expect(p.reversalTarget(later.hash as MsgId)).toMatchObject({ locked: true, segmentOpen: false });
    expect(p.segmentOpen(2026)).toBe(false);
  });

  it('reports reversal anomalies across segments', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const food = chain(500)('food', 'ledger.entry', entry('2025-12-30', [usd(A.checking, -900), usd(A.groceries, 900)]));
    p.append('journal-2025', [food]);
    const j = chain();
    const splits = [usd(A.checking, 900), usd(A.groceries, -900)];
    const rev1 = j('rev1', 'ledger.reversal', { v: 1, date: '2026-01-05', reverses: food.hash, splits });
    const rev2 = j('rev2', 'ledger.reversal', {
      v: 1, date: '2026-01-06', reverses: food.hash, splits: [usd(A.checking, 900), usd(A.dining, -900)],
    });
    p.append('journal-2026', [rev1, rev2]);
    expect(p.anomalies()).toEqual([
      { topic: 'journal-2026', kind: 'reversed-twice', msg: rev2.hash, detail: expect.any(String) },
      { topic: 'journal-2026', kind: 'reversal-mismatch', msg: rev2.hash, detail: expect.any(String) },
    ]);
    // Both still fold.
    expect(cents(p, A.checking)).toBe(900n);
  });

  it('derives consumed import labels from splits, edits, and dismissals in any segment', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const [a, b, c, d] = [lbl('a'), lbl('b'), lbl('c'), lbl('d')];
    const old = chain(500);
    p.append('journal-2025', [
      old('o1', 'ledger.entry', entry('2025-12-30', [usd(A.checking, -900, { import_id: a }), usd(A.groceries, 900)])),
    ]);
    const j = chain();
    const hand = j('hand', 'ledger.entry', entry('2026-01-02', [usd(A.checking, -500), usd(A.dining, 500)]));
    p.append('journal-2026', [hand, j('dis', 'ledger.dismiss', { v: 1, import_ids: [b] })]);
    expect(p.consumed([a, b, c, d])).toEqual(new Set([a, b]));
    expect(p.editTarget(hand.hash as MsgId)!.importIds).toEqual([undefined, undefined]);

    // A match: the hand-entered entry's checking split is the row `c`.
    p.append('journal-2026', [j('match', 'ledger.edit', { v: 1, edits: [{ target: hand.hash, import_ids: { '0': c } }] })]);
    expect(p.consumed([a, b, c, d])).toEqual(new Set([a, b, c]));
    expect(p.editTarget(hand.hash as MsgId)!.importIds).toEqual([c, undefined]);
    expect(p.anomalies()).toEqual([]);

    // `a` again, in another segment, and `b` both dismissed and on a split.
    const again = j('again', 'ledger.entry', entry('2026-01-03', [
      usd(A.checking, -900, { import_id: a }), usd(A.groceries, 900, { import_id: b }),
    ]));
    p.append('journal-2026', [again]);
    expect(p.anomalies()).toEqual([
      { topic: 'journal-2026', kind: 'import-id-reused', msg: again.hash, detail: `import label ${a} is used 2 times` },
      { topic: 'journal-2026', kind: 'import-id-reused', msg: again.hash, detail: `import label ${b} is used 2 times` },
    ]);
    // Twice dismissed is no anomaly.
    const q = Projection.open(memoryDb());
    q.append('state', stateWith());
    const k = chain();
    q.append('journal-2026', [k('d1', 'ledger.dismiss', { v: 1, import_ids: [d] }), k('d2', 'ledger.dismiss', { v: 1, import_ids: [d] })]);
    expect(q.anomalies()).toEqual([]);
    expect(q.consumed([d])).toEqual(new Set([d]));
  });

  it('lists the splits an import may match or replace', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const hand = j('hand', 'ledger.entry', entry('2026-09-12', [usd(A.checking, -500), usd(A.dining, 300), usd(A.groceries, 200)], { memo: 'coffee' }));
    const pending = j('pending', 'ledger.entry', entry('2026-09-14', [usd(A.checking, -2000, { import_id: lbl('p') }), usd(A.dining, 2000)]));
    const gone = j('gone', 'ledger.entry', entry('2026-09-15', [usd(A.checking, -100), usd(A.dining, 100)]));
    const late = j('late', 'ledger.entry', entry('2026-10-20', [usd(A.checking, -100), usd(A.dining, 100)]));
    const rev = j('rev', 'ledger.reversal', { v: 1, date: '2026-09-15', reverses: gone.hash, splits: [usd(A.checking, 100), usd(A.dining, -100)] });
    p.append('journal-2026', [hand, pending, gone, late, rev]);

    const splits = p.importSplits(A.checking, day('2026-09-01'), day('2026-09-30'));
    // Reversed entries and reversals are left out, and so is anything outside the dates.
    expect(splits).toEqual([
      { txn: hand.hash, split: 0, date: '2026-09-12', amount: { amount: -500n, exp: 2, cur: USD }, others: [A.dining, A.groceries], memo: 'coffee' },
      { txn: pending.hash, split: 0, date: '2026-09-14', amount: { amount: -2000n, exp: 2, cur: USD }, others: [A.dining], importId: lbl('p') },
    ]);
  });

  it('locks entries at or before a checkpoint head', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const food = j('food', 'ledger.entry', entry('2026-02-01', [usd(A.checking, -900), usd(A.groceries, 900)]));
    p.append('journal-2026', [food]);
    p.append('checkpoints', [
      chain(50)('close', 'ledger.checkpoint', { v: 1, period: '2026-02', rounding: 'floor-v1', heads: [{ topic: 'journal-2026', hash: food.hash }] }),
    ]);
    p.append('journal-2026', [j('edit', 'ledger.edit', { v: 1, edits: [{ target: food.hash, splits: { '1': A.dining } }] })]);
    expect(p.register(A.groceries)).toHaveLength(1);
    expect(p.anomalies()).toMatchObject([{ kind: 'edit-ignored', detail: 'target is locked' }]);
  });

  it('finds the accounts that standing opening entries already open', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const y25 = chain(500);
    const j = chain();
    const first = y25('first', 'ledger.entry', entry('2025-12-31', [usd(A.checking, 50000), usd(A.visa, -2000), usd(A.equity, -48000)]));
    const pay = j('pay', 'ledger.entry', entry('2026-01-02', [usd(A.checking, 1000), usd(A.salary, -1000)]));
    const again = j('again', 'ledger.entry', entry('2026-01-03', [usd(A.checking, 700), usd(A.equity, -700)]));
    const undone = j('undone', 'ledger.entry', entry('2026-01-04', [usd(A.visa, -300), usd(A.equity, 300)]));
    const rev = j('rev', 'ledger.reversal', {
      v: 1, date: '2026-01-05', reverses: undone.hash, splits: [usd(A.visa, 300), usd(A.equity, -300)],
    });
    p.append('journal-2025', [first]);
    p.append('journal-2026', [pay, again, undone, rev]);

    expect(p.openings([A.equity])).toEqual([
      { account: A.checking, txn: first.hash, date: '2025-12-31' },
      { account: A.visa, txn: first.hash, date: '2025-12-31' },
      { account: A.checking, txn: again.hash, date: '2026-01-03' },
    ].sort((x, y) => x.date.localeCompare(y.date) || x.account.localeCompare(y.account)));
    expect(p.openings([A.tradingUsd])).toEqual([]);
    expect(p.openings([])).toEqual([]);
  });

  it('lists closes, and counts the entries a close locks past its period', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const feb = j('feb', 'ledger.entry', entry('2026-02-01', [usd(A.checking, -900), usd(A.groceries, 900)]));
    const apr = j('apr', 'ledger.entry', entry('2026-04-02', [usd(A.checking, -500), usd(A.groceries, 500)]));
    p.append('journal-2026', [feb, apr]);
    expect(p.entriesAfter(2026, day('2026-03-31'))).toBe(1);
    expect(p.entriesAfter(2026, day('2026-01-31'))).toBe(2);
    expect(p.entriesAfter(2025, day('2025-12-31'))).toBe(0);

    const c = chain(50);
    const unseen = msg('unseen');
    p.append('checkpoints', [
      c('q1', 'ledger.checkpoint', { v: 1, period: '2026-Q1', rounding: 'v1', heads: [{ topic: 'journal-2026', hash: apr.hash }] }),
      c('y25', 'ledger.checkpoint', { v: 1, period: '2025', rounding: 'v1', heads: [{ topic: 'journal-2025', hash: unseen, final: true }] }),
    ]);
    expect(p.closes()).toEqual([
      { msg: expect.any(String), period: '2026-Q1', topic: 'journal-2026', head: apr.hash, final: false, held: true },
      { msg: expect.any(String), period: '2025', topic: 'journal-2025', head: unseen, final: true, held: false },
    ]);
    // Positional: the April entry was posted before the Q1 close, so it is locked too.
    expect(p.reversalTarget(apr.hash as MsgId)).toMatchObject({ locked: true });
    expect(p.segmentOpen(2025)).toBe(false);
  });

  it('folds the budget topic against the budget document', () => {
    const p = Projection.open(memoryDb());
    const s = chain(1);
    p.append('state', [
      s('s-acct', 'ledger/accounts', JSON.parse(encodeState('ledger/accounts', accountsDoc))),
      s('s-budget', 'ledger/budget', JSON.parse(encodeState('ledger/budget', budgetDoc))),
    ]);
    const b = chain();
    p.append('budget', [
      b('al1', 'ledger.allocation', { v: 1, date: '2026-01-01', envelope: E.groceries, amount: '60000', exp: 2, cur: 'USD' }),
      b('al2', 'ledger.allocation', { v: 1, date: '2026-02-01', envelope: E.groceries, amount: '60000', exp: 2, cur: 'USD' }),
    ]);
    expect(p.allocated().get(E.groceries)).toEqual({ amount: 120000n, exp: 2, cur: USD });
    p.append('budget', [
      b('re1', 'ledger.reallocation', {
        v: 1, date: '2026-02-20', cur: 'USD',
        legs: [{ envelope: E.groceries, amount: '-10000', exp: 2 }, { envelope: E.dining, amount: '10000', exp: 2 }],
      }),
    ]);

    const j = chain();
    p.append('journal-2026', [
      j('shop', 'ledger.entry', entry('2026-02-14', [usd(A.checking, -8423), usd(A.groceries, 8423)])),
      j('eat', 'ledger.entry', entry('2026-02-15', [usd(A.checking, -2311), usd(A.dining, 2311)])),
    ]);
    expect(p.available()).toEqual(new Map([
      [E.groceries, { amount: 110000n - 8423n, exp: 2, cur: USD }],
      [E.dining, { amount: 10000n - 2311n, exp: 2, cur: USD }],
    ]));
    // Checking is budgetable and down 8423 + 2311; the envelopes hold 120000 less the same.
    expect(p.toBeBudgeted()).toEqual(new Map([[USD, { amount: -120000n, exp: 2, cur: USD }]]));
    p.append('journal-2026', [
      j('pay', 'ledger.entry', entry('2026-02-28', [usd(A.checking, 200000), usd(A.salary, -200000)])),
    ]);
    expect(p.toBeBudgeted()).toEqual(new Map([[USD, { amount: 80000n, exp: 2, cur: USD }]]));
  });

  it('derives cleared status from standing reconciliations', () => {
    const p = Projection.open(memoryDb());
    const s = chain(1);
    p.append('state', stateWith(s));
    const j = chain();
    const pay = j('pay', 'ledger.entry', entry('2026-09-01', [usd(A.checking, 100000), usd(A.salary, -100000)]));
    const food = j('food', 'ledger.entry', entry('2026-09-14', [usd(A.checking, -8423), usd(A.checking, -100), usd(A.groceries, 8523)]));
    const undo = j('undo', 'ledger.reversal', {
      v: 1, date: '2026-09-15', reverses: food.hash,
      splits: [usd(A.checking, 8423), usd(A.checking, 100), usd(A.groceries, -8523)],
    });
    p.append('journal-2026', [pay, food, undo]);

    const recon = (date: string, balance: number, cleared: string[], extra: object = {}) => ({
      v: 1, account: A.checking, statement_date: date,
      closing_balance: { amount: String(balance), exp: 2, cur: 'USD' }, cleared, ...extra,
    });
    const r = chain();
    const sep = r('sep', 'ledger.recon', recon('2026-09-30', 91477, [pay.hash, food.hash]));
    const redo = r('redo', 'ledger.recon', recon('2026-09-30', 100000, [pay.hash, food.hash, undo.hash], { supersedes: sep.hash }));
    const twice = r('twice', 'ledger.recon', recon('2026-10-31', 100000, [pay.hash]));
    p.append('recon', [sep]);

    expect(p.reconcilable(A.checking)).toEqual(new Map([
      [pay.hash, { amount: 100000n, exp: 2, cur: USD }],
      [food.hash, { amount: -8523n, exp: 2, cur: USD }],
      [undo.hash, { amount: 8523n, exp: 2, cur: USD }],
    ]));
    // Every split on the account is cleared, and no other account's.
    const reconciled = () => p.register(A.checking).map((l) => [l.txn, l.split, l.reconciled]);
    expect(reconciled()).toEqual([
      [pay.hash, 0, sep.hash], [food.hash, 0, sep.hash], [food.hash, 1, sep.hash], [undo.hash, 0, undefined], [undo.hash, 1, undefined],
    ]);
    expect(p.register(A.groceries).every((l) => l.reconciled === undefined)).toBe(true);

    p.append('recon', [redo, twice]);
    expect(reconciled().map((x) => x[2])).toEqual([redo.hash, redo.hash, redo.hash, redo.hash, redo.hash]);
    expect(p.reconciliations(A.checking)).toEqual([
      expect.objectContaining({ id: sep.hash, statementDate: '2026-09-30', held: 2, supersededBy: redo.hash }),
      expect.objectContaining({ id: redo.hash, supersedes: sep.hash, held: 3, closingBalance: { amount: 100000n, exp: 2, cur: USD } }),
      expect.objectContaining({ id: twice.hash, cleared: [pay.hash] }),
    ]);
    expect(p.reconciliations(A.visa)).toEqual([]);
    expect(p.anomalies()).toMatchObject([{ topic: 'recon', kind: 'cleared-twice', msg: twice.hash }]);

    // Chart facts decide whether a recon counts, so a chart change refolds the topic.
    const chart = JSON.parse(encodeState('ledger/accounts', accountsDoc));
    p.append('state', [s('s-acct2', 'ledger/accounts', { ...chart, rev: 2 })]);
    expect(p.reconciliations(A.checking)).toHaveLength(3);
  });

  it('keeps the previous revision of a State document that does not decode', () => {
    const p = Projection.open(memoryDb());
    const s = chain(1);
    p.append('state', [
      ...stateWith(s),
      s('s-bad', 'ledger/accounts', { v: 1, rev: 2 }),
      // Membership and capabilities are State too, but aren't the ledger's.
      { hash: msg('auth'), prev: msg('s-bad'), type: 'auth/users/U-x', sender: SENDER, ts: 9 },
    ]);
    expect(p.doc('ledger/accounts')).toEqual(accountsDoc);
    expect(p.anomalies()).toMatchObject([{ topic: 'state', kind: 'malformed', msg: msg('s-bad') }]);
    expect(p.watermark('state')?.count).toBe(4);
  });

  it('matches the core fold, with and without a date window', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const msgs = [
      j('a', 'ledger.entry', entry('2026-01-05', [usd(A.checking, 1000), usd(A.salary, -1000)])),
      j('b', 'ledger.entry', entry('2026-03-05', [usd(A.visa, -250), usd(A.dining, 250)])),
      j('c', 'ledger.entry', entry('2026-06-05', [usd(A.checking, -400), usd(A.groceries, 400)])),
    ];
    p.append('journal-2026', msgs);
    const seg = foldSegment('journal-2026', msgs.map(toRaw), { chart: chartOf(accountsDoc) });
    expect(p.balances()).toEqual(balances([seg]));
    const window = { from: '2026-02-01', to: '2026-06-30' } as const;
    expect(p.balances(window as never)).toEqual(balances([seg], window as never));
  });

  it('reopens from its watermarks, and rebuilds on a schema change', () => {
    const db = memoryDb();
    const p = Projection.open(db);
    p.append('state', stateWith());
    const j = chain();
    const pay = j('pay', 'ledger.entry', entry('2026-09-01', [usd(A.checking, 500), usd(A.salary, -500)]));
    p.append('journal-2026', [pay]);

    // Same versions: nothing is rebuilt.
    const reopened = Projection.open(db);
    expect(reopened.watermark('journal-2026')).toEqual({ head: pay.hash, ts: pay.ts, count: 1 });
    expect(cents(reopened, A.checking)).toBe(500n);

    // A projection written by another version is dropped and refolded from the log,
    // including tables only the old version had.
    db.exec(`UPDATE meta SET value = ${PROJECTION_VERSION + 1} WHERE key = 'projection'`);
    db.exec('DELETE FROM balances');
    db.exec('CREATE TABLE stale (x)');
    const rebuilt = Projection.open(db);
    expect(cents(rebuilt, A.checking)).toBe(500n);
    expect(rebuilt.watermark('journal-2026')?.head).toBe(pay.hash);
    expect(db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name = 'stale'")).toBe(0);

    // A log written by another version is dropped entirely, so it downloads again.
    db.exec("UPDATE meta SET value = 0 WHERE key = 'log'");
    const fresh = Projection.open(db);
    expect(fresh.watermarks()).toEqual({});
    expect(fresh.balances().size).toBe(0);
  });

  it('replays 10k entries', () => {
    const p = Projection.open(memoryDb());
    p.append('state', stateWith());
    const j = chain();
    const msgs: LogMessage[] = [];
    for (let i = 0; i < 10_000; i++) {
      const date = `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
      msgs.push(j(`e${i}`, 'ledger.entry', entry(date, [usd(A.checking, -(i + 2)), usd(A.groceries, i + 1), usd(A.dining, 1)])));
    }
    let t = performance.now();
    p.append('journal-2026', msgs);
    const cold = performance.now() - t;

    t = performance.now();
    p.append('journal-2026', [j('one-more', 'ledger.entry', entry('2026-12-31', [usd(A.checking, -1), usd(A.dining, 1)]))]);
    const live = performance.now() - t;
    console.log(`10k entries: cold ${cold.toFixed(0)} ms, one more ${live.toFixed(0)} ms`);

    expect(cents(p, A.checking)).toBe(-(10_000n * 10_001n) / 2n - 10_000n - 1n);
    expect(p.anomalies()).toEqual([]);
    expect(p.register(A.dining)).toHaveLength(10_001);
  });
});
