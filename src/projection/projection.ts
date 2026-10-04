/**
 * The local projection: every message the client has replayed, and the folds of them, in
 * one SQLite database. "Design A" in design/ACCOUNTING.md; the storage decisions are in
 * issues/0012-projection.md.
 *
 * The database has two layers, versioned separately:
 *
 * - **The log**: each topic's messages in chain order with their decrypted payloads, and a
 *   watermark per topic. Bumping `LOG_VERSION` drops everything, so the client downloads
 *   the space again.
 * - **The folds**: tables derived from the log by the core folds. Bumping
 *   `PROJECTION_VERSION` drops them and refolds from the log, with no network. They are
 *   never migrated.
 *
 * An append writes the log, the watermark, and the refolded tables in one transaction, so
 * they are always consistent with each other. A topic is always refolded whole: the folds
 * are fast, and edits, reversals, and locks reach back to earlier messages anyway.
 *
 * This runs wherever SQLite does: in the projection worker in the browser, and in memory
 * under vitest.
 */

import type { BindableValue, Database } from '@sqlite.org/sqlite-wasm';
import { add, commodity, type Amount, type Commodity } from '@/core/amount.js';
import { chainOrder } from '@/core/chain.js';
import { chartOf, EMPTY_CHART } from '@/core/chart.js';
import { EMPTY_BUDGET } from '@/core/budget.js';
import { CodecError } from '@/core/errors.js';
import { foldBudget } from '@/core/fold/budget.js';
import { balances as foldBalances, type Balances, type BalanceWindow } from '@/core/fold/ledger.js';
import { foldSegment, type Anomaly, type AnomalyKind, type RawMessage } from '@/core/fold/segment.js';
import { segmentOf, segmentYear, type AccountId, type EnvelopeId, type IsoDate, type MsgId, type PayeeId } from '@/core/ids.js';
import { EMPTY_JOURNAL } from '@/core/journal.js';
import { parseJson } from '@/core/json.js';
import {
  decodeMessage, decodeState, isStatePath, UnknownTypeError, UnknownVersionError,
  type Split, type StateDocs, type StatePath,
} from '@/core/messages.js';
import { isInverse, type ReversalTarget } from '@/core/reversal.js';

/** The log's schema. Changing it means downloading every topic again. */
export const LOG_VERSION = 1;

/** The fold tables' schema and meaning. Changing it means refolding from the log. */
export const PROJECTION_VERSION = 2;

/** The topics the projection replays, besides the `journal-YYYY` segments. */
export const FIXED_TOPICS = ['state', 'checkpoints', 'budget', 'recon'] as const;

export function isProjectedTopic(topic: string): boolean {
  return (FIXED_TOPICS as readonly string[]).includes(topic) || segmentYear(topic) !== undefined;
}

/** A message as the log keeps it: the server's envelope, and the payload decrypted. */
export interface LogMessage {
  readonly hash: string;
  readonly prev: string | null;
  readonly type: string;
  readonly sender: string;
  /** `server_timestamp`, in milliseconds. */
  readonly ts: number;
  /**
   * The decrypted payload as text. Absent when the payload wasn't decrypted: State
   * messages outside the ledger's documents (membership, capabilities), which only hold
   * the chain together, and payloads that failed (`error`).
   */
  readonly body?: string;
  /** Why the payload couldn't be decrypted or decoded as text, if it couldn't. */
  readonly error?: string;
}

/** How far the log has replayed a topic. */
export interface Watermark {
  /** The newest message's hash: the next one must link to it. */
  readonly head: string;
  /** The newest message's `server_timestamp`; catching up asks for messages from here. */
  readonly ts: number;
  /** Messages in the log for this topic. */
  readonly count: number;
}

export interface TopicAnomaly extends Anomaly {
  readonly topic: string;
}

/** A topic whose fold stopped at a message type or `v` this client doesn't know. */
export interface Halt {
  readonly topic: string;
  readonly at: MsgId;
  readonly reason: string;
}

export type TxnKind = 'entry' | 'reversal' | 'lotadjust';

