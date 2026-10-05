import { describe, expect, it } from 'vitest';
import { commodity } from './amount.js';
import { canRecategorize, editOf, editPostProblems, packEdits, type EditTarget } from './edit.js';
import { foldSegment } from './fold/segment.js';
import type { BlobRef, BlobId, PayeeId } from './ids.js';
import { decodePayeesDoc, encodeMessage, type Edit, type Split } from './messages.js';
import { A, acct, chart, day, lbl, msg, usd } from './testing.js';

const USD = commodity('USD');
const split = (account: Split['account'], amount: bigint): Split => ({ account, amount, exp: 2, cur: USD });
const payee = (name: string) => `payee_${name.padEnd(20, 'x')}` as PayeeId;
const receipt = (name: string): BlobRef => ({ blob: `B${name.padEnd(43, 'x')}` as BlobId, dek: 'k'.repeat(43) });

/** Checking pays for groceries and dinner; the groceries split was since moved to Dining. */
const target: EditTarget = {
  id: msg('food'),
  date: day('2026-02-01'),
  year: 2026,
  splits: [split(A.checking, -1500n), split(A.groceries, 900n), split(A.dining, 600n)],
  accounts: [A.checking, A.dining, A.dining],
  locked: false,
  segmentOpen: true,
  memo: 'market',
  payee: payee('shop'),
  receipts: [receipt('one')],
  importIds: [undefined, undefined, undefined],
};

const payees = decodePayeesDoc(
  { v: 1, rev: 1, payees: { [payee('shop')]: { name: 'Shop' }, [payee('cafe')]: { name: 'Cafe' } } },
  '',
);

describe('editOf', () => {
  it('names only the fields that differ from their effective values', () => {
    expect(editOf(target, { memo: ' market ', payee: payee('shop'), receipts: [receipt('one')] })).toBeUndefined();
    expect(editOf(target, { splits: new Map([[1, A.dining]]) })).toBeUndefined();
    expect(editOf(target, { memo: 'farmers market', splits: new Map([[2, A.groceries], [1, A.dining]]) })).toEqual({
      target: target.id,
      memo: 'farmers market',
      splits: { '2': A.groceries },
    });
  });

  it('clears with null and an empty receipt list', () => {
    const edit = editOf(target, { memo: '  ', payee: null, receipts: [] });
    expect(edit).toEqual({ target: target.id, memo: null, payee: null, receipts: [] });
    expect(() => encodeMessage('ledger.edit', { v: 1, edits: [edit!] })).not.toThrow();
    const bare = { ...target, memo: undefined, payee: undefined, receipts: [] };
    expect(editOf(bare, { memo: '', payee: null, receipts: [] })).toBeUndefined();
  });
});

describe('canRecategorize', () => {
  it('allows only nominal splits of an open, unreversed entry', () => {
    expect([0, 1, 2].map((i) => canRecategorize(target, chart, i))).toEqual([false, true, true]);
    expect(canRecategorize({ ...target, locked: true }, chart, 1)).toBe(false);
    expect(canRecategorize({ ...target, reversedBy: msg('rev') }, chart, 1)).toBe(false);
  });
});

