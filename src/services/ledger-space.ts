/**
 * Ledger Space Service
 *
 * One set of books is one reeeductio space. This wraps the SDK's `Space` with the
 * ledger's operations. For now that is authentication, the chart of accounts
 * (`ledger/accounts`), the owner's password (0033), the budget document
 * (`ledger/budget`), the list of journal years (`ledger/journal`), the payee list
 * (`ledger/payees`), the import rules (`ledger/rules`) and profiles
 * (`ledger/import-profiles`), the `import/v1` labels of statement rows (0023), posting
 * entries, reversals, edits, and dismissals to the journal, period closes to
 * `checkpoints`, statement reconciliations to `recon`, receipts and imported files as
 * encrypted blobs, reading a journal segment, and fetching and decrypting messages for
 * the sync (sync.ts). A post that loses the race for its topic's chain is retried against
 * the new head (topic-append.ts).
 */

import { ChainError, decodeUrlSafeBase64, NotFoundError, Space, type Message } from 'reeeductio';
import { budgetUpdateProblems, EMPTY_BUDGET } from '@/core/budget.js';
import { chainOrder } from '@/core/chain.js';
import { chartOf, chartUpdateProblems, EMPTY_CHART, type Chart } from '@/core/chart.js';
import { closePostProblems, periodClose, periodYear } from '@/core/close.js';
import { CodecError } from '@/core/errors.js';
import type { RawMessage } from '@/core/fold/segment.js';
import type { ImportRow } from '@/core/csv-import.js';
import { editPostProblems, packEdits, type EditTarget } from '@/core/edit.js';
import {
  base64url, isBlobId, newPayeeId, segmentOf, yearOf, type AccountId, type BlobRef, type Label, type MsgId, type PayeeId,
} from '@/core/ids.js';
import { EMPTY_PROFILES, profilesUpdateProblems } from '@/core/import-profiles.js';
import { dismissPostProblems, labelRows, packDismissals, type DismissRow, type LabeledRow } from '@/core/import-ids.js';
import { EMPTY_JOURNAL, journalUpdateProblems, withYear } from '@/core/journal.js';
import { parseJsonBytes } from '@/core/json.js';
import { deriveLabelKeys, type LabelKeys } from '@/core/labels.js';
import {
  encodeMessage, isStatePath, TOPIC_TYPES, type AccountsDoc, type BudgetDoc, type Edit, type Entry,
  type ImportProfilesDoc, type MessageTypes, type PayeesDoc, type Recon, type Reversal, type RulesDoc,
} from '@/core/messages.js';
import { cleanPayeeName, EMPTY_PAYEES, findPayee, payeesUpdateProblems, withPayee } from '@/core/payees.js';
import { reconPostProblems, type ReconPostContext } from '@/core/recon.js';
import { EMPTY_RULES, rulesUpdateProblems } from '@/core/rules.js';
import { reversalPostProblems, type ReversalTarget } from '@/core/reversal.js';
import { entryPostProblems } from '@/core/validate.js';
import type { LogMessage } from '@/projection/projection.js';
import { OWNER_USERNAME, type SpaceCredentials } from './credentials.js';
import {
  loadDoc,
  StaleHeadError,
  updateDoc,
  type DocSpec,
  type StateBackend,
} from './state-store.js';
import { appendMessage, type TopicBackend } from './topic-append.js';

export const ACCOUNTS: DocSpec<'ledger/accounts'> = {
  path: 'ledger/accounts',
  empty: EMPTY_CHART,
  problems: chartUpdateProblems,
};

export const JOURNAL: DocSpec<'ledger/journal'> = {
  path: 'ledger/journal',
  empty: EMPTY_JOURNAL,
  problems: journalUpdateProblems,
};

export const PAYEES: DocSpec<'ledger/payees'> = {
  path: 'ledger/payees',
  empty: EMPTY_PAYEES,
  problems: payeesUpdateProblems,
};

type JournalType = (typeof TOPIC_TYPES.journal)[number];

/** The most messages the server returns per request. */
const PAGE = 1000;

/**
 * The budget document's spec, checked against `chart`. A chart read a moment ago is safe
 * to check against: accounts are never removed and their `type` and `cur` never change,
 * so a stale chart can only reject a reference to a brand-new account, never accept a bad
 * one.
 */
