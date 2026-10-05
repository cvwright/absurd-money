/**
 * In-progress reconciliation sessions (0019): the half-ticked checklist for each account,
 * kept in this device's local storage until the statement is finished.
 *
 * A session is losable per-device scratch, not a record. It never goes in the space; only
 * the completed reconciliation is posted. See "Reconciliation is an event, not a flag" in
 * design/ACCOUNTING.md. Losing one costs a redone session, so anything unreadable is
 * dropped rather than reported, and a storage that throws (private browsing, a full quota)
 * just means nothing is kept.
 *
 * Like the projection, a session sits on the device in the clear: the account's ID, the
 * statement's date and closing balance, and the ticked entry hashes (see 0043). Signing out
 * deletes it.
 */

import { isAccountId, isMsgId, type AccountId, type MsgId } from '@/core/ids.js';

/** One account's checklist, as the Reconcile page holds it. */
export interface ReconSession {
  /** The statement date as entered, which may be incomplete. */
  readonly date: string;
  /** The closing balance as typed. */
  readonly balance: string;
  readonly checked: readonly MsgId[];
  /** The reconciliation being redone, if any. */
  readonly supersedes?: MsgId;
}

/** What one space keeps under its storage key. */
interface Stored {
  readonly v: 1;
  /** The account last open on the Reconcile page. */
  readonly account?: AccountId;
  readonly sessions: Readonly<Record<AccountId, ReconSession>>;
}

const PREFIX = 'money.recon.';

const storageKey = (spaceId: string) => PREFIX + spaceId;

/** A session with nothing in it, which isn't worth keeping. */
function isEmpty(s: ReconSession): boolean {
  return s.checked.length === 0 && s.balance.trim() === '' && s.supersedes === undefined;
}

function parseSession(x: unknown): ReconSession | undefined {
  if (typeof x !== 'object' || x === null) return undefined;
  const { date, balance, checked, supersedes } = x as Record<string, unknown>;
  if (typeof date !== 'string' || typeof balance !== 'string' || !Array.isArray(checked)) return undefined;
  if (supersedes !== undefined && !isMsgId(supersedes)) return undefined;
  return {
    date,
    balance,
    checked: checked.filter(isMsgId),
    ...(supersedes !== undefined && { supersedes }),
  };
}

function parse(text: string | null): Stored {
  const empty: Stored = { v: 1, sessions: {} };
  if (text === null) return empty;
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return empty;
  }
  if (typeof x !== 'object' || x === null || (x as { v?: unknown }).v !== 1) return empty;
  const { account, sessions } = x as Record<string, unknown>;
  const out: Record<AccountId, ReconSession> = {};
  if (typeof sessions === 'object' && sessions !== null) {
    for (const [id, s] of Object.entries(sessions)) {
      const session = parseSession(s);
      if (isAccountId(id) && session) out[id] = session;
    }
  }
  return { v: 1, ...(isAccountId(account) && { account }), sessions: out };
}

/** The Reconcile page's sessions for one space on this device. */
export class ReconSessions {
  constructor(
    private readonly spaceId: string,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage,
  ) {}

  private read(): Stored {
    try {
      return parse(this.storage.getItem(storageKey(this.spaceId)));
    } catch {
      return { v: 1, sessions: {} };
    }
  }

  private write(stored: Stored) {
    try {
      if (stored.account === undefined && Object.keys(stored.sessions).length === 0) {
        this.storage.removeItem(storageKey(this.spaceId));
      } else {
        this.storage.setItem(storageKey(this.spaceId), JSON.stringify(stored));
      }
    } catch (err) {
      console.warn('[recon-session] could not save the reconciliation in progress:', err);
    }
  }

  /** The account last open on the Reconcile page, if any. */
  lastAccount(): AccountId | undefined {
    return this.read().account;
  }

  /** The account's session in progress, if any. */
  get(account: AccountId): ReconSession | undefined {
    return this.read().sessions[account];
  }

  /**
   * Saves the account's session and makes it the last account open. An empty session
   * deletes the account's entry instead.
   */
  save(account: AccountId, session: ReconSession) {
    const sessions = { ...this.read().sessions };
    if (isEmpty(session)) delete sessions[account];
    else sessions[account] = session;
    this.write({ v: 1, account, sessions });
  }
}

/** Deletes every session kept for the space on this device. */
export function clearReconSessions(
  spaceId: string,
  storage: Pick<Storage, 'removeItem'> = localStorage,
) {
  try {
    storage.removeItem(storageKey(spaceId));
  } catch (err) {
    console.warn('[recon-session] could not delete the reconciliations in progress:', err);
  }
}
