/**
 * Folds across every segment the client holds: balances, reversal anomalies, and import
 * consumption. Inputs are `SegmentFold`s from segment.ts.
 */

import { add, type Amount, type Commodity } from '../amount.js';
import type { AccountId, IsoDate, Label, MsgId } from '../ids.js';
import { isInverse } from '../reversal.js';
import type { Anomaly, EntryView, SegmentFold } from './segment.js';

export type Balances = Map<AccountId, Map<Commodity, Amount>>;

export interface BalanceWindow {
  /** Inclusive. */
  readonly from?: IsoDate;
  /** Inclusive. */
  readonly to?: IsoDate;
}

function credit(balances: Balances, account: AccountId, a: Amount): void {
  let byCur = balances.get(account);
  if (!byCur) balances.set(account, (byCur = new Map()));
  const prev = byCur.get(a.cur);
  byCur.set(a.cur, prev ? add(prev, a) : { amount: a.amount, exp: a.exp, cur: a.cur });
}

const inWindow = (date: IsoDate, w: BalanceWindow) =>
  (w.from === undefined || date >= w.from) && (w.to === undefined || date <= w.to);

/**
 * Balance of every account per commodity, positive for a debit. Entries count with their
 * effective accounts; reversals always count as the balanced entries they are; a
 * `ledger.lotadjust` changes its account by `new_qty − old_qty`. A window filters by date.
 */
export function balances(segments: Iterable<SegmentFold>, window: BalanceWindow = {}): Balances {
  const out: Balances = new Map();
  for (const seg of segments) {
    for (const e of seg.entries.values()) {
      if (!inWindow(e.entry.date, window)) continue;
      e.entry.splits.forEach((s, i) => credit(out, e.accounts[i], s));
    }
    for (const r of seg.reversals.values()) {
      if (!inWindow(r.reversal.date, window)) continue;
      for (const s of r.reversal.splits) credit(out, s.account, s);
    }
    for (const { msg } of seg.lotAdjusts) {
      if (!inWindow(msg.date, window)) continue;
      for (const adj of msg.adjustments) {
        credit(out, adj.account, { amount: adj.new_qty - adj.old_qty, exp: adj.exp, cur: adj.cur });
      }
    }
  }
  return out;
}

/** The balance of one account in one commodity, zero if it has none. */
export function balanceOf(b: Balances, account: AccountId, cur: Commodity): Amount {
  return b.get(account)?.get(cur) ?? { amount: 0n, exp: 0, cur };
}

export function findEntry(segments: Iterable<SegmentFold>, id: MsgId): EntryView | undefined {
  for (const seg of segments) {
    const e = seg.entries.get(id);
    if (e) return e;
  }
  return undefined;
}

/**
 * Entries voided by a reversal. Their lots don't exist and their draws don't count. A
 * reversal whose target the client doesn't hold still voids it.
 */
export function voided(segments: Iterable<SegmentFold>): Set<MsgId> {
  const out = new Set<MsgId>();
  for (const seg of segments) for (const r of seg.reversals.values()) out.add(r.reversal.reverses);
  return out;
}

/**
 * Reversal anomalies: a target reversed more than once, and a reversal whose splits
 * aren't the inverse of its target's effective splits. Only checked when the target's
 * segment is held.
 */
export function reversalAnomalies(segments: readonly SegmentFold[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const seen = new Map<MsgId, MsgId>();
  for (const seg of segments) {
    for (const r of seg.reversals.values()) {
      const targetId = r.reversal.reverses;
      const first = seen.get(targetId);
      if (first) {
        anomalies.push({ kind: 'reversed-twice', msg: r.id, detail: `${targetId} was already reversed by ${first}` });
      } else {
        seen.set(targetId, r.id);
      }
      const target = findEntry(segments, targetId);
      if (!target) continue;
      if (!isInverse({ splits: target.entry.splits, accounts: target.accounts }, r.reversal.splits)) {
        anomalies.push({ kind: 'reversal-mismatch', msg: r.id, detail: `splits are not the inverse of ${targetId}` });
      }
    }
  }
  return anomalies;
}

export type ImportUse =
  | { readonly kind: 'split'; readonly entry: MsgId; readonly split: number }
  | { readonly kind: 'dismiss'; readonly msg: MsgId };

export interface ImportConsumption {
  /** Every consumed label and where it was used. */
  readonly consumed: ReadonlyMap<Label, readonly ImportUse[]>;
  /** A label on two splits, or on a split and a dismissal. */
  readonly anomalies: readonly Anomaly[];
}

/**
 * Import rows are consumed if their label is the effective `import_id` of an entry's split
 * or appears in a `ledger.dismiss`. Reversal splits don't consume rows.
 */
export function importConsumption(segments: Iterable<SegmentFold>): ImportConsumption {
  const consumed = new Map<Label, ImportUse[]>();
  const use = (label: Label, u: ImportUse) => {
    const list = consumed.get(label);
    if (list) list.push(u);
    else consumed.set(label, [u]);
  };
  for (const seg of segments) {
    for (const e of seg.entries.values()) {
      e.importIds.forEach((label, split) => {
        if (label !== undefined) use(label, { kind: 'split', entry: e.id, split });
      });
    }
    for (const d of seg.dismissals) for (const label of d.msg.import_ids) use(label, { kind: 'dismiss', msg: d.id });
  }
  const anomalies: Anomaly[] = [];
  for (const [label, uses] of consumed) {
    const splits = uses.filter((u) => u.kind === 'split');
    if (splits.length > 1 || (splits.length === 1 && uses.length > 1)) {
      const last = uses[uses.length - 1];
      const msg = last.kind === 'split' ? last.entry : last.msg;
      anomalies.push({ kind: 'import-id-reused', msg, detail: `import label ${label} is used ${uses.length} times` });
    }
  }
  return { consumed, anomalies };
}
