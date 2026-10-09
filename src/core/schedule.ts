/**
 * The monthly schedule in `ledger/budget` (0025): which step is in effect in a month, the
 * allocations it calls for that haven't been posted yet, and the edits to an envelope's
 * steps. See "Allocations are events; the schedule is config" in design/ACCOUNTING.md.
 *
 * Materialized allocations carry `idem = label("allocation/v1", "{envelope}|{month}")`, so
 * each envelope gets at most one per month however many devices materialize it. A month
 * already materialized stays as posted: editing a past step changes nothing for it.
 */

import type { EnvelopeId, IsoDate, Label, Month } from './ids.js';
import type { Allocation, BudgetDoc, Envelope, ScheduleStep } from './messages.js';

/** The month after `m`. */
export function nextMonth(m: Month): Month {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return (mo === 12 ? `${String(y + 1).padStart(4, '0')}-01` : `${m.slice(0, 4)}-${String(mo + 1).padStart(2, '0')}`) as Month;
}

/** The step in effect in `month`: the last one starting on or before it. */
export function stepAt(schedule: readonly ScheduleStep[] | undefined, month: Month): ScheduleStep | undefined {
  let found: ScheduleStep | undefined;
  for (const s of schedule ?? []) {
    if (s.from > month) break;
    found = s;
  }
  return found;
}

/**
 * The allocations the schedule calls for through `through`, inclusive, whose `idem` is
 * not in `done`: one per open envelope per month with a non-zero step in effect, dated the
 * first of the month. Closed envelopes get none, since an allocation to one can't be
 * posted. Ordered by month, then envelope ID, so the oldest month posts first.
 */
export function dueAllocations(
  budget: BudgetDoc,
  through: Month,
  done: ReadonlySet<Label>,
  idem: (envelope: EnvelopeId, month: Month) => Label,
): Allocation[] {
  const due: { month: Month; envelope: EnvelopeId; alloc: Allocation }[] = [];
  for (const [envelope, e] of Object.entries(budget.envelopes) as [EnvelopeId, Envelope][]) {
    if (e.closed_at !== undefined || !e.schedule) continue;
    for (let month = e.schedule[0].from; month <= through; month = nextMonth(month)) {
      const step = stepAt(e.schedule, month)!;
      if (step.amount === 0n) continue;
      const label = idem(envelope, month);
      if (done.has(label)) continue;
      const date = `${month}-01` as IsoDate;
      due.push({ month, envelope, alloc: { v: 1, date, envelope, amount: step.amount, exp: step.exp, cur: e.cur, idem: label } });
    }
  }
  due.sort((x, y) => (x.month !== y.month ? (x.month < y.month ? -1 : 1) : x.envelope < y.envelope ? -1 : 1));
  return due.map((d) => d.alloc);
}

/** `schedule` with `step` added, replacing any step from the same month. */
export function withStep(schedule: readonly ScheduleStep[] | undefined, step: ScheduleStep): ScheduleStep[] {
  return [...(schedule ?? []).filter((s) => s.from !== step.from), step].sort((x, y) => (x.from < y.from ? -1 : 1));
}

/** `schedule` without the step from `from`, or `undefined` if none is left. */
export function withoutStep(schedule: readonly ScheduleStep[] | undefined, from: Month): ScheduleStep[] | undefined {
  const rest = (schedule ?? []).filter((s) => s.from !== from);
  return rest.length > 0 ? rest : undefined;
}

/** `e` with its schedule set to `schedule`, or without one if it is `undefined`. */
export function withSchedule(e: Envelope, schedule: readonly ScheduleStep[] | undefined): Envelope {
  const { schedule: _, ...rest } = e;
  return schedule ? { ...rest, schedule } : rest;
}
