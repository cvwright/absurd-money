/**
 * Setup View
 *
 * Shown when this device has no saved credentials: create a new set of books, or connect
 * to an existing one with its space ID and recovery key. It only collects input; the app
 * shell does the connecting and reports failures back through `showError`.
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';

export interface CreateDetail {
  baseUrl: string;
}

export interface ConnectDetail {
  baseUrl: string;
  spaceId: string;
  recoveryKey: string;
}

@customElement('setup-view')
export class SetupView extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      min-height: 100dvh;
      padding: var(--spacing-md);
    }

    /* Global resets don't reach into the shadow root. */
    h1,
    p {
      margin: 0;
    }

    button {
      font: inherit;
      border: none;
      cursor: pointer;
    }

    .card {
      background-color: var(--color-bg-elevated);
      border-radius: var(--radius-lg);
      padding: var(--spacing-xl);
      width: 100%;
      max-width: 440px;
      box-shadow: var(--shadow-lg);
    }

    h1 {
      font-size: var(--font-size-xxl);
      margin-bottom: var(--spacing-sm);
      text-align: center;
    }

    .lede {
      color: var(--color-text-secondary);
      text-align: center;
      margin-bottom: var(--spacing-lg);
    }

    .tabs {
      display: flex;
      gap: var(--spacing-xs);
      margin-bottom: var(--spacing-lg);
    }

    .tabs button {
      flex: 1;
      padding: var(--spacing-sm);
      border-radius: var(--radius-sm);
      background-color: var(--color-bg-highlight);
      color: var(--color-text-secondary);
    }

    .tabs button[aria-pressed='true'] {
      background-color: var(--color-accent);
      color: #000;
      font-weight: 600;
    }

    label {
      display: block;
      font-size: var(--font-size-sm);
      color: var(--color-text-secondary);
      margin-bottom: var(--spacing-xs);
      font-weight: 600;
    }

    input {
      box-sizing: border-box;
      width: 100%;
      padding: var(--spacing-sm) var(--spacing-md);
      background-color: var(--color-bg-highlight);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-primary);
      margin-bottom: var(--spacing-md);
      outline: none;
      font-family: var(--font-family-mono);
    }

    input:focus {
      border-color: var(--color-accent);
    }

    .primary {
      width: 100%;
      padding: var(--spacing-sm) var(--spacing-md);
      background-color: var(--color-accent);
      color: #000;
      font-weight: 700;
      border-radius: var(--radius-full);
      font-size: var(--font-size-lg);
    }

    .primary:hover {
      background-color: var(--color-accent-hover);
    }

    .primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .error {
      color: var(--color-error);
      font-size: var(--font-size-sm);
      margin-bottom: var(--spacing-md);
      text-align: center;
    }
  `;

  @state() private mode: 'create' | 'connect' = 'create';
  @state() private baseUrl = import.meta.env.VITE_DEFAULT_SERVER_URL ?? 'http://localhost:8000';
  @state() private spaceId = '';
  @state() private recoveryKey = '';
  @state() private busy = false;
  @state() private error = '';

  render() {
    return html`
      <form class="card" @submit=${this.submit}>
        <h1>Absurd Money</h1>
        <p class="lede">Encrypted double-entry bookkeeping.</p>

        <div class="tabs">
          <button type="button" aria-pressed=${this.mode === 'create'} @click=${() => (this.mode = 'create')}>
            New books
          </button>
          <button type="button" aria-pressed=${this.mode === 'connect'} @click=${() => (this.mode = 'connect')}>
            Connect
          </button>
        </div>

        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : ''}

        <label for="server">Server</label>
        <input id="server" .value=${this.baseUrl} @input=${(e: Event) => (this.baseUrl = (e.target as HTMLInputElement).value)} required />

        ${this.mode === 'connect'
          ? html`
              <label for="space">Space ID</label>
              <input id="space" .value=${this.spaceId} autocomplete="off" spellcheck="false" required
                @input=${(e: Event) => (this.spaceId = (e.target as HTMLInputElement).value)} />
              <label for="key">Recovery key</label>
              <input id="key" type="password" .value=${this.recoveryKey} autocomplete="off" required
                @input=${(e: Event) => (this.recoveryKey = (e.target as HTMLInputElement).value)} />
            `
          : ''}

        <button class="primary" type="submit" ?disabled=${this.busy}>
          ${this.busy ? 'Working…' : this.mode === 'create' ? 'Create books' : 'Connect'}
        </button>
      </form>
    `;
  }

  private submit(e: Event) {
    e.preventDefault();
    this.error = '';
    this.busy = true;
    const baseUrl = this.baseUrl.trim();
    if (this.mode === 'create') {
      this.emit<CreateDetail>('create-space', { baseUrl });
    } else {
      this.emit<ConnectDetail>('connect-space', {
        baseUrl,
        spaceId: this.spaceId,
        recoveryKey: this.recoveryKey,
      });
    }
  }

  private emit<T>(name: string, detail: T) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  /** Called by the app shell when creating or connecting failed. */
  showError(message: string) {
    this.error = message;
    this.busy = false;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'setup-view': SetupView;
  }
}
