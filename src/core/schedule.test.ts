import { describe, expect, it } from 'vitest';
import type { EnvelopeId, Label, Month } from './ids.js';
import type { BudgetDoc, ScheduleStep } from './messages.js';
import { dueAllocations, nextMonth, stepAt, withSchedule, withoutStep, withStep } from './schedule.js';
import { budgetDoc, day, E } from './testing.js';

const mo = (s: string) => s as Month;
const step = (from: string, cents: number): ScheduleStep => ({ from: mo(from), amount: BigInt(cents), exp: 2 });
/** A readable stand-in for the `allocation/v1` label. */
const idem = (env: EnvelopeId, month: Month) => `${env === E.groceries ? 'g' : 'd'}|${month}` as Label;

const scheduled = (groceries: ScheduleStep[], dining?: ScheduleStep[]): BudgetDoc => ({
  ...budgetDoc,
  envelopes: {
    [E.groceries]: { ...budgetDoc.envelopes[E.groceries], schedule: groceries },
    [E.dining]: { ...budgetDoc.envelopes[E.dining], ...(dining && { schedule: dining }) },
  },
});

describe('months and steps', () => {
  it('steps through the year boundary', () => {
    expect(nextMonth(mo('2025-11'))).toBe('2025-12');
    expect(nextMonth(mo('2025-12'))).toBe('2026-01');
  });

  it('finds the step in effect', () => {
    const s = [step('2024-01', 60000), step('2025-12', 70000)];
    expect(stepAt(s, mo('2023-12'))).toBeUndefined();
    expect(stepAt(s, mo('2024-01'))).toBe(s[0]);
    expect(stepAt(s, mo('2025-11'))).toBe(s[0]);
    expect(stepAt(s, mo('2026-10'))).toBe(s[1]);
    expect(stepAt(undefined, mo('2026-10'))).toBeUndefined();
  });

  it('adds, replaces, and removes steps, keeping them sorted', () => {
    const s = withStep(withStep(undefined, step('2025-12', 70000)), step('2024-01', 60000));
    expect(s.map((x) => x.from)).toEqual(['2024-01', '2025-12']);
    expect(withStep(s, step('2025-12', 0))).toEqual([step('2024-01', 60000), step('2025-12', 0)]);
    expect(withoutStep(s, mo('2024-01'))).toEqual([step('2025-12', 70000)]);
    expect(withoutStep([s[0]], mo('2024-01'))).toBeUndefined();
    const env = budgetDoc.envelopes[E.groceries];
    expect(withSchedule(withSchedule(env, s), undefined)).toEqual(env);
  });
});

describe('dueAllocations', () => {
  it('allocates each month on the first, by month then envelope ID, at the step in effect', () => {
    const doc = scheduled([step('2025-11', 60000), step('2026-01', 70000)], [step('2025-12', 15000)]);
    const due = dueAllocations(doc, mo('2026-01'), new Set(), idem);
    expect(due.map((a) => [a.date, a.envelope, a.amount, a.idem])).toEqual([
      ['2025-11-01', E.groceries, 60000n, 'g|2025-11'],
      ['2025-12-01', E.dining, 15000n, 'd|2025-12'],
      ['2025-12-01', E.groceries, 60000n, 'g|2025-12'],
      ['2026-01-01', E.dining, 15000n, 'd|2026-01'],
      ['2026-01-01', E.groceries, 70000n, 'g|2026-01'],
    ]);
    expect(due[0]).toEqual({ v: 1, date: day('2025-11-01'), envelope: E.groceries, amount: 60000n, exp: 2, cur: 'USD', idem: 'g|2025-11' });
  });

  it('skips months already materialized, months at zero, and the future', () => {
    const doc = scheduled([step('2026-07', 60000), step('2026-09', 0), step('2026-11', 50000)]);
    expect(dueAllocations(doc, mo('2026-10'), new Set(['g|2026-07' as Label]), idem).map((a) => a.date)).toEqual([
      '2026-08-01',
    ]);
    expect(dueAllocations(doc, mo('2026-06'), new Set(), idem)).toEqual([]);
  });

  it('gives a closed envelope nothing', () => {
    const doc = scheduled([step('2026-01', 60000)]);
    const closed = { ...doc, envelopes: { ...doc.envelopes, [E.groceries]: { ...doc.envelopes[E.groceries], closed_at: day('2026-05-31') } } };
    expect(dueAllocations(closed, mo('2026-10'), new Set(), idem)).toEqual([]);
  });
});
