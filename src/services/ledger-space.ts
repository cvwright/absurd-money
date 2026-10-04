/**
 * Ledger Space Service
 *
 * One set of books is one reeeductio space. This wraps the SDK's `Space` with the
 * ledger's operations. For now that is authentication, the chart of accounts
 * (`ledger/accounts`), the budget document (`ledger/budget`), the list of journal years
 * (`ledger/journal`), the payee list (`ledger/payees`), posting entries, reversals, and edits to the journal, receipts as
 * encrypted blobs, reading a journal segment, and fetching and decrypting messages for the
 * sync (sync.ts); the other State documents come in later issues.
 */

import { ChainError, decodeUrlSafeBase64, NotFoundError, Space, type Message } from 'reeeductio';
import { budgetUpdateProblems, EMPTY_BUDGET } from '@/core/budget.js';
import { chainOrder } from '@/core/chain.js';
import { chartOf, chartUpdateProblems, EMPTY_CHART, type Chart } from '@/core/chart.js';
import { CodecError } from '@/core/errors.js';
import type { RawMessage } from '@/core/fold/segment.js';
import { editPostProblems, packEdits, type EditTarget } from '@/core/edit.js';
import { base64url, isBlobId, newPayeeId, segmentOf, yearOf, type BlobRef, type MsgId, type PayeeId } from '@/core/ids.js';
import { EMPTY_JOURNAL, journalUpdateProblems, withYear } from '@/core/journal.js';
import { parseJsonBytes } from '@/core/json.js';
import {
  encodeMessage, isStatePath, TOPIC_TYPES, type AccountsDoc, type BudgetDoc, type Edit, type Entry,
  type MessageTypes, type PayeesDoc, type Reversal,
} from '@/core/messages.js';
import { cleanPayeeName, EMPTY_PAYEES, findPayee, payeesUpdateProblems, withPayee } from '@/core/payees.js';
import { reversalPostProblems, type ReversalTarget } from '@/core/reversal.js';
import { entryPostProblems } from '@/core/validate.js';
import type { LogMessage } from '@/projection/projection.js';
import type { SpaceCredentials } from './credentials.js';
import {
  loadDoc,
  StaleHeadError,
  updateDoc,
  type DocSpec,
  type StateBackend,
} from './state-store.js';

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

/** An entry, reversal, or edit broke the post-time rules in design/SCHEMAS.md. Nothing was posted. */
export class InvalidEntryError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join('; '));
    this.name = 'InvalidEntryError';
  }
}

export class LedgerSpace {
  readonly space: Space;
  private readonly state: StateBackend;
  private authPromise: Promise<void> | null = null;
  /** Years seen listed in `ledger/journal`. Years are never removed, so this never goes stale. */
  private readonly listedYears = new Set<number>();

  constructor(creds: SpaceCredentials) {
    this.space = new Space({
      spaceId: creds.spaceId,
      keyPair: creds.keyPair,
      symmetricRoot: creds.symmetricRoot,
      baseUrl: creds.baseUrl,
      fetch: fetch.bind(window),
    });
    this.state = sdkStateBackend(this.space, () => this.authenticate());
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

  /** The years that have a `journal-YYYY` segment, ascending. */
  async loadJournalYears(): Promise<readonly number[]> {
    const { years } = await loadDoc(this.state, JOURNAL);
    for (const y of years) this.listedYears.add(y);
    return years;
  }

  /**
   * Posts `entry` to the `journal-YYYY` segment of its date, after checking it against
   * the post-time rules with the latest chart and payee list. An entry with `replaces` needs `replaced`,
   * the entry it names (`Projection.reversalTarget`). Returns the new message's ID.
   *
   * A `ChainError` means another message landed on the segment first. It is not retried
   * here (0017).
   */
  async postEntry(entry: Entry, replaced?: ReversalTarget): Promise<MsgId> {
    const [chart, payees] = await Promise.all([
      this.loadAccounts().then(chartOf),
      entry.payee ? this.loadPayees() : undefined,
    ]);
    // No segment can be frozen until the period close exists (0016).
    const problems = entryPostProblems(entry, {
      chart, segmentOpen: true, ...(payees && { payees }), ...(replaced && { replaced }),
    });
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
   * then reports the second reversal as an anomaly. A `ChainError` is not retried (0017).
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
   * holds each edited entry as the projection holds it (`Projection.editTarget`). Nothing is posted unless every edit passes. Returns the new
   * messages' IDs.
   *
   * Edits in one message stand or fall separately, and so do messages: if a post fails,
   * the ones before it stay posted. A `ChainError` is not retried (0017).
   */
  async postEdits(edits: readonly Edit[], targets: ReadonlyMap<MsgId, EditTarget>): Promise<MsgId[]> {
    const [chart, payees] = await Promise.all([
      this.loadAccounts().then(chartOf),
      edits.some((e) => e.payee) ? this.loadPayees() : undefined,
    ]);
    const problems = edits.flatMap((e) =>
      editPostProblems(e, { chart, target: targets.get(e.target), ...(payees && { payees }) }),
    );
    if (problems.length > 0) throw new InvalidEntryError(problems);
    const ids: MsgId[] = [];
    for (const { year, msg } of packEdits(edits, (t) => targets.get(t)!.year)) {
      ids.push(await this.postToSegment(year, 'ledger.edit', msg));
    }
    return ids;
  }

  /** Encrypts `bytes` under a fresh key and uploads them, for an entry's `receipts`. */
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
   * message type's routing rule (design/SCHEMAS.md).
   */
  private async postToSegment<T extends JournalType>(
    year: number,
    type: T,
    msg: MessageTypes[T],
  ): Promise<MsgId> {
    const topic = segmentOf(year);
    const data = new TextEncoder().encode(encodeMessage(type, msg));
    await this.listYear(year);
    await this.authenticate();
    const prev = await topicHead(this.space, topic);
    const { message_hash } = await this.space.postEncryptedMessage(topic, type, data, prev);
    return message_hash as MsgId;
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
