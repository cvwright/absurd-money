/**
 * Protect View
 *
 * Sets up the ways to unlock the books on this device (0033): a passkey, when the browser
 * can use one for this, and a password. At least one is needed before going on, because
 * the keys are never stored in the clear. Shown after creating books, after connecting a
 * device, when protecting keys saved in the clear by an older version, and from the header
 * to add a passkey or change the password later.
 *
 * It only collects input and shows progress from `passkeys` and `hasPassword`; the app
 * shell does the work and reports failures through `showError`.
 */

import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { cardStyles } from './card-styles.js';
import { enterSubmits } from './enter-submits.js';

export type ProtectReason = 'new' | 'connected' | 'migrate' | 'manage';

export interface SetPasswordDetail {
  password: string;
}

const MIN_PASSWORD = 10;

const INTRO: Record<ProtectReason, string> = {
  new: 'Choose how to unlock these books. Your keys are stored on this device only in encrypted form.',
  connected: 'Choose how to unlock these books on this device.',
  migrate:
    'This device has kept your keys unencrypted. Choose how to unlock the books, and the unencrypted copy will be deleted.',
  manage: 'Add a passkey for this device, or change the password.',
};

@customElement('protect-view')
export class ProtectView extends LitElement {
  static styles = cardStyles;

  @property() spaceId = '';
  @property() reason: ProtectReason = 'new';
  @property({ type: Boolean }) passkeySupported = false;
  /** Passkeys registered on this device. */
  @property({ type: Number }) passkeys = 0;
  @property({ type: Boolean }) hasPassword = false;

  @state() private password = '';
  @state() private confirmation = '';
  @state() private busy: 'passkey' | 'password' | null = null;
  @state() private error = '';
  @state() private passwordJustSet = false;

  render() {
    const ready = this.passkeys > 0 || this.hasPassword;
    return html`
      <div class="card">
        <h1>${this.reason === 'manage' ? 'Unlocking' : 'Protect your books'}</h1>
        <p class="lede">${INTRO[this.reason]}</p>

        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : ''}

        ${this.passkeySupported ? html`
          <section>
            <h2>Passkey</h2>
            <p class="note">
              Unlock with Face ID, Touch ID, Windows Hello, or a security key.
              Each device needs its own.
            </p>
            ${this.passkeys > 0 ? html`<p class="done">✓ ${this.passkeys === 1 ? 'A passkey is' : `${this.passkeys} passkeys are`} set up on this device.</p>` : ''}
            <button class=${ready ? 'secondary' : 'primary'} ?disabled=${this.busy !== null}
              @click=${() => this.start('passkey', 'add-passkey', {})}>
              ${this.busy === 'passkey' ? 'Waiting for the passkey…' : this.passkeys > 0 ? 'Add another passkey' : 'Add a passkey'}
            </button>
          </section>
        ` : ''}

        <section>
          <h2>Password</h2>
          <p class="note">
            Unlocks these books on any device, with the space ID. It needs the server, which
            never learns the password and can't test guesses at it on its own. A long
            passphrase is best.
            ${this.hasPassword && !this.passwordJustSet ? ' Setting a new one replaces the old one everywhere.' : ''}
          </p>
          ${this.passwordJustSet ? html`<p class="done">✓ The password is set.</p>` : html`
            <form @submit=${this.submitPassword}>
              <input hidden name="username" autocomplete="username" .value=${this.spaceId} readonly />
              <label for="password">${this.hasPassword ? 'New password' : 'Password'}</label>
              <input id="password" type="password" autocomplete="new-password" required minlength=${MIN_PASSWORD}
                .value=${this.password} @input=${(e: Event) => (this.password = (e.target as HTMLInputElement).value)}
                @keydown=${enterSubmits} />
              <label for="confirm">Type it again</label>
              <input id="confirm" type="password" autocomplete="new-password" required
                .value=${this.confirmation} @input=${(e: Event) => (this.confirmation = (e.target as HTMLInputElement).value)}
                @keydown=${enterSubmits} />
              <button class=${ready || this.passkeySupported ? 'secondary' : 'primary'} type="submit" ?disabled=${this.busy !== null}>
                ${this.busy === 'password' ? 'Working…' : this.hasPassword ? 'Change password' : 'Set password'}
              </button>
            </form>
          `}
        </section>

        <section>
          <button class="primary" ?disabled=${!ready || this.busy !== null} @click=${() => this.emit('protect-done', {})}>
            ${this.reason === 'manage' ? 'Done' : 'Continue'}
          </button>
          ${ready ? '' : html`<p class="note" style="margin-top: var(--spacing-sm)">Set up at least one to go on.</p>`}
        </section>
      </div>
    `;
  }

  private submitPassword(e: Event) {
    e.preventDefault();
    if (this.password.length < MIN_PASSWORD) {
      this.error = `A password needs at least ${MIN_PASSWORD} characters.`;
    } else if (this.password !== this.confirmation) {
      this.error = 'The two passwords are different.';
    } else {
      this.start<SetPasswordDetail>('password', 'set-password', { password: this.password });
    }
  }

  private start<T>(busy: 'passkey' | 'password', name: string, detail: T) {
    this.error = '';
    this.busy = busy;
    this.emit(name, detail);
  }

  private emit<T>(name: string, detail: T) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  /** Called by the app shell when a step succeeded. */
  stepDone() {
    if (this.busy === 'password') {
      this.passwordJustSet = true;
      this.password = this.confirmation = '';
    }
    this.busy = null;
  }

  /** Called by the app shell when a step failed. */
  showError(message: string) {
    this.error = message;
    this.busy = null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'protect-view': ProtectView;
  }
}
