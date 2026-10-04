import { describe, expect, it } from 'vitest';
import { closePostProblems, periodClose, periodEnd, periodYear, previousMonth } from './close.js';
import { decodeMessage } from './messages.js';
import { day, msg } from './testing.js';

const open = { years: [2025, 2026], segmentOpen: () => true };

describe('periods', () => {
  it('ends a year, a month, and a quarter on their last day', () => {
    expect(periodEnd('2025')).toBe('2025-12-31');
    expect(periodEnd('2024-02')).toBe('2024-02-29');
    expect(periodEnd('2025-02')).toBe('2025-02-28');
    expect(periodEnd('2026-Q1')).toBe('2026-03-31');
    expect(periodEnd('2026-Q3')).toBe('2026-09-30');
  });

  it('rejects anything else', () => {
    for (const p of ['2026-13', '2026-Q5', '2026-1', '26', '2026-03-01', '']) {
      expect(periodEnd(p)).toBeUndefined();
      expect(periodYear(p)).toBeUndefined();
    }
  });

  it('defaults to last month, across New Year', () => {
    expect(previousMonth(day('2026-10-04'))).toBe('2026-09');
    expect(previousMonth(day('2026-01-15'))).toBe('2025-12');
  });
});

describe('periodClose', () => {
  it('cites the segment of the period’s year, and decodes', () => {
    const cp = periodClose('2025-12', msg('head'));
    expect(cp).toEqual({ v: 1, period: '2025-12', rounding: 'v1', heads: [{ topic: 'journal-2025', hash: msg('head') }] });
    expect(decodeMessage('ledger.checkpoint', JSON.parse(JSON.stringify(cp)))).toEqual(cp);
    expect(periodClose('2025', msg('head'), true).heads[0].final).toBe(true);
  });

  it('throws on a bad period', () => {
    expect(() => periodClose('December', msg('head'))).toThrow(RangeError);
  });
});

describe('closePostProblems', () => {
  it('accepts a close of an open, listed segment', () => {
    expect(closePostProblems(periodClose('2026-Q1', msg('h')), open)).toEqual([]);
    expect(closePostProblems(periodClose('2025', msg('h'), true), open)).toEqual([]);
  });

  it('refuses a frozen or unlisted segment', () => {
    expect(closePostProblems(periodClose('2025-12', msg('h')), { ...open, segmentOpen: () => false }))
      .toEqual(['journal-2025 is already frozen']);
    expect(closePostProblems(periodClose('2024-12', msg('h')), open)).toEqual(['journal-2024 has nothing to close']);
  });

  it('freezes a segment only with a close of its whole year', () => {
    expect(closePostProblems(periodClose('2025-12', msg('h'), true), open))
      .toEqual(['only a close of all of 2025 can freeze journal-2025']);
  });

  it('refuses a segment after the period, a budget head, and balances', () => {
    const cp = {
      ...periodClose('2025-12', msg('h')),
      heads: [{ topic: 'journal-2026', hash: msg('h') }, { topic: 'budget', hash: msg('b') }],
      balances: [],
    };
    expect(closePostProblems(cp, open)).toEqual([
      'a period close carries no balances',
      'journal-2026 is after 2025-12',
      'a period close cites only journal segments, not budget',
    ]);
  });

  it('reports a message that does not encode', () => {
    expect(closePostProblems({ ...periodClose('2025', msg('h')), heads: [] }, open)).toHaveLength(1);
  });
});
