/**
 * The lot fold: each lot's remaining quantity and basis, and the check of every posted
 * draw against the pinned basis rule. Order and rules: "Order of lot events" and "The
 * fold-time check" in design/ROUNDING.md.
 *
 * Lot anomalies never change the validity of an entry or any balance.
 */

import { cmpDecimal, eq, type Amount, type Commodity, type Decimal } from '../amount.js';
import { lotId, type AccountId, type IsoDate, type LotId, type MsgId } from '../ids.js';
import { applyDraw, expectedBasis, type LotState } from '../rounding.js';
import { voided } from './ledger.js';
import type { Anomaly, SegmentFold } from './segment.js';

export interface Lot extends LotState {
  readonly lot: LotId;
  readonly account: AccountId;
  readonly cur: Commodity;
  readonly acquired: IsoDate;
}

export interface LotFold {
  /** Every lot created by a non-voided entry, as it stands after all events. */
  readonly lots: ReadonlyMap<LotId, Lot>;
  readonly anomalies: readonly Anomaly[];
}

export interface LotFoldOptions {
  /**
   * Whether the client holds every journal segment. If not, a draw on a lot it has never
   * seen may cite a lot created in another year, so it is skipped rather than flagged.
   */
  readonly complete: boolean;
}

type Event =
  | { kind: 0; msg: MsgId; lot: Lot }
  | { kind: 1; msg: MsgId; lot: LotId; account: AccountId; cur: Commodity; old: Decimal; new: Decimal }
  | {
      kind: 2;
      msg: MsgId;
      lot: LotId;
      account: AccountId;
      cur: Commodity;
      qty: Decimal;
      acquired: IsoDate;
      basis: Amount;
    };

interface Keyed {
  date: IsoDate;
  year: number;
  index: number;
  sub: number[];
  event: Event;
}

function compareKeys(a: Keyed, b: Keyed): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.event.kind !== b.event.kind) return a.event.kind - b.event.kind;
  if (a.year !== b.year) return a.year - b.year;
  if (a.index !== b.index) return a.index - b.index;
  for (let i = 0; i < Math.min(a.sub.length, b.sub.length); i++) {
    if (a.sub[i] !== b.sub[i]) return a.sub[i] - b.sub[i];
  }
  return a.sub.length - b.sub.length;
}

export function foldLots(segments: readonly SegmentFold[], opts: LotFoldOptions): LotFold {
  const voids = voided(segments);
  const events: Keyed[] = [];

  for (const seg of segments) {
    for (const e of seg.entries.values()) {
      if (voids.has(e.id)) continue;
      e.entry.splits.forEach((s, i) => {
        const base = { date: e.entry.date, year: seg.year, index: e.index };
        if (s.cost && s.acquired) {
          const lot: Lot = {
            lot: lotId(e.id, i),
            account: s.account,
            cur: s.cur,
            acquired: s.acquired,
            qty: { amount: s.amount, exp: s.exp },
            basis: s.cost,
            scale: s.cost.exp,
          };
          events.push({ ...base, sub: [i], event: { kind: 0, msg: e.id, lot } });
        }
        s.from_lots?.forEach((d, j) => {
          events.push({
            ...base,
            sub: [i, j],
            event: {
              kind: 2, msg: e.id, lot: d.lot, account: s.account, cur: s.cur,
              qty: { amount: d.qty, exp: s.exp }, acquired: d.acquired, basis: d.basis,
            },
          });
        });
      });
    }
    for (const { id, index, msg } of seg.lotAdjusts) {
      msg.adjustments.forEach((adj, k) => {
        events.push({
          date: msg.date, year: seg.year, index, sub: [k],
          event: {
            kind: 1, msg: id, lot: adj.lot, account: adj.account, cur: adj.cur,
            old: { amount: adj.old_qty, exp: adj.exp }, new: { amount: adj.new_qty, exp: adj.exp },
          },
        });
      });
    }
  }
  events.sort(compareKeys);

  const created = new Set<LotId>();
  for (const { event } of events) if (event.kind === 0) created.add(event.lot.lot);

  const lots = new Map<LotId, Lot>();
  const anomalies: Anomaly[] = [];
  const flag = (msg: MsgId, detail: string) => anomalies.push({ kind: 'lot', msg, detail });

  for (const { event } of events) {
    if (event.kind === 0) {
      lots.set(event.lot.lot, event.lot);
      continue;
    }
    const lot = lots.get(event.lot);
    if (!lot) {
      if (created.has(event.lot)) flag(event.msg, `${event.lot} is used before it is created`);
      else if (opts.complete) flag(event.msg, `${event.lot} is unknown`);
      continue;
    }
    if (event.account !== lot.account || event.cur !== lot.cur) {
      flag(event.msg, `${event.lot} is in another account or commodity`);
    }

    if (event.kind === 1) {
      if (cmpDecimal(event.old, lot.qty) !== 0) {
        flag(event.msg, `${event.lot}: old_qty does not match the remaining quantity`);
      }
      lots.set(event.lot, { ...lot, qty: event.new });
      continue;
    }

    if (event.acquired !== lot.acquired) flag(event.msg, `${event.lot}: acquired does not match the lot`);
    const expected = expectedBasis(lot, event.qty);
    if (expected === 'oversold') {
      flag(event.msg, `${event.lot} is oversold`);
    } else if (event.basis.cur !== lot.basis.cur) {
      flag(event.msg, `${event.lot}: basis is in ${event.basis.cur}, not ${lot.basis.cur}`);
    } else if (!eq(event.basis, expected)) {
      flag(event.msg, `${event.lot}: basis does not match the rounding rule`);
    }
    lots.set(event.lot, { ...lot, ...applyDraw(lot, event.qty, event.basis) });
  }

  return { lots, anomalies };
}

/** Lots with remaining quantity. */
export function openLots(fold: LotFold): Lot[] {
  return [...fold.lots.values()].filter((l) => l.qty.amount > 0n);
}