export function budgetSpec(chart: Chart): DocSpec<'ledger/budget'> {
  return {
    path: 'ledger/budget',
    empty: EMPTY_BUDGET,
    problems: (prev, next) => budgetUpdateProblems(prev, next, chart),
  };
}

/**
 * The rule list's spec, checked against `chart` and `payees`. Like `budgetSpec`, a stale
 * chart or payee list can only reject a reference to something brand new, since neither
 * ever loses an entry.
 */
export function rulesSpec(chart: Chart, payees: PayeesDoc): DocSpec<'ledger/rules'> {
  return {
    path: 'ledger/rules',
    empty: EMPTY_RULES,
    problems: (prev, next) => rulesUpdateProblems(prev, next, { chart, payees }),
  };
}

/**
 * The import profiles' spec, checked against `chart`. Like `budgetSpec`, a stale chart can
 * only reject a brand-new account.
 */
export function profilesSpec(chart: Chart): DocSpec<'ledger/import-profiles'> {
  return {
    path: 'ledger/import-profiles',
    empty: EMPTY_PROFILES,
    problems: (prev, next) => profilesUpdateProblems(prev, next, chart),
  };
}

/** An entry, reversal, edit, dismissal, close, or reconciliation broke the post-time rules in design/SCHEMAS.md. Nothing was posted. */
export class InvalidEntryError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join('; '));
    this.name = 'InvalidEntryError';
  }
}

export class LedgerSpace {
  readonly space: Space;
  private readonly state: StateBackend;
  private readonly topics: TopicBackend;
  private authPromise: Promise<void> | null = null;
  /** Years seen listed in `ledger/journal`. Years are never removed, so this never goes stale. */
  private readonly listedYears = new Set<number>();
  /** The label keys, derived once from the space's root and dropped with this object. */
  private readonly labelKeys: LabelKeys;

  constructor(creds: SpaceCredentials) {
    this.space = new Space({
      spaceId: creds.spaceId,
      keyPair: creds.keyPair,
      symmetricRoot: creds.symmetricRoot,
      baseUrl: creds.baseUrl,
      fetch: fetch.bind(window),
    });
    this.labelKeys = deriveLabelKeys(creds.symmetricRoot, creds.spaceId);
    this.state = sdkStateBackend(this.space, () => this.authenticate());
    this.topics = sdkTopicBackend(this.space, () => this.authenticate());
  }

  get spaceId(): string {
    return this.space.spaceId;
  }

  /**
   * Authenticates once and shares the result. The server keeps one outstanding challenge
   * per user, so two concurrent attempts would make one fail with a spurious 401. With
   * `auto_create_spaces`, the first authentication also creates the space.
   */
  authenticate(): Promise<void> {
    if (!this.authPromise) {
      this.authPromise = this.space.authenticate().then(
        () => undefined,
        (err: unknown) => {
          this.authPromise = null;
          throw err;
        },
      );
    }
    return this.authPromise;
  }

  /**
   * Sets the owner's password, or replaces it: the keys are wrapped under the password's
   * OPAQUE export key and stored on the server, so the password opens the books on any
   * device. Only the space's creator can do this. Enabling OPAQUE on the space is
   * idempotent, so it is simply done every time.
   */
  async setPassword(password: string): Promise<void> {
    await this.authenticate();
    await this.space.enableOpaque();
    await this.space.opaqueRegister(OWNER_USERNAME, password);
  }

  /** The chart of accounts. A space whose chart was never written has an empty one. */
  loadAccounts(): Promise<AccountsDoc> {
    return loadDoc(this.state, ACCOUNTS);
  }

  /**
   * Rewrites the chart as `edit` of the current one, checked against the post-time rules
   * in design/SCHEMAS.md. `edit` is re-run on a fresh chart if another write wins the
   * race. Returns the chart written.
   */
  updateAccounts(edit: (doc: AccountsDoc) => AccountsDoc): Promise<AccountsDoc> {
    return updateDoc(this.state, ACCOUNTS, edit);
  }

  /** The budget document. A space whose budget was never written has an empty one. */
  loadBudget(): Promise<BudgetDoc> {
    // Loading never checks the update rules, so no chart is needed.
    return loadDoc(this.state, budgetSpec(new Map()));
  }

  /**
   * Rewrites the budget document as `edit` of the current one, checked against the
   * post-time rules and the latest chart. `edit` is re-run on a fresh document if another
   * write wins the race. Returns the document written.
   */
  async updateBudget(edit: (doc: BudgetDoc) => BudgetDoc): Promise<BudgetDoc> {
    const chart = chartOf(await this.loadAccounts());
    return updateDoc(this.state, budgetSpec(chart), edit);
  }

