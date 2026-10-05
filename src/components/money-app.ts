/**
 * Money App - Main Application Shell
 *
 * Root component. Without saved books it shows the setup view. With them it starts locked:
 * the keys are wrapped at rest (0033) and open only with a passkey, the password, or the
 * recovery key. Unlocked, it connects to the space, opens the local projection and keeps it
 * in sync, and shows the chart of accounts, an account's register, a new entry, the opening
 * balances, statement reconciliation, or the period closes. After creating a new space it shows the recovery key
 * once, since nothing else can bring the books back if the passkeys and password are lost,
 * and then asks how to unlock them.
 *
 * It locks after a period of inactivity or on request, which drops the keys, the
 * `LedgerSpace`, and the projection from memory.
 *
 * Only one tab can have the projection open. Another tab waits, and takes over when
 * that one closes.
 */

import { LitElement, html, css } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { decodeUrlSafeBase64, setLogLevel } from 'reeeductio';
import type { AccountId } from '@/core/ids.js';
import type { AccountsDoc } from '@/core/messages.js';
import {
  clearBooks,
  clearLegacyCredentials,
  forgetKeys,
  generateCredentials,
  loadBooks,
  loadLegacyCredentials,
  recoveryKey,
  saveBooks,
  unlockWithPasskey,
  unlockWithPassword,
  unlockWithRecoveryKey,
  wrapForPasskey,
  type SavedBooks,
  type SpaceCredentials,
} from '@/services/credentials.js';
import { LedgerSpace } from '@/services/ledger-space.js';
import { LiveProjection, type StatusEvent, type SyncStatus } from '@/services/live-projection.js';
import { createPasskey, passkeysSupported } from '@/services/passkey.js';
import { clearReconSessions } from '@/services/recon-session.js';
import type { ReEnter } from './entry-view.js';
import { errorMessage } from './forms.js';
import type { ProtectReason, ProtectView, SetPasswordDetail } from './protect-view.js';
import type { ConnectDetail, CreateDetail, SetupView } from './setup-view.js';
import type { UnlockView } from './unlock-view.js';
import './setup-view.js';
import './unlock-view.js';
import './protect-view.js';
import './chart-view.js';
import './register-view.js';
import './opening-view.js';
import './entry-view.js';
import './reconcile-view.js';
import './close-view.js';

setLogLevel(import.meta.env.DEV ? 'debug' : 'warn');

type View =
  | { kind: 'setup' }
  | { kind: 'locked' }
  | { kind: 'protect'; reason: ProtectReason }
  | { kind: 'loading' }
  | { kind: 'other-tab' }
  | { kind: 'backup'; key: string }
  | { kind: 'ready' }
  | { kind: 'failed'; error: string };

type Page = 'accounts' | 'register' | 'entry' | 'opening' | 'reconcile' | 'close';

const PAGES: { page: Page; label: string }[] = [
  { page: 'accounts', label: 'Accounts' },
  { page: 'register', label: 'Register' },
  { page: 'entry', label: 'New entry' },
  { page: 'opening', label: 'Opening balances' },
  { page: 'reconcile', label: 'Reconcile' },
  { page: 'close', label: 'Close' },
];

const STATUS_TEXT: Record<SyncStatus['kind'], string> = {
  syncing: 'Syncing…',
  live: 'Up to date',
  offline: 'Offline',
  failed: 'Sync failed',
};

/** Locks after this long with no input, counting time in the background. */
const LOCK_AFTER_MS = 15 * 60 * 1000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** A record for books that have no way to unlock yet. */
function draftBooks(creds: SpaceCredentials, password: boolean): SavedBooks {
  return { v: 1, spaceId: creds.spaceId, baseUrl: creds.baseUrl, password, passkeys: [] };
}

function passkeyMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'The passkey was cancelled or timed out.';
  }
  if (err instanceof DOMException && err.name === 'InvalidStateError') {
    return 'That passkey is already registered.';
  }
  return errorMessage(err);
}

