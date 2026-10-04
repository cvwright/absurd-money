/**
 * Ledger Space Service
 *
 * One set of books is one reeeductio space. This wraps the SDK's `Space` with the
 * ledger's operations. For now that is authentication and the chart of accounts
 * (`ledger/accounts`); the journal and the other State documents come in later issues.
 */

import { ChainError, NotFoundError, Space } from 'reeeductio';
import { chartUpdateProblems, EMPTY_CHART } from '@/core/chart.js';
import type { AccountsDoc } from '@/core/messages.js';
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
}

/** State through the SDK, encrypted under the space's state key. */
function sdkStateBackend(space: Space, ready: () => Promise<void>): StateBackend {
  return {
    async head() {
      await ready();
      // Newest first. `from` is unbounded rather than `Date.now()`, so a client clock
      // behind the server's can't hide the newest message and pin us to a stale head.
      const { messages } = await space.getMessages(
        'state',
        { from: Number.MAX_SAFE_INTEGER, to: 0, limit: 1 },
        { useCache: false },
      );
      return messages[0]?.message_hash ?? null;
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