  /** The payee list. A space whose payees were never written has an empty one. */
  loadPayees(): Promise<PayeesDoc> {
    return loadDoc(this.state, PAYEES);
  }

  /**
   * The payee named `name` (`findPayee`), added to `ledger/payees` with a random ID if
   * there is none. Nothing is written if it already exists, including when another device
   * adds it during the race.
   */
  async addPayee(name: string): Promise<PayeeId> {
    const clean = cleanPayeeName(name);
    if (clean === '') throw new Error('A payee needs a name.');
    const found = findPayee(await this.loadPayees(), clean);
    if (found) return found;
    const fresh = newPayeeId(crypto.getRandomValues(new Uint8Array(15)));
    const doc = await updateDoc(this.state, PAYEES, (d) => (findPayee(d, clean) ? d : withPayee(d, fresh, clean)));
    return findPayee(doc, clean)!;
  }

  /** The import rules. A space whose rules were never written has an empty list. */
  loadRules(): Promise<RulesDoc> {
    // Loading never checks the update rules, so no chart or payees are needed.
    return loadDoc(this.state, rulesSpec(new Map(), EMPTY_PAYEES));
  }

  /**
   * Rewrites the rule list as `edit` of the current one, checked against the post-time
   * rules, the latest chart, and the latest payee list. `edit` is re-run on a fresh list
   * if another write wins the race. Returns the list written.
   */
  async updateRules(edit: (doc: RulesDoc) => RulesDoc): Promise<RulesDoc> {
    const [accounts, payees] = await Promise.all([this.loadAccounts(), this.loadPayees()]);
    return updateDoc(this.state, rulesSpec(chartOf(accounts), payees), edit);
  }

  /** The CSV mapping profiles. A space whose profiles were never written has none. */
  loadProfiles(): Promise<ImportProfilesDoc> {
    return loadDoc(this.state, profilesSpec(new Map()));
  }

  /**
   * Rewrites the profiles as `edit` of the current ones, checked against the post-time
   * rules and the latest chart. `edit` is re-run on a fresh document if another write wins
   * the race. Returns the document written.
   */
  async updateProfiles(edit: (doc: ImportProfilesDoc) => ImportProfilesDoc): Promise<ImportProfilesDoc> {
    const chart = chartOf(await this.loadAccounts());
    return updateDoc(this.state, profilesSpec(chart), edit);
  }

  /** Each row of a statement imported into `account`, with its `import/v1` label (0023). */
  labelRows(rows: readonly ImportRow[], account: AccountId): LabeledRow[] {
    return labelRows(rows, account, this.labelKeys);
  }

  /** The years that have a `journal-YYYY` segment, ascending. */
  async loadJournalYears(): Promise<readonly number[]> {
    const { years } = await loadDoc(this.state, JOURNAL);
    for (const y of years) this.listedYears.add(y);
    return years;
  }

  /**
   * Posts `entry` to the `journal-YYYY` segment of its date, after checking it against
   * the post-time rules with the latest chart and payee list. `segmentOpen` says whether
   * that segment is open (`Projection.segmentOpen`). An entry with `replaces` needs `replaced`,
   * the entry it names (`Projection.reversalTarget`). An entry whose splits carry
   * `import_id`s needs `consumed`, which of those labels are consumed
   * (`Projection.consumed`). Returns the new message's ID.
   *
   * If another message lands on the segment first, the post is retried against the new
   * head. Nothing in the rules depends on the segment's other messages, so the entry is
   * not checked again.
   */
  async postEntry(
    entry: Entry,
    segmentOpen: boolean,
    replaced?: ReversalTarget,
    consumed?: ReadonlySet<Label>,
  ): Promise<MsgId> {
    const [chart, payees] = await Promise.all([
      this.loadAccounts().then(chartOf),
      entry.payee ? this.loadPayees() : undefined,
    ]);
    const problems = entryPostProblems(entry, {
      chart, segmentOpen, ...(payees && { payees }), ...(replaced && { replaced }),
      ...(consumed && { isConsumed: (l: Label) => consumed.has(l) }),
    });
    if (!consumed && entry.splits.some((s) => s.import_id !== undefined)) {
      problems.push('import rows need the consumed import labels');
    }
    if (problems.length > 0) throw new InvalidEntryError(problems);
    return this.postToSegment(yearOf(entry.date), 'ledger.entry', entry);
  }

