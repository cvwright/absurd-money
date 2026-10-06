import { describe, expect, it } from 'vitest';
import { commodity } from './amount.js';
import type { Label } from './ids.js';
import type { LabeledRow } from './import-ids.js';
import { dayDiff, findMatches, findReplacements, importEntry, rowMemo, shiftDate, type JournalSplit } from './review.js';
import { A, day, lbl, msg } from './testing.js';

const USD = commodity('USD');
const row = (date: string, cents: bigint, name = 'row', exp = 2): LabeledRow => ({
  line: 2, date: day(date), amount: { amount: cents, exp }, description: '  BLUE   BOTTLE ', importId: lbl(name),
});
const split = (name: string, date: string, cents: bigint, importId?: Label): JournalSplit => ({
  txn: msg(name), split: 0, date: day(date), amount: { amount: cents, exp: 2, cur: USD }, others: [A.dining],
  ...(importId && { importId }),
});

describe('dates', () => {
  it('counts and shifts whole days across months and years', () => {
    expect(dayDiff(day('2026-12-30'), day('2027-01-02'))).toBe(3);
    expect(dayDiff(day('2026-03-02'), day('2026-02-27'))).toBe(-3);
    expect(shiftDate(day('2026-12-30'), 3)).toBe('2027-01-02');
    expect(shiftDate(day('2026-03-01'), -1)).toBe('2026-02-28');
  });
});

describe('findMatches', () => {
  it('matches an unconfirmed split with the same amount by value within the window', () => {
    const hand = split('hand', '2026-09-12', -500n);
    const far = split('far', '2026-09-01', -8423n);
    // By value: -5.000 at exp 3 is -5.00 at exp 2.
    expect(findMatches([row('2026-09-14', -5000n, 'r', 3)], [hand]).get(0)).toBe(hand);
    // `far` is 19 days off; nothing else has -84.23.
    expect([...findMatches([row('2026-09-14', -500n), row('2026-09-20', -8423n)], [hand, far])]).toEqual([[0, hand]]);
  });

  it('never matches a confirmed split, and pairs each split once, closest dates first', () => {
    const rows = [row('2026-09-10', -500n, 'a'), row('2026-09-14', -500n, 'b')];
    const splits = [split('x', '2026-09-14', -500n), split('done', '2026-09-10', -500n, lbl('old'))];
    const m = findMatches(rows, splits);
    expect(m.get(1)?.txn).toBe(msg('x'));
    expect(m.has(0)).toBe(false);
  });

  it('matches the other side of a transfer', () => {
    // Paid the card from checking; the card's import sees the payment as money in.
    const payment: JournalSplit = { ...split('pay', '2026-09-28', 30000n), others: [A.checking] };
    expect(findMatches([row('2026-09-30', 30000n)], [payment]).get(0)).toBe(payment);
  });
});

describe('findReplacements', () => {
  const file = { labels: new Set([lbl('kept')]), from: day('2026-09-01'), to: day('2026-09-30') };

  it('suggests an imported split the file no longer lists, with the same sign', () => {
    const pending = split('pending', '2026-09-14', -2000n, lbl('gone'));
    const kept = split('kept', '2026-09-14', -2000n, lbl('kept'));
    const refund = split('refund', '2026-09-14', 2400n, lbl('refund'));
    expect(findReplacements([row('2026-09-15', -2400n)], [kept, refund, pending], file).get(0)).toBe(pending);
  });

  it('ignores splits outside the file, or too far from the row, or unconfirmed', () => {
    const before = split('before', '2026-08-31', -2000n, lbl('x'));
    const far = split('far', '2026-09-01', -2000n, lbl('y'));
    const hand = split('hand', '2026-09-14', -2000n);
    expect(findReplacements([row('2026-09-15', -2400n)], [before, far, hand], file).size).toBe(0);
  });

  it('prefers the closest amount on the same day', () => {
    const a = split('a', '2026-09-14', -2000n, lbl('a'));
    const b = split('b', '2026-09-14', -2300n, lbl('b'));
    expect(findReplacements([row('2026-09-14', -2400n)], [a, b], file).get(0)).toBe(b);
  });
});

describe('importEntry', () => {
  it('posts the row on the account with its label, and the opposite on the category', () => {
    const r = row('2026-09-14', -500n);
    expect(importEntry(r, { account: A.checking, cur: USD, category: A.dining, memo: rowMemo(r), replaces: msg('p') })).toEqual({
      v: 1,
      date: '2026-09-14',
      splits: [
        { account: A.checking, amount: -500n, exp: 2, cur: USD, import_id: lbl('row') },
        { account: A.dining, amount: 500n, exp: 2, cur: USD },
      ],
      memo: 'BLUE BOTTLE',
      replaces: msg('p'),
    });
  });
});
