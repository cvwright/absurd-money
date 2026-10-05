/**
 * Statement reconciliation (0018): the `recon` topic fold, and the checks before posting a
 * `ledger.recon`. See "Reconciliation is an event, not a flag" in design/ACCOUNTING.md, and
 * `ledger.recon` in design/SCHEMAS.md.
 *
 * A transaction is cleared for an account iff its hash is in the `cleared` set of some
 * standing recon for that account: one that counts and that no other recon supersedes.
 * Cleared status is never stored per transaction; it is joined against the journal when
 * queried.
 */

import { add, eq, type Amount } from './amount.js';
import type { Chart } from './chart.js';
import { CodecError } from './errors.js';
import type { IsoDate, MsgId } from './ids.js';
import { decodeMessage, encodeMessage, UnknownTypeError, UnknownVersionError, type Recon } from './messages.js';
import type { Anomaly, RawMessage } from './fold/segment.js';

export interface ReconView {
  readonly id: MsgId;
  /** Position in the `recon` chain. */
  readonly index: number;
  readonly msg: Recon;
  /** The first later recon that supersedes this one, if any. */
  readonly supersededBy?: MsgId;
}

export interface ReconFold {
  /** The recons that count, in chain order. */
  readonly recons: readonly ReconView[];
  readonly anomalies: readonly Anomaly[];
  readonly halted?: { readonly at: MsgId; readonly error: UnknownTypeError | UnknownVersionError };
}

/**
 * Fold-time rules for `ledger.recon` that need the chart. An account's existence, `type`,
 * and `cur` never change, so the verdict never does.
 */
export function reconProblems(msg: Recon, chart: Chart): string[] {
  const a = chart.get(msg.account);
  if (!a) return ['unknown account'];
  const problems: string[] = [];
  if (a.type !== 'asset' && a.type !== 'liability') problems.push(`${a.type} accounts can't be reconciled`);
  if (a.cur !== msg.closing_balance.cur) problems.push(`closing balance in ${msg.closing_balance.cur} on a ${a.cur} account`);
  return problems;
}

/**
 * Folds the `recon` chain. A recon whose `supersedes` names no earlier recon for the same
 * account that counts is invalid. Two standing recons that clear the same transaction for
 * the same account (two devices reconciling at once) both count, and the later one is
 * reported as `cleared-twice`.
 */
export function foldRecon(messages: readonly RawMessage[], chart: Chart): ReconFold {
  const views: { id: MsgId; index: number; msg: Recon; supersededBy?: MsgId }[] = [];
  const byId = new Map<MsgId, (typeof views)[number]>();
  const anomalies: Anomaly[] = [];
  let halted: ReconFold['halted'];

  for (let index = 0; index < messages.length; index++) {
    const { id, type, data, error } = messages[index];
    let msg: Recon;
    try {
      if (type !== 'ledger.recon') throw new UnknownTypeError(type);
      if (error !== undefined) throw new CodecError(error);
      msg = decodeMessage('ledger.recon', data);
    } catch (e) {
      if (e instanceof UnknownTypeError || e instanceof UnknownVersionError) {
        halted = { at: id, error: e };
        break;
      }
      if (e instanceof CodecError) {
        anomalies.push({ kind: 'malformed', msg: id, detail: e.message });
        continue;
      }
      throw e;
    }
    const problems = reconProblems(msg, chart);
    if (msg.supersedes !== undefined) {
      const target = byId.get(msg.supersedes);
      if (!target) problems.push('supersedes no earlier reconciliation');
      else if (target.msg.account !== msg.account) problems.push('supersedes a reconciliation of another account');
    }
    if (problems.length > 0) {
      anomalies.push({ kind: 'invalid', msg: id, detail: problems.join('; ') });
      continue;
    }
    if (msg.supersedes !== undefined) {
      const target = byId.get(msg.supersedes)!;
      target.supersededBy ??= id;
    }
    const view = { id, index, msg };
    views.push(view);
    byId.set(id, view);
  }

  const seen = new Map<string, MsgId>();
  for (const v of views) {
    if (v.supersededBy !== undefined) continue;
    for (const txn of v.msg.cleared) {
      const key = `${v.msg.account} ${txn}`;
      const first = seen.get(key);
      if (first === undefined) seen.set(key, v.id);
      else anomalies.push({ kind: 'cleared-twice', msg: v.id, detail: `${txn} was already cleared by ${first}` });
    }
  }
  return { recons: views, anomalies, halted };
}

