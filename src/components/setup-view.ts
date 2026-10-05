/**
 * Setup View
 *
 * Shown when this device has no books: create a new set, or connect to an existing one
 * with its space ID and either the password or the recovery key. It only collects input;
 * the app shell does the connecting and reports failures back through `showError`.
 *
 * The space ID field is marked as the username, so a password manager saves the space ID
 * and the password together and fills both on the next device.
 */

import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { cardStyles } from './card-styles.js';

export interface CreateDetail {
  baseUrl: string;
}

export interface ConnectDetail {
  baseUrl: string;
  spaceId: string;
  /** Exactly one of these is set. */
  password?: string;
  recoveryKey?: string;
}

type Mode = 'create' | 'password' | 'recovery';

@customElement('setup-view')
export class SetupView extends LitElement {
  static styles = cardStyles;

  @state() private mode: Mode = 'create';
  @state() private baseUrl = import.meta.env.VITE_DEFAULT_SERVER_URL ?? 'http://localhost:8000';
  @state() private spaceId = '';
  @state() private secret = '';
  @state() private busy = false;
  @state() private error = '';

  render() {
    const tab = (mode: Mode, label: string) => html`
      <button type="button" aria-pressed=${this.mode === mode}
        @click=${() => ((this.mode = mode), (this.secret = ''))}>${label}</button>
    `;
    return html`
      <form class="card" @submit=${this.submit}>
        <h1>Absurd Money</h1>
        <p class="lede">Encrypted double-entry bookkeeping.</p>

        <div class="tabs">
          ${tab('create', 'New books')} ${tab('password', 'Password')} ${tab('recovery', 'Recovery key')}
        </div>

        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : ''}

        <label for="server">Server</label>
        <input id="server" .value=${this.baseUrl} @input=${(e: Event) => (this.baseUrl = (e.target as HTMLInputElement).value)} required />

        ${this.mode === 'create' ? '' : html`
          <label for="space">Space ID</label>
          <input id="space" name="username" .value=${this.spaceId} spellcheck="false" required
            autocomplete=${this.mode === 'password' ? 'username' : 'off'}
            @input=${(e: Event) => (this.spaceId = (e.target as HTMLInputElement).value)} />
        `}
        ${this.mode === 'password' ? html`
          <label for="secret">Password</label>
          <input id="secret" type="password" name="password" .value=${this.secret} autocomplete="current-password" required
            @input=${(e: Event) => (this.secret = (e.target as HTMLInputElement).value)} />
        ` : ''}
        ${this.mode === 'recovery' ? html`
          <label for="secret">Recovery key</label>
          <input id="secret" type="password" .value=${this.secret} autocomplete="off" required
            @input=${(e: Event) => (this.secret = (e.target as HTMLInputElement).value)} />
        ` : ''}

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
        ...(this.mode === 'password' ? { password: this.secret } : { recoveryKey: this.secret }),
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