/** One split of one transaction, as an account's register shows it. */
export interface RegisterLine {
  readonly txn: MsgId;
  readonly kind: TxnKind;
  readonly topic: string;
  /** Position in the segment's chain. */
  readonly index: number;
  readonly date: IsoDate;
  readonly ts: number;
  readonly split: number;
  readonly amount: Amount;
  /** The account's balance in `amount`'s commodity after this line. */
  readonly balance: Amount;
  /**
   * The effective accounts of the transaction's other splits, after edits: each once, in
   * split order, without this account.
   */
  readonly others: readonly AccountId[];
  /** Effective payee and memo, after edits. */
  readonly payee?: PayeeId;
  readonly memo?: string;
  /** For a reversal: the entry it reverses. */
  readonly reverses?: MsgId;
  /** For an entry: the first reversal of it, in any segment. */
  readonly reversedBy?: MsgId;
  /** For an entry: the reversed entry it replaces. */
  readonly replaces?: MsgId;
  /** For an entry: the first entry that replaces it, in any segment. */
  readonly replacedBy?: MsgId;
  /**
   * An entry and its first reversal, dated the same day, shown as one line in the
   * reversal's place. `amount` is their net for this account, and `txn` is the entry.
   */
  readonly collapsed?: true;
}

const LOG_TABLES = ['meta', 'log', 'watermarks'];

const LOG_SCHEMA = `
  CREATE TABLE log (
    topic TEXT NOT NULL,
    pos INTEGER NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    prev TEXT,
    type TEXT NOT NULL,
    sender TEXT NOT NULL,
    ts INTEGER NOT NULL,
    body TEXT,
    error TEXT,
    PRIMARY KEY (topic, pos)
  ) STRICT;
  CREATE TABLE watermarks (
    topic TEXT PRIMARY KEY,
    head TEXT NOT NULL,
    ts INTEGER NOT NULL,
    count INTEGER NOT NULL
  ) STRICT;
`;

// Amounts are TEXT holding the wire Int, never INTEGER: SQLite integers are 64-bit, and
// wei overflows at about 9.2 ETH. `approx` is for ORDER BY and range filters only; nothing
// read from it is summed, compared for equality, or posted. See design/AMOUNTS.md.
const FOLD_SCHEMA = `
  CREATE TABLE folds (
    topic TEXT PRIMARY KEY,
    halted_at TEXT,
    halted_reason TEXT
  ) STRICT;
  CREATE TABLE docs (
    path TEXT PRIMARY KEY,
    msg TEXT NOT NULL,
    body TEXT NOT NULL
  ) STRICT;
  CREATE TABLE heads (
    topic TEXT NOT NULL,
    hash TEXT NOT NULL,
    final INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE txns (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    idx INTEGER NOT NULL,
    kind TEXT NOT NULL,
    date TEXT NOT NULL,
    ts INTEGER NOT NULL,
    payee TEXT,
    memo TEXT,
    reverses TEXT,
    replaces TEXT,
    receipts TEXT
  ) STRICT;
  CREATE INDEX txns_topic ON txns (topic);
  CREATE INDEX txns_reverses ON txns (reverses);
  CREATE INDEX txns_replaces ON txns (replaces);
  CREATE TABLE postings (
    txn TEXT NOT NULL,
    split INTEGER NOT NULL,
    topic TEXT NOT NULL,
    account TEXT NOT NULL,
    amount TEXT NOT NULL,
    exp INTEGER NOT NULL,
    cur TEXT NOT NULL,
    approx REAL NOT NULL,
    PRIMARY KEY (txn, split)
  ) STRICT;
  CREATE INDEX postings_account ON postings (account);
  CREATE INDEX postings_topic ON postings (topic);
  CREATE TABLE balances (
    topic TEXT NOT NULL,
    account TEXT NOT NULL,
    cur TEXT NOT NULL,
    amount TEXT NOT NULL,
    exp INTEGER NOT NULL,
    PRIMARY KEY (topic, account, cur)
  ) STRICT;
  CREATE TABLE allocated (
    envelope TEXT PRIMARY KEY,
    amount TEXT NOT NULL,
    exp INTEGER NOT NULL,
    cur TEXT NOT NULL
  ) STRICT;
  CREATE TABLE anomalies (
    topic TEXT NOT NULL,
    msg TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    edit INTEGER
  ) STRICT;
  CREATE INDEX anomalies_topic ON anomalies (topic);
`;

/** The tables holding one topic's fold, cleared before it is refolded. */
const PER_TOPIC_TABLES = ['folds', 'txns', 'postings', 'balances', 'anomalies'];

interface LogRow {
  hash: string;
  type: string;
  ts: number;
  body: string | null;
  error: string | null;
}

const approx = (a: { amount: bigint; exp: number }) => Number(a.amount) / 10 ** a.exp;