/** A recon of one account, as the checks before posting the next one need it. */
export interface ReconSummary {
  readonly id: MsgId;
  readonly statementDate: IsoDate;
  readonly cleared: readonly MsgId[];
  readonly supersededBy?: MsgId;
}

export interface ReconPostContext {
  readonly chart: Chart;
  /** Every recon of the account that counts, in chain order. */
  readonly recons: readonly ReconSummary[];
  /**
   * The transactions the client holds that can be cleared for the account: every entry and
   * reversal posting to it, with the sum of its splits on the account.
   */
  readonly postings: ReadonlyMap<MsgId, Amount>;
}

/** The recons of an account that would stand once `supersedes` (if given) no longer does. */
function standingBefore(recons: readonly ReconSummary[], supersedes: MsgId | undefined): ReconSummary[] {
  return recons.filter((r) => r.supersededBy === undefined && r.id !== supersedes);
}

/**
 * The account's cleared balance once a recon clearing `cleared` (and superseding
 * `supersedes`, if given) is posted: the sum of every transaction cleared by a standing
 * recon. A cleared transaction the client doesn't hold counts as nothing.
 */
export function clearedBalance(
  ctx: Omit<ReconPostContext, 'chart'>,
  zero: Amount,
  cleared: Iterable<MsgId>,
  supersedes?: MsgId,
): Amount {
  const txns = new Set<MsgId>(cleared);
  for (const r of standingBefore(ctx.recons, supersedes)) for (const t of r.cleared) txns.add(t);
  let sum = zero;
  for (const t of txns) {
    const a = ctx.postings.get(t);
    if (a) sum = add(sum, a);
  }
  return sum;
}

/** The latest standing recon of the account, which the next statement follows. */
export function lastRecon(recons: readonly ReconSummary[], supersedes?: MsgId): ReconSummary | undefined {
  return standingBefore(recons, supersedes).at(-1);
}

/**
 * Everything checked before posting a recon: the fold-time rules, plus that every cleared
 * transaction is one the client holds on the account and not already cleared, that a
 * superseded recon still stands, that the statement follows the last one, and that the
 * cleared balance equals the statement's closing balance.
 */
export function reconPostProblems(msg: Recon, ctx: ReconPostContext): string[] {
  try {
    encodeMessage('ledger.recon', msg);
  } catch (e) {
    if (e instanceof CodecError) return [e.message];
    throw e;
  }
  const problems = reconProblems(msg, ctx.chart);
  if (problems.length > 0) return problems;

  if (msg.supersedes !== undefined) {
    const target = ctx.recons.find((r) => r.id === msg.supersedes);
    if (!target) problems.push("the superseded reconciliation is not one of this account's");
    else if (target.supersededBy !== undefined) problems.push(`that reconciliation was already superseded by ${target.supersededBy}`);
  }
  const standing = standingBefore(ctx.recons, msg.supersedes);
  const clearedBy = new Map<MsgId, MsgId>();
  for (const r of standing) for (const t of r.cleared) clearedBy.set(t, r.id);
  for (const t of msg.cleared) {
    if (!ctx.postings.has(t)) problems.push(`${t} is not a transaction on this account`);
    else if (clearedBy.has(t)) problems.push(`${t} was already cleared by ${clearedBy.get(t)}`);
  }
  const last = standing.at(-1);
  if (last && msg.statement_date <= last.statementDate) {
    problems.push(`the statement date must be after the last reconciliation, on ${last.statementDate}`);
  }
  if (problems.length > 0) return problems;

  const zero: Amount = { amount: 0n, exp: 0, cur: msg.closing_balance.cur };
  const cleared = clearedBalance(ctx, zero, msg.cleared, msg.supersedes);
  if (!eq(cleared, msg.closing_balance)) problems.push('the cleared balance does not equal the closing balance');
  return problems;
}