describe('editPostProblems', () => {
  const ctx = { chart, payees, target };
  const recat: Edit = { target: target.id, splits: { '1': A.groceries } };

  it('accepts recategorization between nominal accounts, and any annotation', () => {
    expect(editPostProblems(recat, ctx)).toEqual([]);
    expect(editPostProblems({ target: target.id, splits: { '1': A.salary } }, ctx)).toEqual([]);
    expect(editPostProblems({ target: target.id, memo: 'x', payee: payee('cafe'), receipts: [] }, ctx)).toEqual([]);
  });

  it('refuses an unknown target', () => {
    expect(editPostProblems(recat, { ...ctx, target: undefined })).toEqual(['the edited message is not a known entry']);
    expect(editPostProblems({ ...recat, target: msg('other') }, ctx)).toEqual(['the edited message is not a known entry']);
  });

  it('refuses moving an asset split, or moving to an asset, another currency, or a closed account', () => {
    expect(editPostProblems({ target: target.id, splits: { '0': A.dining } }, ctx))
      .toEqual(['split 0: only income and expense accounts can be recategorized']);
    expect(editPostProblems({ target: target.id, splits: { '1': A.visa } }, ctx))
      .toEqual(['split 1: only income and expense accounts can be recategorized']);
    const eur = new Map(chart).set(acct('travel'), { name: 'Travel', type: 'expense', cur: commodity('EUR'), parent: null });
    expect(editPostProblems({ target: target.id, splits: { '1': acct('travel') } }, { ...ctx, chart: eur }))
      .toEqual(['split 1: new account holds EUR']);
    expect(editPostProblems({ target: target.id, splits: { '1': A.rent } }, ctx)).toEqual(['split 1: account is closed']);
    expect(editPostProblems({ target: target.id, splits: { '3': A.rent } }, ctx)).toContain('no split 3');
  });

  it('refuses recategorizing a locked or reversed entry, but not annotating one', () => {
    const memo: Edit = { target: target.id, memo: 'x' };
    for (const t of [{ ...target, locked: true }, { ...target, reversedBy: msg('rev') }]) {
      expect(editPostProblems(recat, { ...ctx, target: t })).toHaveLength(1);
      expect(editPostProblems(memo, { ...ctx, target: t })).toEqual([]);
    }
  });

  it('refuses an unknown payee and a frozen segment', () => {
    expect(editPostProblems({ target: target.id, payee: payee('nobody') }, ctx)).toEqual(['unknown payee']);
    expect(editPostProblems({ target: target.id, payee: payee('nobody') }, { ...ctx, payees: undefined })).toEqual([]);
    expect(editPostProblems({ target: target.id, memo: 'x' }, { ...ctx, target: { ...target, segmentOpen: false } }))
      .toEqual(['journal-2026 is frozen']);
  });

  it('sets an import label only on an unconfirmed split, and only if the row is unconsumed', () => {
    const row = lbl('row');
    const match: Edit = { target: target.id, import_ids: { '0': row } };
    expect(editPostProblems(match, { ...ctx, consumed: new Set() })).toEqual([]);
    expect(editPostProblems(match, ctx)).toEqual(['import matches need the consumed import labels']);
    expect(editPostProblems(match, { ...ctx, consumed: new Set([row]) })).toEqual(['split 0: import row already consumed']);
    const confirmed = { ...target, importIds: [lbl('earlier'), undefined, undefined] };
    expect(editPostProblems(match, { ...ctx, target: confirmed, consumed: new Set() }))
      .toEqual(['split 0 already has an import_id']);
    // Labels may be set on a locked, reversed entry in an open segment: no balance changes.
    const locked = { ...target, locked: true, reversedBy: msg('rev') };
    expect(editPostProblems(match, { ...ctx, target: locked, consumed: new Set() })).toEqual([]);
  });

  it('agrees with the fold on what applies', () => {
    const food = { id: target.id, type: 'ledger.entry', data: { v: 1, date: '2026-02-01', splits: [usd(A.checking, -900), usd(A.groceries, 900)] } };
    const edits: Edit[] = [
      { target: target.id, splits: { '1': A.dining } },
      { target: target.id, splits: { '0': A.visa } },
      { target: target.id, memo: 'x' },
    ];
    const fold = foldSegment('journal-2026', [food, { id: msg('edit'), type: 'ledger.edit', data: { v: 1, edits } }], { chart });
    const t = { ...target, splits: [split(A.checking, -900n), split(A.groceries, 900n)], accounts: [A.checking, A.groceries] };
    const ignored = fold.anomalies.map((a) => a.edit);
    // Each edit is checked on its own, against the target as it stood before the message.
    expect(edits.map((e, i) => editPostProblems(e, { ...ctx, target: t }).length > 0 === ignored.includes(i)))
      .toEqual([true, true, true]);
    expect(fold.entries.get(target.id)?.accounts).toEqual([A.checking, A.dining]);
  });
});

describe('packEdits', () => {
  const memo = (name: string, year: number, text = 'x'): [Edit, number] => [{ target: msg(name), memo: text }, year];

  it('groups edits by their target segment, in order', () => {
    const pairs = [memo('a', 2026), memo('b', 2025), memo('c', 2026)];
    const years = new Map(pairs.map(([e, y]) => [e.target, y]));
    const out = packEdits(pairs.map(([e]) => e), (t) => years.get(t)!);
    expect(out.map((m) => [m.year, m.msg.edits.map((e) => e.target)])).toEqual([
      [2026, [msg('a'), msg('c')]],
      [2025, [msg('b')]],
    ]);
  });

  it('starts a new message before one would pass the limit, measuring the encoding exactly', () => {
    const edits = Array.from({ length: 5 }, (_, i) => memo(`e${i}`, 2026, 'é'.repeat(20))[0]);
    const one = new TextEncoder().encode(encodeMessage('ledger.edit', { v: 1, edits: edits.slice(0, 2) })).length;
    const out = packEdits(edits, () => 2026, one);
    expect(out.map((m) => m.msg.edits.length)).toEqual([2, 2, 1]);
    for (const m of out) {
      expect(new TextEncoder().encode(encodeMessage('ledger.edit', m.msg)).length).toBeLessThanOrEqual(one);
    }
  });

  it('refuses an edit too large alone, and a malformed one', () => {
    expect(() => packEdits([memo('a', 2026, 'x'.repeat(100))[0]], () => 2026, 50)).toThrow(RangeError);
    expect(() => packEdits([{ target: msg('a') }], () => 2026)).toThrow(/at least one field/);
  });
});