@customElement('money-app')
export class MoneyApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      min-height: 100dvh;
    }

    h1,
    h2,
    p {
      margin: 0;
    }

    button {
      font: inherit;
      border: none;
      cursor: pointer;
      background: none;
      color: inherit;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-md);
      padding: var(--spacing-sm) var(--spacing-md);
      border-bottom: 1px solid var(--color-bg-highlight);
    }

    header h1 {
      font-size: var(--font-size-lg);
    }

    header .space {
      color: var(--color-text-subdued);
      font-family: var(--font-family-mono);
      font-size: var(--font-size-xs);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }

    header .status {
      color: var(--color-text-subdued);
      font-size: var(--font-size-xs);
      flex-shrink: 0;
    }

    header .status.failed {
      color: var(--color-error);
    }

    header button {
      color: var(--color-text-secondary);
      font-size: var(--font-size-sm);
      flex-shrink: 0;
    }

    nav {
      display: flex;
      gap: var(--spacing-xs);
      max-width: 760px;
      margin: 0 auto;
      padding: var(--spacing-sm) var(--spacing-md) 0;
    }

    nav button {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-full);
      color: var(--color-text-secondary);
      font-size: var(--font-size-sm);
    }

    nav button[aria-current='page'] {
      background-color: var(--color-bg-highlight);
      color: var(--color-text-primary);
    }

    main {
      max-width: 760px;
      margin: 0 auto;
      padding: var(--spacing-lg) var(--spacing-md);
    }

    .centered {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-md);
      min-height: 100vh;
      min-height: 100dvh;
      padding: var(--spacing-md);
      text-align: center;
    }

    .card {
      background-color: var(--color-bg-elevated);
      border-radius: var(--radius-lg);
      padding: var(--spacing-xl);
      max-width: 520px;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      text-align: left;
    }

    .secret {
      font-family: var(--font-family-mono);
      font-size: var(--font-size-sm);
      word-break: break-all;
      user-select: all;
      padding: var(--spacing-sm);
      background-color: var(--color-bg-highlight);
      border-radius: var(--radius-sm);
    }

    .muted {
      color: var(--color-text-secondary);
    }

    .error {
      color: var(--color-error);
    }

    .primary {
      padding: var(--spacing-sm) var(--spacing-lg);
      background-color: var(--color-accent);
      color: #000;
      font-weight: 700;
      border-radius: var(--radius-full);
    }
  `;

  @state() private view: View = { kind: 'loading' };
  /** This device's record of its books, or a draft until one way to unlock is saved. */
  @state() private books: SavedBooks | null = null;
  @state() private passkeySupported = false;
  @state() private ledger: LedgerSpace | null = null;
  @state() private live: LiveProjection | null = null;
  @state() private syncStatus: SyncStatus = { kind: 'syncing' };
  @state() private accounts: AccountsDoc | null = null;
  @state() private page: Page = 'accounts';
  /** The account the register shows, kept while visiting other pages. */
  @state() private registerAccount: AccountId | null = null;
  /** A reversed entry the entry page is replacing, until it posts or is cancelled. */
  @state() private reEnter: ReEnter | null = null;
  @query('setup-view') private setupView?: SetupView;
  @query('unlock-view') private unlockView?: UnlockView;
  @query('protect-view') private protectView?: ProtectView;

  /** The unwrapped keys, held only while unlocked. */
  private creds: SpaceCredentials | null = null;
  /** Bumped on every lock and sign-out, so work started before it is abandoned. */
  private session = 0;
  private lastActivity = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | undefined;

  connectedCallback() {
    super.connectedCallback();
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, this.onActivity, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', this.checkIdle);
    this.idleTimer = setInterval(this.checkIdle, 30_000);
    void this.start();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, this.onActivity, { capture: true });
    document.removeEventListener('visibilitychange', this.checkIdle);
    clearInterval(this.idleTimer);
  }

  /** Finds this device's books: locked, still in the clear from an older version, or none. */
  private async start() {
    this.view = { kind: 'loading' };
    this.passkeySupported = await passkeysSupported();
    let books: SavedBooks | null;
    try {
      books = await loadBooks();
    } catch (err) {
      this.view = { kind: 'failed', error: errorMessage(err) };
      return;
    }
    if (books) {
      // Protected already, so any copy in the clear is a leftover.
      clearLegacyCredentials();
      this.books = books;
      this.view = { kind: 'locked' };
      return;
    }
    const legacy = loadLegacyCredentials();
    if (legacy) {
      this.creds = legacy;
      this.books = draftBooks(legacy, false);
      this.view = { kind: 'protect', reason: 'migrate' };
      return;
    }
    this.view = { kind: 'setup' };
  }

  render() {
    switch (this.view.kind) {
      case 'setup':
        return html`<setup-view @create-space=${this.create} @connect-space=${this.connect}></setup-view>`;
      case 'locked':
        return html`<unlock-view .books=${this.books!}
          @unlock-passkey=${this.unlockPasskey} @unlock-password=${this.unlockPassword}
          @unlock-recovery=${this.unlockRecovery} @sign-out=${this.signOut}></unlock-view>`;
      case 'protect':
        return html`<protect-view .spaceId=${this.books!.spaceId} .reason=${this.view.reason}
          .passkeySupported=${this.passkeySupported} .passkeys=${this.books!.passkeys.length}
          .hasPassword=${this.books!.password}
          @add-passkey=${this.addPasskey} @set-password=${this.setPassword}
          @protect-done=${this.protectDone}></protect-view>`;
      case 'loading':
        return html`<div class="centered muted">Opening the books…</div>`;
      case 'other-tab':
        return html`
          <div class="centered muted">
            <p>These books are open in another tab.</p>
            <p>Close that tab and this one will pick up where it left off.</p>
          </div>
        `;
      case 'failed':
        return html`
          <div class="centered">
            <p class="error" role="alert">${this.view.error}</p>
            <button class="primary" @click=${this.retry}>Try again</button>
            <button class="muted" @click=${this.signOut}>Sign out</button>
          </div>
        `;
      case 'backup':
        return this.renderBackup(this.view.key);
      case 'ready':
        return html`
          <header>
            <h1>Absurd Money</h1>
            <span class="space" title=${this.ledger!.spaceId}>${this.ledger!.spaceId}</span>
            <span class="status ${this.syncStatus.kind}" role="status"
              title=${this.syncStatus.kind === 'failed' ? this.syncStatus.error : ''}>${STATUS_TEXT[this.syncStatus.kind]}</span>
            <button @click=${() => (this.view = { kind: 'protect', reason: 'manage' })}>Unlocking</button>
            <button @click=${this.lock}>Lock</button>
            <button @click=${this.signOut}>Sign out</button>
          </header>
          <nav>
            ${PAGES.map(
              ({ page, label }) => html`<button aria-current=${this.page === page ? 'page' : 'false'}
                @click=${() => this.goTo(page)}>${label}</button>`,
            )}
          </nav>
          <main @accounts-changed=${(e: CustomEvent<AccountsDoc>) => (this.accounts = e.detail)}
            @account-selected=${this.openRegister}
            @re-enter=${(e: CustomEvent<ReEnter>) => ((this.reEnter = e.detail), (this.page = 'entry'))}
            @re-enter-done=${() => (this.reEnter = null)}>
            ${this.renderPage()}
          </main>
        `;
    }
  }

  private renderPage() {
    switch (this.page) {
      case 'accounts':
        return html`<chart-view .ledger=${this.ledger!} .doc=${this.accounts!}
          .projection=${this.live!.projection}></chart-view>`;
      case 'register':
        return html`<register-view .projection=${this.live!.projection} .ledger=${this.ledger!} .doc=${this.accounts!}
          .account=${this.registerAccount}></register-view>`;
      case 'entry':
        return html`<entry-view .ledger=${this.ledger!} .projection=${this.live!.projection} .doc=${this.accounts!}
          .reenter=${this.reEnter}></entry-view>`;
      case 'opening':
        return html`<opening-view .ledger=${this.ledger!} .projection=${this.live!.projection}
          .doc=${this.accounts!}></opening-view>`;
      case 'reconcile':
        return html`<reconcile-view .ledger=${this.ledger!} .projection=${this.live!.projection}
          .doc=${this.accounts!}></reconcile-view>`;
      case 'close':
        return html`<close-view .ledger=${this.ledger!} .projection=${this.live!.projection}></close-view>`;
    }
  }

  /** Leaving a replacement by navigating away abandons it. */
  private goTo(page: Page) {
    this.reEnter = null;
    this.page = page;
  }

  private openRegister(e: CustomEvent<AccountId>) {
    this.registerAccount = e.detail;
    this.page = 'register';
  }

  private renderBackup(key: string) {
    return html`
      <div class="centered">
        <div class="card">
          <h2>Save your recovery key</h2>
          <p class="muted">
            Your books are encrypted with keys that only you hold. If you lose your passkeys
            and forget the password, the space ID and this recovery key are the only way
            back in. Nobody can reset them for you. Keep both somewhere safe, like a
            password manager.
          </p>
          <div>
            <p class="muted">Space ID</p>
            <div class="secret">${this.ledger!.spaceId}</div>
          </div>
          <div>
            <p class="muted">Recovery key</p>
            <div class="secret">${key}</div>
          </div>
          <button class="primary" @click=${() => (this.view = { kind: 'protect', reason: 'new' })}>I saved them</button>
        </div>
      </div>
    `;
  }

  private async create(e: CustomEvent<CreateDetail>) {
    try {
      const creds = await generateCredentials(e.detail.baseUrl);
      // Authenticating creates the space. Nothing is saved until there is a way to unlock
      // it, and the recovery key is shown first so closing the tab can't lose the books.
      if (!(await this.connectTo(creds))) return;
      this.books = draftBooks(creds, false);
      this.view = { kind: 'backup', key: recoveryKey(creds) };
    } catch (err) {
      this.setupView?.showError(errorMessage(err));
    }
  }

  private async connect(e: CustomEvent<ConnectDetail>) {
    try {
      const { spaceId, password, recoveryKey: key, baseUrl } = e.detail;
      const creds =
        password !== undefined
          ? await unlockWithPassword(spaceId, baseUrl, password)
          : await unlockWithRecoveryKey(spaceId, key ?? '', baseUrl);
      if (!(await this.connectTo(creds))) return;
      const books = draftBooks(creds, password !== undefined);
      if (books.password) await this.remember(books);
      else this.books = books;
      this.view = { kind: 'protect', reason: 'connected' };
    } catch (err) {
      this.setupView?.showError(errorMessage(err));
    }
  }

  private unlockPasskey() {
    // No await before the prompt: Safari needs it to come straight from the click.
    void this.unlockWith(unlockWithPasskey(this.books!));
  }

  private unlockPassword(e: CustomEvent<{ password: string }>) {
    const { spaceId, baseUrl } = this.books!;
    void this.unlockWith(unlockWithPassword(spaceId, baseUrl, e.detail.password));
  }

  private unlockRecovery(e: CustomEvent<{ recoveryKey: string }>) {
    const { spaceId, baseUrl } = this.books!;
    void this.unlockWith(unlockWithRecoveryKey(spaceId, e.detail.recoveryKey, baseUrl));
  }

  private async unlockWith(unlocking: Promise<SpaceCredentials>) {
    let creds: SpaceCredentials;
    try {
      creds = await unlocking;
    } catch (err) {
      this.unlockView?.showError(passkeyMessage(err));
      return;
    }
    this.lastActivity = Date.now();
    await this.open(creds);
  }

  private addPasskey() {
    const creds = this.creds!;
    const books = this.books!;
    // No await before the prompt, as for unlocking.
    const creating = createPasskey(
      creds.spaceId,
      books.passkeys.map((w) => decodeUrlSafeBase64(w.credentialId)),
    );
    void (async () => {
      try {
        const prf = await creating;
        let wrapped;
        try {
          wrapped = await wrapForPasskey(creds, prf);
        } finally {
          prf.prf.fill(0);
        }
        await this.remember({ ...books, passkeys: [...books.passkeys, wrapped] });
        this.protectView?.stepDone();
      } catch (err) {
        this.protectView?.showError(passkeyMessage(err));
      }
    })();
  }

  private async setPassword(e: CustomEvent<SetPasswordDetail>) {
    const creds = this.creds!;
    const books = this.books!;
    try {
      await (this.ledger ?? new LedgerSpace(creds)).setPassword(e.detail.password);
      await this.remember({ ...books, password: true });
      this.protectView?.stepDone();
    } catch (err) {
      this.protectView?.showError(errorMessage(err));
    }
  }

  /** Saves this device's record. Once it can unlock, a copy in the clear has no reason to exist. */
  private async remember(books: SavedBooks) {
    await saveBooks(books);
    this.books = books;
    clearLegacyCredentials();
  }

  private protectDone() {
    if (this.ledger) this.view = { kind: 'ready' };
    else void this.open(this.creds!);
  }

  /** Opens the books with unlocked keys. */
  private async open(creds: SpaceCredentials) {
    const session = this.session;
    this.view = { kind: 'loading' };
    try {
      if (await this.connectTo(creds)) this.view = { kind: 'ready' };
    } catch (err) {
      if (session === this.session) this.view = { kind: 'failed', error: errorMessage(err) };
    }
  }

  /** Connects and starts the projection. False if the app locked meanwhile. */
  private async connectTo(creds: SpaceCredentials): Promise<boolean> {
    const session = this.session;
    this.creds = creds;
    const ledger = new LedgerSpace(creds);
    await ledger.authenticate();
    const accounts = await ledger.loadAccounts();
    const live = await LiveProjection.start(ledger, () => {
      if (session === this.session) this.view = { kind: 'other-tab' };
    });
    if (session !== this.session) {
      live.stop();
      return false;
    }
    live.addEventListener('status', (e) => (this.syncStatus = (e as StatusEvent).detail));
    this.syncStatus = live.status;
    this.live?.stop();
    this.live = live;
    this.ledger = ledger;
    this.accounts = accounts;
    return true;
  }

  private retry() {
    if (this.creds) void this.open(this.creds);
    else void this.start();
  }

  /** Locking needs a way back in, so books that can't unlock yet stay open. */
  private get canLock(): boolean {
    return this.creds !== null && !!this.books && (this.books.password || this.books.passkeys.length > 0);
  }

  private readonly onActivity = () => {
    this.lastActivity = Date.now();
  };

  private readonly checkIdle = () => {
    if (this.canLock && Date.now() - this.lastActivity >= LOCK_AFTER_MS) this.lock();
  };

  private readonly lock = () => {
    if (!this.canLock) return;
    this.live?.stop();
    this.close();
    this.view = { kind: 'locked' };
  };

  /** Drops the books from memory: the projection (already stopped), the space, and the keys. */
  private close() {
    this.session++;
    this.live = null;
    this.ledger = null;
    this.accounts = null;
    this.registerAccount = null;
    this.reEnter = null;
    this.page = 'accounts';
    if (this.creds) forgetKeys(this.creds);
    this.creds = null;
  }

  private async signOut() {
    const ok = confirm(
      'Sign out of these books on this device? Its passkeys will no longer open them. You will need the space ID and the password or recovery key to open them again.',
    );
    if (!ok) return;
    const spaceId = this.books?.spaceId ?? this.creds?.spaceId;
    const live = this.live;
    this.close();
    this.view = { kind: 'loading' };
    try {
      await clearBooks();
    } catch (err) {
      console.warn('[money-app] could not delete the saved books:', err);
    }
    clearLegacyCredentials();
    if (spaceId) clearReconSessions(spaceId);
    this.books = null;
    // The projection holds the books decrypted, so it doesn't outlive the credentials.
    try {
      if (live) await live.wipe();
      else if (spaceId) await LiveProjection.wipe(spaceId, () => (this.view = { kind: 'other-tab' }));
    } catch (err) {
      console.warn('[money-app] could not delete the local database:', err);
    }
    this.view = { kind: 'setup' };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'money-app': MoneyApp;
  }
}
