/**
 * Money App - Main Application Shell
 *
 * Root component. Without saved credentials it shows the setup view; with them it
 * connects to the space, opens the local projection and keeps it in sync, and shows the
 * chart of accounts, a new entry, or the opening balances. After creating a new space it
 * shows the recovery key once, since nothing else can bring the books back.
 *
 * Only one tab can have the projection open. Another tab waits, and takes over when
 * that one closes.
 */

import { LitElement, html, css } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { setLogLevel } from 'reeeductio';
import type { AccountsDoc } from '@/core/messages.js';
import {
  clearCredentials,
  credentialsFromRecoveryKey,
  generateCredentials,
  loadCredentials,
  recoveryKey,
  saveCredentials,
  type SpaceCredentials,
} from '@/services/credentials.js';
import { LedgerSpace } from '@/services/ledger-space.js';
import { LiveProjection, type StatusEvent, type SyncStatus } from '@/services/live-projection.js';
import type { ConnectDetail, CreateDetail, SetupView } from './setup-view.js';
import './setup-view.js';
import './chart-view.js';
import './opening-view.js';
import './entry-view.js';

setLogLevel(import.meta.env.DEV ? 'debug' : 'warn');

type View =
  | { kind: 'setup' }
  | { kind: 'loading' }
  | { kind: 'other-tab' }
  | { kind: 'backup'; key: string }
  | { kind: 'ready' }
  | { kind: 'failed'; error: string };

type Page = 'accounts' | 'entry' | 'opening';

const PAGES: { page: Page; label: string }[] = [
  { page: 'accounts', label: 'Accounts' },
  { page: 'entry', label: 'New entry' },
  { page: 'opening', label: 'Opening balances' },
];

const STATUS_TEXT: Record<SyncStatus['kind'], string> = {
  syncing: 'Syncing…',
  live: 'Up to date',
  offline: 'Offline',
  failed: 'Sync failed',
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  @state() private ledger: LedgerSpace | null = null;
  @state() private live: LiveProjection | null = null;
  @state() private syncStatus: SyncStatus = { kind: 'syncing' };
  @state() private accounts: AccountsDoc | null = null;
  @state() private page: Page = 'accounts';
  @query('setup-view') private setupView?: SetupView;

  connectedCallback() {
    super.connectedCallback();
    const creds = loadCredentials();
    if (creds) void this.open(creds);
    else this.view = { kind: 'setup' };
  }

  render() {
    switch (this.view.kind) {
      case 'setup':
        return html`<setup-view @create-space=${this.create} @connect-space=${this.connect}></setup-view>`;
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
            <button @click=${this.signOut}>Sign out</button>
          </header>
          <nav>
            ${PAGES.map(
              ({ page, label }) => html`<button aria-current=${this.page === page ? 'page' : 'false'}
                @click=${() => (this.page = page)}>${label}</button>`,
            )}
          </nav>
          <main @accounts-changed=${(e: CustomEvent<AccountsDoc>) => (this.accounts = e.detail)}>
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
      case 'entry':
        return html`<entry-view .ledger=${this.ledger!} .doc=${this.accounts!}></entry-view>`;
      case 'opening':
        return html`<opening-view .ledger=${this.ledger!} .doc=${this.accounts!}></opening-view>`;
    }
  }

  private renderBackup(key: string) {
    return html`
      <div class="centered">
        <div class="card">
          <h2>Save your recovery key</h2>
          <p class="muted">
            Your books are encrypted with keys that exist only on this device. To open them
            anywhere else, or after clearing this browser, you need the space ID and the
            recovery key. Nobody can reset them for you. Keep both somewhere safe, like a
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
          <button class="primary" @click=${() => (this.view = { kind: 'ready' })}>I saved them</button>
        </div>
      </div>
    `;
  }

  private async create(e: CustomEvent<CreateDetail>) {
    try {
      const creds = await generateCredentials(e.detail.baseUrl);
      // Authenticating creates the space, so save only once it exists.
      await this.connectTo(creds);
      saveCredentials(creds);
      this.view = { kind: 'backup', key: recoveryKey(creds) };
    } catch (err) {
      this.setupView?.showError(message(err));
    }
  }

  private async connect(e: CustomEvent<ConnectDetail>) {
    try {
      const { spaceId, recoveryKey: key, baseUrl } = e.detail;
      const creds = credentialsFromRecoveryKey(spaceId, key, baseUrl);
      await this.connectTo(creds);
      saveCredentials(creds);
      this.view = { kind: 'ready' };
    } catch (err) {
      this.setupView?.showError(message(err));
    }
  }

  /** Opens saved credentials at startup. */
  private async open(creds: SpaceCredentials) {
    this.view = { kind: 'loading' };
    try {
      await this.connectTo(creds);
      this.view = { kind: 'ready' };
    } catch (err) {
      this.view = { kind: 'failed', error: message(err) };
    }
  }

  private async connectTo(creds: SpaceCredentials) {
    const ledger = new LedgerSpace(creds);
    await ledger.authenticate();
    this.accounts = await ledger.loadAccounts();
    const live = await LiveProjection.start(ledger, () => (this.view = { kind: 'other-tab' }));
    live.addEventListener('status', (e) => (this.syncStatus = (e as StatusEvent).detail));
    this.syncStatus = live.status;
    this.live?.stop();
    this.live = live;
    this.ledger = ledger;
  }

  private retry() {
    const creds = loadCredentials();
    if (creds) void this.open(creds);
    else this.view = { kind: 'setup' };
  }

  private async signOut() {
    const ok = confirm(
      'Sign out of these books on this device? You will need the space ID and recovery key to open them again.',
    );
    if (!ok) return;
    clearCredentials();
    // The projection holds the books decrypted, so it doesn't outlive the credentials.
    try {
      await this.live?.wipe();
    } catch (err) {
      console.warn('[money-app] could not delete the local database:', err);
    }
    this.live = null;
    this.ledger = null;
    this.accounts = null;
    this.view = { kind: 'setup' };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'money-app': MoneyApp;
  }
}