  /**
   * Posts `reversal` to the `journal-YYYY` segment of its own date, after checking it
   * against the post-time rules with the latest chart. `target` is the entry it reverses,
   * as the projection holds it (`Projection.reversalTarget`), and `segmentOpen` says
   * whether the reversal's own segment is open. Returns the new message's ID.
   *
   * Another device may reverse the same entry between the check and the post; the fold
   * then reports the second reversal as an anomaly. Like `postEntry`, a post that loses
   * the race for the segment is retried.
   */
  async postReversal(reversal: Reversal, target: ReversalTarget | undefined, segmentOpen: boolean): Promise<MsgId> {
    const chart = chartOf(await this.loadAccounts());
    const problems = reversalPostProblems(reversal, { chart, target, segmentOpen });
    if (problems.length > 0) throw new InvalidEntryError(problems);
    return this.postToSegment(yearOf(reversal.date), 'ledger.reversal', reversal);
  }

  /**
   * Posts `edits` as `ledger.edit` messages, each to its target's segment, after checking
   * every edit against the post-time rules with the latest chart and payee list. `targets`
   * holds each edited entry as the projection holds it (`Projection.editTarget`). Edits
   * that set `import_ids` need `consumed`, which of those labels are consumed
   * (`Projection.consumed`). Nothing is posted unless every edit passes. Returns the new
   * messages' IDs.
   *
   * Edits in one message stand or fall separately, and so do messages: if a post fails,
   * the ones before it stay posted. Like `postEntry`, a post that loses the race for the
   * segment is retried.
   */
  async postEdits(
    edits: readonly Edit[],
    targets: ReadonlyMap<MsgId, EditTarget>,
    consumed?: ReadonlySet<Label>,
  ): Promise<MsgId[]> {
    const [chart, payees] = await Promise.all([
      this.loadAccounts().then(chartOf),
      edits.some((e) => e.payee) ? this.loadPayees() : undefined,
    ]);
    const problems = edits.flatMap((e) =>
      editPostProblems(e, { chart, target: targets.get(e.target), ...(payees && { payees }), ...(consumed && { consumed }) }),
    );
    if (problems.length > 0) throw new InvalidEntryError(problems);
    const ids: MsgId[] = [];
    for (const { year, msg } of packEdits(edits, (t) => targets.get(t)!.year)) {
      ids.push(await this.postToSegment(year, 'ledger.edit', msg));
    }
    return ids;
  }

  /**
   * Dismisses import rows (0023): posts `ledger.dismiss` messages to the segment of each
   * row's year, after checking that no row is consumed (`Projection.consumed`) and that
   * each segment is open (`Projection.segmentOpen`). Nothing is posted unless every
   * message passes. Returns the new messages' IDs.
   *
   * Like `postEdits`, if a post fails, the ones before it stay posted.
   */
  async postDismissals(
    rows: readonly DismissRow[],
    ctx: { consumed: ReadonlySet<Label>; segmentOpen: (year: number) => boolean },
  ): Promise<MsgId[]> {
    const msgs = packDismissals(rows);
    const problems = msgs.flatMap(({ year, msg }) =>
      dismissPostProblems(msg, { consumed: ctx.consumed, segmentOpen: ctx.segmentOpen(year), year }),
    );
    if (problems.length > 0) throw new InvalidEntryError(problems);
    const ids: MsgId[] = [];
    for (const { year, msg } of msgs) ids.push(await this.postToSegment(year, 'ledger.dismiss', msg));
    return ids;
  }

  /**
   * Closes `period` (`YYYY`, `YYYY-MM`, or `YYYY-Qn`): posts a `ledger.checkpoint` to
   * `checkpoints` citing the current head of its year's segment, which locks everything
   * posted there so far. With `final`, the close also freezes the segment, so nothing more
   * can be posted to it. `segmentOpen` says whether it is open now
   * (`Projection.segmentOpen`). Returns the new message's ID.
   *
   * A message posted to the segment between reading its head and posting the close is
   * left unlocked, and with `final` it is ignored by the fold. If another close lands on
   * `checkpoints` first, the close is rebuilt on the segment's new head and posted again.
   */
  async postClose(period: string, opts: { final: boolean; segmentOpen: boolean }): Promise<MsgId> {
    const year = periodYear(period);
    if (year === undefined) throw new InvalidEntryError([`${period} is not a year, month, or quarter`]);
    const topic = segmentOf(year);
    const years = await this.loadJournalYears();
    const id = await appendMessage(this.topics, 'checkpoints', 'ledger.checkpoint', async () => {
      const head = await this.topics.head(topic);
      if (head === null) throw new InvalidEntryError([`${topic} has nothing to close`]);
      const close = periodClose(period, head as MsgId, opts.final);
      const problems = closePostProblems(close, { years, segmentOpen: () => opts.segmentOpen });
      if (problems.length > 0) throw new InvalidEntryError(problems);
      return new TextEncoder().encode(encodeMessage('ledger.checkpoint', close));
    });
    return id as MsgId;
  }

