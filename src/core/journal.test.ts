import { describe, expect, it } from 'vitest';
import { segmentOf, segmentYear } from './ids.js';
import { EMPTY_JOURNAL, journalUpdateProblems, withYear } from './journal.js';
import { CodecError } from './errors.js';
import { decodeState, encodeState } from './messages.js';

describe('ledger/journal', () => {
  it('lists years ascending, once each', () => {
    const doc = withYear(withYear(EMPTY_JOURNAL, 2026), 2024);
    expect(doc.years).toEqual([2024, 2026]);
    expect(withYear(doc, 2026)).toBe(doc);
  });

  it('never removes a year, and bumps rev', () => {
    const prev = { v: 1, rev: 2, years: [2025, 2026] } as const;
    expect(journalUpdateProblems(prev, { ...withYear(prev, 2027), rev: 3 })).toEqual([]);
    expect(journalUpdateProblems(prev, { v: 1, rev: 2, years: [2026] })).toEqual([
      'rev must be 3',
      '2025: years are never removed',
    ]);
  });

  it('round-trips and rejects bad year lists', () => {
    const doc = { v: 1, rev: 1, years: [2025, 2026] };
    expect(JSON.parse(encodeState('ledger/journal', decodeState('ledger/journal', doc)))).toEqual(doc);
    for (const years of [[2026, 2025], [2025, 2025], [10000], [-1], [2025.5], ['2025']]) {
      expect(() => decodeState('ledger/journal', { ...doc, years })).toThrow(CodecError);
    }
  });

  it('names a segment for every year', () => {
    expect(segmentOf(2026)).toBe('journal-2026');
    expect(segmentOf(987)).toBe('journal-0987');
    expect(segmentYear(segmentOf(987))).toBe(987);
    expect(() => segmentOf(10000)).toThrow(RangeError);
  });
});
