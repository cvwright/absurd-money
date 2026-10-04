/**
 * Period closes (0016): a `ledger.checkpoint` carrying heads only. Every entry at or
 * before a cited head is **locked** against split-account edits, and a head cited with
 * `final` **freezes** its segment. Rules: "ledger.checkpoint" in design/SCHEMAS.md.
 *
 * The lock is positional, not date-based. A close of March cites the segment's head when
 * it is posted, so an April entry already posted to that segment is locked too.
 */

import { CodecError } from './errors.js';
import { segmentOf, segmentYear, type IsoDate, type MsgId } from './ids.js';
import { encodeMessage, type Checkpoint, type Head } from './messages.js';

/** The rounding policy every `v: 1` checkpoint names (design/ROUNDING.md). */
export const ROUNDING = 'v1';

const PERIOD_RE = /^([0-9]{4})(?:-(0[1-9]|1[0-2])|-Q([1-4]))?$/;

/** The last day of `period` (`YYYY`, `YYYY-MM`, or `YYYY-Qn`), or undefined if it isn't one. */
export function periodEnd(period: string): IsoDate | undefined {
  const m = PERIOD_RE.exec(period);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : m[3] ? Number(m[3]) * 3 : 12;
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${m[1]}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}` as IsoDate;
}

/** The year `period` falls in, or undefined if it isn't a period. */
export function periodYear(period: string): number | undefined {
  const m = PERIOD_RE.exec(period);
  return m ? Number(m[1]) : undefined;
}

/** The month before the one `today` falls in, as `YYYY-MM`: the period a close usually names. */
export function previousMonth(today: IsoDate): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * A close of `period`, citing the segment of its year at `head`. With `final`, the close
 * also freezes that segment, so `period` should be the whole year.
 */
export function periodClose(period: string, head: MsgId, final = false): Checkpoint {
  const year = periodYear(period);
  if (year === undefined) throw new RangeError(`${period} is not a period`);
  const h: Head = { topic: segmentOf(year), hash: head, ...(final && { final: true as const }) };
  return { v: 1, period, rounding: ROUNDING, heads: [h] };
}

export interface ClosePostContext {
  /** The years listed in `ledger/journal`. */
  readonly years: readonly number[];
  /** Whether a segment is open: no final close has frozen it. */
  readonly segmentOpen: (topic: string) => boolean;
}

/** Everything checked before posting a period close. */
export function closePostProblems(cp: Checkpoint, ctx: ClosePostContext): string[] {
  try {
    encodeMessage('ledger.checkpoint', cp);
  } catch (e) {
    if (e instanceof CodecError) return [e.message];
    throw e;
  }
  const problems: string[] = [];
  // Full checkpoints come with the checkpoint writer (0028).
  if (cp.balances || cp.envelopes || cp.lots || cp.prices) problems.push('a period close carries no balances');
  const year = periodYear(cp.period)!;
  for (const h of cp.heads) {
    const y = segmentYear(h.topic);
    if (y === undefined) {
      problems.push(`a period close cites only journal segments, not ${h.topic}`);
      continue;
    }
    if (!ctx.years.includes(y)) problems.push(`${h.topic} has nothing to close`);
    if (y > year) problems.push(`${h.topic} is after ${cp.period}`);
    if (!ctx.segmentOpen(h.topic)) problems.push(`${h.topic} is already frozen`);
    if (h.final && cp.period !== String(y)) problems.push(`only a close of all of ${y} can freeze ${h.topic}`);
  }
  return problems;
}