  /**
   * Posts a completed statement reconciliation to `recon`, after checking it against the
   * post-time rules with the latest chart. `ctx` is what the projection holds for the
   * account (`Projection.reconciliations` and `Projection.reconcilable`). Returns the new
   * message's ID.
   *
   * Like `postEntry`, a post that loses the race for the topic is retried without checking
   * again. If another device reconciled the same transactions meanwhile, both recons count
   * and the fold reports the later one as `cleared-twice`.
   */
  async postRecon(recon: Recon, ctx: Omit<ReconPostContext, 'chart'>): Promise<MsgId> {
    const chart = chartOf(await this.loadAccounts());
    const problems = reconPostProblems(recon, { ...ctx, chart });
    if (problems.length > 0) throw new InvalidEntryError(problems);
    const data = new TextEncoder().encode(encodeMessage('ledger.recon', recon));
    return (await appendMessage(this.topics, 'recon', 'ledger.recon', () => data)) as MsgId;
  }

  /** Encrypts `bytes` under a fresh key and uploads them, for an entry's `receipts` or `source`. */
  async uploadReceipt(bytes: Uint8Array): Promise<BlobRef> {
    await this.authenticate();
    const { blob_id, key } = await this.space.encryptAndUploadBlob(bytes);
    if (!isBlobId(blob_id)) throw new Error(`the server returned a bad blob ID: ${blob_id}`);
    return { blob: blob_id, dek: base64url(key) };
  }

  /** Downloads and decrypts a receipt. */
  async downloadReceipt(ref: BlobRef): Promise<Uint8Array> {
    await this.authenticate();
    return this.space.downloadAndDecryptBlob(ref.blob, decodeUrlSafeBase64(ref.dek));
  }

  /**
   * Posts `msg` to the segment of `year`, listing the year in `ledger/journal` first, so
   * no segment exists that a reader can't find. The caller picks the year by the
   * message type's routing rule (design/SCHEMAS.md). Retried if another message lands
   * on the segment first.
   */
  private async postToSegment<T extends JournalType>(
    year: number,
    type: T,
    msg: MessageTypes[T],
  ): Promise<MsgId> {
    const data = new TextEncoder().encode(encodeMessage(type, msg));
    await this.listYear(year);
    return (await appendMessage(this.topics, segmentOf(year), type, () => data)) as MsgId;
  }

  /** Makes sure `year` is listed in `ledger/journal`. Costs nothing once it has been seen. */
  private async listYear(year: number): Promise<void> {
    if (this.listedYears.has(year)) return;
    // Read before writing, so a listed year doesn't cost a State write.
    if ((await this.loadJournalYears()).includes(year)) return;
    const { years } = await updateDoc(this.state, JOURNAL, (doc) => withYear(doc, year));
    for (const y of years) this.listedYears.add(y);
  }

  /**
   * Every message in the segment of `year`, decrypted, in chain order, ready for
   * `foldSegment`. A segment that was never posted to is empty. A payload that can't be
   * decrypted or parsed comes back with `error` set, for the fold to count as malformed.
   *
   * Throws `ChainBrokenError` if the messages don't form one chain.
   */
  async readSegment(year: number): Promise<RawMessage[]> {
    const topic = segmentOf(year);
    await this.authenticate();
    const messages = chainOrder(await allMessages(this.space, topic), (m) => ({
      hash: m.message_hash,
      prev: m.prev_hash,
    }));
    return messages.map((m) => this.decrypt(m, topic));
  }

  /** Every message on `topic` with a `server_timestamp` of `from` or later. For the sync. */
  async fetchSince(topic: string, from: number): Promise<Message[]> {
    await this.authenticate();
    return allMessages(this.space, topic, from);
  }