/**
 * The first reversal of the transaction `t`, in any segment. Reversals route by their own
 * date, so one in a later segment is found here and not by the segment fold.
 */
const REVERSED_BY = `(SELECT r.id FROM txns r WHERE r.reverses = t.id ORDER BY r.topic, r.idx LIMIT 1)`;

/** The first entry that replaces the transaction `t`, in any segment. */
const REPLACED_BY = `(SELECT r.id FROM txns r WHERE r.replaces = t.id AND r.kind = 'entry' ORDER BY r.topic, r.idx LIMIT 1)`;

type DraftLine = Omit<RegisterLine, 'balance'>;

export class Projection {
  private constructor(private readonly db: Database) {}

  /**
   * Opens the projection in `db`, creating it, or dropping and rebuilding whatever layer
   * was written by a different schema version.
   */
  static open(db: Database): Projection {
    const p = new Projection(db);
    p.db.transaction(() => p.migrate());
    return p;
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT');
    const version = (key: string) =>
      this.db.selectValue('SELECT value FROM meta WHERE key = ?', [key]) as number | undefined;

    if (version('log') !== LOG_VERSION) {
      this.dropTablesExcept(['meta']);
      this.db.exec(LOG_SCHEMA);
      this.db.exec(FOLD_SCHEMA);
    } else if (version('projection') !== PROJECTION_VERSION) {
      this.dropTablesExcept(LOG_TABLES);
      this.db.exec(FOLD_SCHEMA);
      this.refoldAll();
    } else {
      return;
    }
    const setVersion = 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)';
    this.db.exec({ sql: setVersion, bind: ['log', LOG_VERSION] });
    this.db.exec({ sql: setVersion, bind: ['projection', PROJECTION_VERSION] });
  }

  /** Drops every table not listed, including ones only an older schema had. */
  private dropTablesExcept(keep: readonly string[]): void {
    const tables = this.db.selectValues(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ) as string[];
    for (const t of tables) if (!keep.includes(t)) this.db.exec(`DROP TABLE "${t}"`);
  }

  // --- The log --------------------------------------------------------------------------

  watermark(topic: string): Watermark | undefined {
    const row = this.db.selectObject('SELECT head, ts, count FROM watermarks WHERE topic = ?', [topic]);
    return row as Watermark | undefined;
  }

  watermarks(): Record<string, Watermark> {
    const out: Record<string, Watermark> = {};
    for (const r of this.db.selectObjects('SELECT topic, head, ts, count FROM watermarks')) {
      out[r.topic as string] = { head: r.head as string, ts: r.ts as number, count: r.count as number };
    }
    return out;
  }

  /**
   * Adds `messages` to `topic`'s log and refolds whatever depends on them. They may come
   * in any order and may repeat messages already in the log, which are skipped, so a
   * caller can pass a whole page fetched from the watermark's timestamp. The rest must
   * continue the chain from the watermark, or this throws `ChainBrokenError` and changes
   * nothing. Returns how many messages were new.
   */
  append(topic: string, messages: readonly LogMessage[]): number {
    if (!isProjectedTopic(topic)) throw new RangeError(`${topic} is not a projected topic`);
    return this.db.transaction(() => {
      const fresh = new Map<string, LogMessage>();
      const known = this.db.prepare('SELECT 1 FROM log WHERE hash = ?');
      try {
        for (const m of messages) {
          const inLog = known.bind([m.hash]).step();
          known.reset();
          if (!inLog) fresh.set(m.hash, m);
        }
      } finally {
        known.finalize();
      }
      if (fresh.size === 0) return 0;

      const mark = this.watermark(topic);
      const ordered = chainOrder([...fresh.values()], (m) => ({ hash: m.hash, prev: m.prev }), mark?.head ?? null);
      const base = mark?.count ?? 0;
      this.insertMany(
        'INSERT INTO log (topic, pos, hash, prev, type, sender, ts, body, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ordered.map((m, i) => [topic, base + i, m.hash, m.prev, m.type, m.sender, m.ts, m.body ?? null, m.error ?? null]),
      );
      const last = ordered[ordered.length - 1];
      this.db.exec({
        sql: 'INSERT OR REPLACE INTO watermarks (topic, head, ts, count) VALUES (?, ?, ?, ?)',
        bind: [topic, last.hash, last.ts, base + ordered.length],
      });
      this.refoldFor(topic, ordered);
      return ordered.length;
    });
  }

  private logRows(topic: string): LogRow[] {
    return this.db.selectObjects(
      'SELECT hash, type, ts, body, error FROM log WHERE topic = ? ORDER BY pos',
      [topic],
    ) as unknown as LogRow[];
  }

  // --- Folding --------------------------------------------------------------------------

  private refoldFor(topic: string, appended: readonly LogMessage[]): void {
    if (topic === 'state') {
      const paths = new Set(appended.map((m) => m.type));
      if (![...paths].some(isStatePath)) return;
      this.refoldState();
      if (paths.has('ledger/accounts')) this.refoldSegments();
      if (paths.has('ledger/budget')) this.refoldBudget();
    } else if (topic === 'checkpoints') {
      this.refoldCheckpoints();
      this.refoldSegments();
    } else if (topic === 'budget') {
      this.refoldBudget();
    } else if (segmentYear(topic) !== undefined) {
      this.refoldSegment(topic, touchedBy(appended));
    }
    // `recon` has no fold yet (0018); its messages are only logged.
  }

  private refoldAll(): void {
    this.refoldState();
    this.refoldCheckpoints();
    this.refoldBudget();
    this.refoldSegments();
  }

  private refoldSegments(): void {
    const topics = this.db.selectValues(
      "SELECT topic FROM watermarks WHERE topic LIKE 'journal-%' ORDER BY topic",
    ) as string[];
    for (const t of topics) this.refoldSegment(t);
  }

  private clearTopic(topic: string): void {
    for (const t of PER_TOPIC_TABLES) this.db.exec({ sql: `DELETE FROM ${t} WHERE topic = ?`, bind: [topic] });
  }

  private recordFold(topic: string, anomalies: readonly Anomaly[], halted?: { at: MsgId; error: Error }): void {
    this.db.exec({
      sql: 'INSERT INTO folds (topic, halted_at, halted_reason) VALUES (?, ?, ?)',
      bind: [topic, halted?.at ?? null, halted?.error.message ?? null],
    });
    this.insertMany(
      'INSERT INTO anomalies (topic, msg, kind, detail, edit) VALUES (?, ?, ?, ?, ?)',
      anomalies.map((a) => [topic, a.msg, a.kind, a.detail, a.edit ?? null]),
    );
  }

  /**
   * The latest revision of each ledger State document. A revision that doesn't decode is
   * an anomaly and the previous one stands; one with an unknown `v` halts the State fold,
   * since later revisions may depend on it.
   */
  private refoldState(): void {
    this.clearTopic('state');
    this.db.exec('DELETE FROM docs');
    const anomalies: Anomaly[] = [];
    let halted: { at: MsgId; error: Error } | undefined;
    for (const row of this.logRows('state')) {
      if (!isStatePath(row.type)) continue;
      const id = row.hash as MsgId;
      try {
        if (row.error !== null) throw new CodecError(row.error);
        if (row.body === null) throw new CodecError('payload was not decrypted');
        // State has no delete, only a write of empty data. A cited document must never be
        // deleted, so that is corruption, not a reset.
        if (row.body === '') throw new CodecError(`${row.type} was deleted`);
        decodeState(row.type, parseJson(row.body));
      } catch (e) {
        if (e instanceof UnknownVersionError) {
          halted = { at: id, error: e };
          break;
        }
        if (e instanceof CodecError) {
          anomalies.push({ kind: 'malformed', msg: id, detail: `${row.type}: ${e.message}` });
          continue;
        }
        throw e;
      }
      this.db.exec({
        sql: 'INSERT OR REPLACE INTO docs (path, msg, body) VALUES (?, ?, ?)',
        bind: [row.type, row.hash, row.body],
      });
    }
    this.recordFold('state', anomalies, halted);
  }

  /** The heads cited by checkpoints, which lock (and, if final, freeze) their segments. */
  private refoldCheckpoints(): void {
    this.clearTopic('checkpoints');
    this.db.exec('DELETE FROM heads');
    const anomalies: Anomaly[] = [];
    let halted: { at: MsgId; error: Error } | undefined;
    const heads: BindableValue[][] = [];
    for (const raw of this.raw('checkpoints')) {
      try {
        if (raw.type !== 'ledger.checkpoint') throw new UnknownTypeError(raw.type);
        if (raw.error !== undefined) throw new CodecError(raw.error);
        const cp = decodeMessage('ledger.checkpoint', raw.data);
        for (const h of cp.heads) heads.push([h.topic, h.hash, h.final ? 1 : 0]);
      } catch (e) {
        if (e instanceof UnknownTypeError || e instanceof UnknownVersionError) {
          halted = { at: raw.id, error: e };
          break;
        }
        if (e instanceof CodecError) {
          anomalies.push({ kind: 'malformed', msg: raw.id, detail: e.message });
          continue;
        }
        throw e;
      }
    }
    this.insertMany('INSERT INTO heads (topic, hash, final) VALUES (?, ?, ?)', heads);
    this.recordFold('checkpoints', anomalies, halted);
  }

  private refoldBudget(): void {
    this.clearTopic('budget');
    this.db.exec('DELETE FROM allocated');
    const fold = foldBudget(this.raw('budget'), this.doc('ledger/budget') ?? EMPTY_BUDGET);
    this.insertMany(
      'INSERT INTO allocated (envelope, amount, exp, cur) VALUES (?, ?, ?, ?)',
      [...fold.allocated].map(([env, a]) => [env, String(a.amount), a.exp, a.cur]),
    );
    this.recordFold('budget', fold.anomalies, fold.halted);
  }

  /**
   * Refolds a segment. The fold always runs over the whole segment, but with `touched`
   * only those transactions' rows in this segment are rewritten: when messages are
   * appended and nothing else changed, no other row can differ. Balances, anomalies, and
   * the halt are small and always rewritten.
   */
  private refoldSegment(topic: string, touched?: ReadonlySet<string>): void {
    const rows = this.logRows(topic);
    const ts = new Map(rows.map((r) => [r.hash, r.ts]));
    const heads = this.db.selectObjects('SELECT hash, final FROM heads WHERE topic = ?', [topic]);
    const fold = foldSegment(topic, rows.map(toRaw), {
      chart: chartOf(this.doc('ledger/accounts') ?? EMPTY_CHART),
      lockHeads: heads.map((h) => h.hash as MsgId),
      finalHeads: heads.filter((h) => h.final === 1).map((h) => h.hash as MsgId),
    });

    if (touched) {
      for (const t of ['folds', 'balances', 'anomalies']) {
        this.db.exec({ sql: `DELETE FROM ${t} WHERE topic = ?`, bind: [topic] });
      }
      // Scoped to this topic: an edit naming an entry in another segment is ignored, and
      // must not take that entry's rows with it.
      const delPostings = this.db.prepare('DELETE FROM postings WHERE txn = ? AND topic = ?');
      const delTxn = this.db.prepare('DELETE FROM txns WHERE id = ? AND topic = ?');
      try {
        for (const id of touched) {
          delPostings.bind([id, topic]).stepReset();
          delTxn.bind([id, topic]).stepReset();
        }
      } finally {
        delPostings.finalize();
        delTxn.finalize();
      }
    } else {
      this.clearTopic(topic);
    }
    const write = (id: string) => touched === undefined || touched.has(id);

    const txns: BindableValue[][] = [];
    const postings: BindableValue[][] = [];
    const posting = (txn: MsgId, split: number, account: AccountId, a: { amount: bigint; exp: number; cur: Commodity }) =>
      postings.push([txn, split, topic, account, String(a.amount), a.exp, a.cur, approx(a)]);

    for (const e of fold.entries.values()) {
      if (!write(e.id)) continue;
      txns.push([
        e.id, topic, e.index, 'entry', e.entry.date, ts.get(e.id)!, e.payee ?? null, e.memo ?? null,
        null, e.entry.replaces ?? null, e.receipts.length > 0 ? JSON.stringify(e.receipts) : null,
      ]);
      e.entry.splits.forEach((s, i) => posting(e.id, i, e.accounts[i], s));
    }
    for (const r of fold.reversals.values()) {
      if (!write(r.id)) continue;
      const rev = r.reversal;
      txns.push([r.id, topic, r.index, 'reversal', rev.date, ts.get(r.id)!, null, rev.memo ?? null, rev.reverses, null, null]);
      rev.splits.forEach((s, i) => posting(r.id, i, s.account, s));
    }
    for (const { id, index, msg } of fold.lotAdjusts) {
      if (!write(id)) continue;
      txns.push([id, topic, index, 'lotadjust', msg.date, ts.get(id)!, null, msg.memo ?? null, null, null, null]);
      msg.adjustments.forEach((adj, i) =>
        posting(id, i, adj.account, { amount: adj.new_qty - adj.old_qty, exp: adj.exp, cur: adj.cur }),
      );
    }
    this.insertMany(
      `INSERT INTO txns (id, topic, idx, kind, date, ts, payee, memo, reverses, replaces, receipts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      txns,
    );
    this.insertMany(
      'INSERT INTO postings (txn, split, topic, account, amount, exp, cur, approx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      postings,
    );

    const bals: BindableValue[][] = [];
    for (const [account, byCur] of foldBalances([fold])) {
      for (const a of byCur.values()) bals.push([topic, account, a.cur, String(a.amount), a.exp]);
    }
    this.insertMany('INSERT INTO balances (topic, account, cur, amount, exp) VALUES (?, ?, ?, ?, ?)', bals);
    this.recordFold(topic, fold.anomalies, fold.halted);
  }

  private raw(topic: string): RawMessage[] {
    return this.logRows(topic).map(toRaw);
  }

  private insertMany(sql: string, rows: readonly BindableValue[][]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(sql);
    try {
      for (const r of rows) stmt.bind(r).stepReset();
    } finally {
      stmt.finalize();
    }
  }

  // --- Queries --------------------------------------------------------------------------

  /** The latest valid revision of a State document, or undefined if none was written. */
  doc<P extends StatePath>(path: P): StateDocs[P] | undefined {
    const body = this.db.selectValue('SELECT body FROM docs WHERE path = ?', [path]) as string | undefined;
    return body === undefined ? undefined : decodeState(path, parseJson(body));
  }

  /** The years listed in `ledger/journal`, which are the segments to replay. */
  years(): readonly number[] {
    return (this.doc('ledger/journal') ?? EMPTY_JOURNAL).years;
  }

  /**
   * Balance of every account per commodity, positive for a debit, as core's `balances`
   * computes it. Sums run in `bigint`, never in SQL. A window filters by date.
   */
  balances(window: BalanceWindow = {}): Balances {
    const rows =
      window.from === undefined && window.to === undefined
        ? this.db.selectObjects('SELECT account, cur, amount, exp FROM balances')
        : this.db.selectObjects(
            `SELECT p.account, p.cur, p.amount, p.exp FROM postings p JOIN txns t ON t.id = p.txn
             WHERE t.date >= ? AND t.date <= ?`,
            [window.from ?? '', window.to ?? '9999-12-31'],
          );
    const out: Balances = new Map();
    for (const r of rows) {
      const a: Amount = { amount: BigInt(r.amount as string), exp: r.exp as number, cur: commodity(r.cur as string) };
      let byCur = out.get(r.account as AccountId);
      if (!byCur) out.set(r.account as AccountId, (byCur = new Map()));
      const prev = byCur.get(a.cur);
      byCur.set(a.cur, prev ? add(prev, a) : a);
    }
    return out;
  }

  /**
   * Every split posted to `account`, in register order: by date, then by chain position.
   * Lines with the same date are in the same segment, since entries and reversals route
   * by their date's year. The running balance is summed in `bigint`, never in SQL.
   *
   * With `collapse`, an entry and its first reversal on the same date become one line
   * with their net, in the reversal's place, and the running balance is summed over the
   * lines as shown. A pair that nets to zero and has a replacement entry is left out, so
   * the replacement stands as the corrected line. A reversal on a later date stays its
   * own line: it moved the balance in a later period, and the register shows that.
   */
  register(account: AccountId, collapse = false): RegisterLine[] {
    const rows = this.db.selectObjects(
      `SELECT t.id, t.kind, t.topic, t.idx, t.date, t.ts, t.payee, t.memo, t.reverses, t.replaces,
              ${REVERSED_BY} AS reversed_by, ${REPLACED_BY} AS replaced_by, p.split, p.amount, p.exp, p.cur
       FROM postings p JOIN txns t ON t.id = p.txn
       WHERE p.account = ?
       ORDER BY t.date, t.topic, t.idx, p.split`,
      [account],
    );
    const others = new Map<string, AccountId[]>();
    const counterparts = this.db.selectObjects(
      `SELECT txn, account FROM postings
       WHERE txn IN (SELECT txn FROM postings WHERE account = ?) AND account != ?
       ORDER BY txn, split`,
      [account, account],
    );
    for (const r of counterparts) {
      let list = others.get(r.txn as string);
      if (!list) others.set(r.txn as string, (list = []));
      if (!list.includes(r.account as AccountId)) list.push(r.account as AccountId);
    }

    let lines: DraftLine[] = rows.map((r) => ({
      txn: r.id as MsgId,
      kind: r.kind as TxnKind,
      topic: r.topic as string,
      index: r.idx as number,
      date: r.date as IsoDate,
      ts: r.ts as number,
      split: r.split as number,
      amount: { amount: BigInt(r.amount as string), exp: r.exp as number, cur: commodity(r.cur as string) },
      others: others.get(r.id as string) ?? [],
      ...(r.payee !== null && { payee: r.payee as PayeeId }),
      ...(r.memo !== null && { memo: r.memo as string }),
      ...(r.reverses !== null && { reverses: r.reverses as MsgId }),
      ...(r.reversed_by !== null && { reversedBy: r.reversed_by as MsgId }),
      ...(r.replaces !== null && { replaces: r.replaces as MsgId }),
      ...(r.replaced_by !== null && { replacedBy: r.replaced_by as MsgId }),
    }));
    if (collapse) lines = collapsePairs(lines);

    const running = new Map<Commodity, Amount>();
    return lines.map((l) => {
      const prev = running.get(l.amount.cur);
      const balance = prev ? add(prev, l.amount) : l.amount;
      running.set(l.amount.cur, balance);
      return { ...l, balance };
    });
  }

  /**
   * The entry `id`, with its effective accounts, as a reversal or a replacement needs it.
   * Undefined if the projection holds no valid entry by that ID.
   */
  reversalTarget(id: MsgId): ReversalTarget | undefined {
    const t = this.db.selectObject(
      `SELECT t.id, t.topic, t.idx, t.date, ${REVERSED_BY} AS reversed_by, ${REPLACED_BY} AS replaced_by FROM txns t
       WHERE t.id = ? AND t.kind = 'entry'`,
      [id],
    );
    if (!t) return undefined;
    const { splits, accounts } = this.splitsOf(id);
    // The lock rule is positional: a close citing a head at or after the entry.
    const locked = this.db.selectValue(
      `SELECT 1 FROM heads h JOIN log l ON l.topic = h.topic AND l.hash = h.hash
       WHERE h.topic = ? AND l.pos >= ?`,
      [t.topic as string, t.idx as number],
    ) !== undefined;
    return {
      id,
      date: t.date as IsoDate,
      splits,
      accounts,
      locked,
      segmentOpen: !this.isFrozen(t.topic as string),
      ...(t.reversed_by !== null && { reversedBy: t.reversed_by as MsgId }),
      ...(t.replaced_by !== null && { replacedBy: t.replaced_by as MsgId }),
    };
  }

  /** Whether the segment of `year` is open: no close has frozen it. */
  segmentOpen(year: number): boolean {
    return !this.isFrozen(segmentOf(year));
  }

  private isFrozen(topic: string): boolean {
    return this.db.selectValue('SELECT 1 FROM heads WHERE topic = ? AND final = 1', [topic]) !== undefined;
  }

  /** A transaction's splits as posted, with the effective accounts. */
  private splitsOf(txn: MsgId): { splits: Split[]; accounts: AccountId[] } {
    const splits = this.db
      .selectObjects('SELECT account, amount, exp, cur FROM postings WHERE txn = ? ORDER BY split', [txn])
      .map((r) => ({
        account: r.account as AccountId,
        amount: BigInt(r.amount as string),
        exp: r.exp as number,
        cur: commodity(r.cur as string),
      }));
    return { splits, accounts: splits.map((s) => s.account) };
  }

  /** Σ allocations per envelope, from the `budget` fold. */
  allocated(): Map<EnvelopeId, Amount> {
    const out = new Map<EnvelopeId, Amount>();
    for (const r of this.db.selectObjects('SELECT envelope, amount, exp, cur FROM allocated')) {
      out.set(r.envelope as EnvelopeId, { amount: BigInt(r.amount as string), exp: r.exp as number, cur: commodity(r.cur as string) });
    }
    return out;
  }

  /** Every topic's fold anomalies, and the reversal anomalies that span segments. */
  anomalies(): TopicAnomaly[] {
    const folded = this.db.selectObjects('SELECT topic, msg, kind, detail, edit FROM anomalies').map((r) => ({
      topic: r.topic as string,
      msg: r.msg as MsgId,
      kind: r.kind as AnomalyKind,
      detail: r.detail as string,
      ...(r.edit !== null && { edit: r.edit as number }),
    }));
    return [...folded, ...this.reversalAnomalies()];
  }

  /**
   * Reversal anomalies, as core's `reversalAnomalies` defines them: a target reversed more
   * than once, and a reversal that isn't the inverse of its target's effective splits. A
   * reversal and its target may be in different segments, so these are found here rather
   * than by any one segment's fold. Only checked when the target is held.
   */
  private reversalAnomalies(): TopicAnomaly[] {
    const out: TopicAnomaly[] = [];
    const rows = this.db.selectObjects(
      `SELECT r.id, r.topic, r.reverses,
              (SELECT f.id FROM txns f WHERE f.reverses = r.reverses ORDER BY f.topic, f.idx LIMIT 1) AS first,
              EXISTS (SELECT 1 FROM txns e WHERE e.id = r.reverses AND e.kind = 'entry') AS held
       FROM txns r WHERE r.kind = 'reversal' ORDER BY r.topic, r.idx`,
    );
    for (const r of rows) {
      const id = r.id as MsgId;
      const topic = r.topic as string;
      if (r.first !== id) {
        out.push({ topic, kind: 'reversed-twice', msg: id, detail: `${r.reverses} was already reversed by ${r.first}` });
      }
      if (r.held && !isInverse(this.splitsOf(r.reverses as MsgId), this.splitsOf(id).splits)) {
        out.push({ topic, kind: 'reversal-mismatch', msg: id, detail: `splits are not the inverse of ${r.reverses}` });
      }
    }
    return out;
  }

  halts(): Halt[] {
    return this.db
      .selectObjects('SELECT topic, halted_at, halted_reason FROM folds WHERE halted_at IS NOT NULL')
      .map((r) => ({ topic: r.topic as string, at: r.halted_at as MsgId, reason: r.halted_reason as string }));
  }
}

/**
 * The transactions whose rows appending `messages` to a segment can change: their own,
 * and those they edit. A reversal changes no row of its target's: who reversed an entry
 * is looked up when it is queried. A message that doesn't decode changes nothing else.
 */
function touchedBy(messages: readonly LogMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    out.add(m.hash);
    const raw = toRaw({ hash: m.hash, type: m.type, ts: m.ts, body: m.body ?? null, error: m.error ?? null });
    try {
      if (m.type === 'ledger.edit') for (const e of decodeMessage('ledger.edit', raw.data).edits) out.add(e.target);
    } catch (e) {
      if (!(e instanceof CodecError)) throw e;
    }
  }
  return out;
}

/**
 * Folds each entry and its first reversal, dated the same day, into one line in the
 * reversal's place (see `register`).
 */
function collapsePairs(lines: readonly DraftLine[]): DraftLine[] {
  const byTxn = new Map<MsgId, DraftLine[]>();
  for (const l of lines) {
    const list = byTxn.get(l.txn);
    if (list) list.push(l);
    else byTxn.set(l.txn, [l]);
  }
  /** Each collapsing reversal's target. */
  const pairs = new Map<MsgId, MsgId>();
  for (const l of lines) {
    if (l.kind !== 'reversal' || l.reverses === undefined) continue;
    const target = byTxn.get(l.reverses)?.[0];
    if (target && target.date === l.date && target.reversedBy === l.txn) pairs.set(l.txn, l.reverses);
  }
  const targets = new Set(pairs.values());

  const out: DraftLine[] = [];
  for (const l of lines) {
    if (targets.has(l.txn)) continue;
    const target = pairs.get(l.txn);
    if (target === undefined) {
      out.push(l);
      continue;
    }
    const rev = byTxn.get(l.txn)!;
    if (l !== rev[0]) continue;
    const entry = byTxn.get(target)!;
    const amount = [...entry, ...rev].map((x) => x.amount).reduce((a, b) => add(a, b));
    if (amount.amount === 0n && entry[0].replacedBy !== undefined) continue;
    out.push({ ...entry[0], amount, collapsed: true });
  }
  return out;
}

function toRaw(row: LogRow): RawMessage {
  const id = row.hash as MsgId;
  if (row.error !== null) return { id, type: row.type, data: undefined, error: row.error };
  if (row.body === null) return { id, type: row.type, data: undefined, error: 'payload was not decrypted' };
  try {
    return { id, type: row.type, data: parseJson(row.body) };
  } catch (e) {
    if (e instanceof CodecError) return { id, type: row.type, data: undefined, error: e.message };
    throw e;
  }
}
