/**
 * Ledger Space Service
 *
 * One set of books is one reeeductio space. This wraps the SDK's `Space` with the
 * ledger's operations. For now that is authentication, the chart of accounts
 * (`ledger/accounts`), the budget document (`ledger/budget`), and posting entries to the
 * journal; reading the journal and the other State documents come in later issues.
 */

import { ChainError, NotFoundError, Space } from 'reeeductio';
import { budgetUpdateProblems, EMPTY_BUDGET } from '@/core/budget.js';
import { chartOf, chartUpdateProblems, EMPTY_CHART, type Chart } from '@/core/chart.js';
import { segmentFor, type MsgId } from '@/core/ids.js';
import { encodeMessage, type AccountsDoc, type BudgetDoc, type Entry } from '@/core/messages.js';
import { entryPostProblems } from '@/core/validate.js';
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

/** An entry broke the post-time rules in design/SCHEMAS.md. Nothing was posted. */
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

  /**
   * Posts `entry` to the `journal-YYYY` segment of its date, after checking it against
   * the post-time rules with the latest chart. Returns the new message's ID.
   *
   * A `ChainError` means another message landed on the segment first. It is not retried
   * here (0017).
   */
  async postEntry(entry: Entry): Promise<MsgId> {
    const chart = chartOf(await this.loadAccounts());
    // No segment can be frozen until the period close exists (0016).
    const problems = entryPostProblems(entry, { chart, segmentOpen: true });
    if (problems.length > 0) throw new InvalidEntryError(problems);
    const topic = segmentFor(entry.date);
    const data = new TextEncoder().encode(encodeMessage('ledger.entry', entry));
    await this.authenticate();
    const prev = await topicHead(this.space, topic);
    const { message_hash } = await this.space.postEncryptedMessage(topic, 'ledger.entry', data, prev);
    return message_hash as MsgId;
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