  /**
   * `m` as the projection's log keeps it. State messages outside the ledger's documents
   * (membership, capabilities) aren't ours to decrypt; they are logged only to keep the
   * state chain whole.
   */
  toLog(m: Message): LogMessage {
    const envelope = { hash: m.message_hash, prev: m.prev_hash, type: m.type, sender: m.sender, ts: m.server_timestamp };
    if (m.topic_id === 'state' && !isStatePath(m.type)) return envelope;
    let bytes: Uint8Array;
    try {
      bytes = this.space.decryptMessageData(m, m.topic_id);
    } catch {
      return { ...envelope, error: 'payload could not be decrypted' };
    }
    try {
      return { ...envelope, body: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch {
      return { ...envelope, error: 'invalid UTF-8' };
    }
  }

  /** The WebSocket URL of the space's message stream, with a fresh token. */
  async streamUrl(): Promise<string> {
    await this.authenticate();
    return this.space.getWebSocketConnectionUrl();
  }

  /**
   * Checks a message from the stream: its hash must be the hash of its contents. Messages
   * fetched over HTTP are checked by the SDK.
   */
  verify(m: Message): Promise<void> {
    return this.space.handleIncomingMessage(m);
  }

  private decrypt(m: Message, topic: string): RawMessage {
    const id = m.message_hash as MsgId;
    let bytes: Uint8Array;
    try {
      bytes = this.space.decryptMessageData(m, topic);
    } catch {
      return { id, type: m.type, data: undefined, error: 'payload could not be decrypted' };
    }
    try {
      return { id, type: m.type, data: parseJsonBytes(bytes) };
    } catch (err) {
      if (err instanceof CodecError) return { id, type: m.type, data: undefined, error: err.message };
      throw err;
    }
  }
}

/**
 * Every message on `topic` from timestamp `from` on, oldest first by server timestamp.
 * `from` is inclusive, so each page after the first starts at the last page's newest
 * timestamp and repeats are dropped by hash.
 */
async function allMessages(space: Space, topic: string, from = 0): Promise<Message[]> {
  const seen = new Map<string, Message>();
  for (;;) {
    const { messages, has_more } = await space.getMessages(topic, { from, limit: PAGE }, { useCache: false });
    let added = 0;
    for (const m of messages) {
      if (seen.has(m.message_hash)) continue;
      seen.set(m.message_hash, m);
      added++;
      from = Math.max(from, m.server_timestamp);
    }
    if (!has_more) return [...seen.values()];
    // Only possible if a whole page shares one timestamp, which paging by time can't get past.
    if (added === 0) throw new Error(`${topic}: more than ${PAGE} messages share timestamp ${from}`);
  }
}

/**
 * The newest message hash on `topic`, or null if it is empty. `from` is unbounded rather
 * than `Date.now()`, so a client clock behind the server's can't hide the newest message
 * and pin us to a stale head.
 */
async function topicHead(space: Space, topic: string): Promise<string | null> {
  const { messages } = await space.getMessages(
    topic,
    { from: Number.MAX_SAFE_INTEGER, to: 0, limit: 1 },
    { useCache: false },
  );
  return messages[0]?.message_hash ?? null;
}

/** Topics through the SDK, each encrypted under its own topic key. */
function sdkTopicBackend(space: Space, ready: () => Promise<void>): TopicBackend {
  return {
    async head(topic) {
      await ready();
      return topicHead(space, topic);
    },

    async post(topic, type, data, prevHash) {
      await ready();
      try {
        return (await space.postEncryptedMessage(topic, type, data, prevHash)).message_hash;
      } catch (err) {
        // A 409 from a post means `prev_hash` is no longer the head.
        if (err instanceof ChainError) throw new StaleHeadError();
        throw err;
      }
    },
  };
}

/** State through the SDK, encrypted under the space's state key. */
function sdkStateBackend(space: Space, ready: () => Promise<void>): StateBackend {
  return {
    async head() {
      await ready();
      return topicHead(space, 'state');
    },

    async read(path) {
      await ready();
      try {
        return await space.getEncryptedState(path);
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },

    async write(path, data, prevHash) {
      await ready();
      try {
        await space.setEncryptedState(path, data, prevHash);
      } catch (err) {
        // A 409 from a post means `prev_hash` is no longer the head.
        if (err instanceof ChainError) throw new StaleHeadError();
        throw err;
      }
    },
  };
}
