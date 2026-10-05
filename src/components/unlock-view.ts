/**
 * Unlock View
 *
 * The lock screen, shown at startup and after locking. The keys on this device are wrapped
 * (0033), so the books open only with one of their passkeys, the password, or, as a last
 * resort, the recovery key. Like the setup view it only collects input; the app shell does
 * the unlocking and reports failures through `showError`.
 *
 * Nothing prompts on its own: Safari allows a passkey only from a click.
 */

import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { SavedBooks } from '@/services/credentials.js';
import { cardStyles } from './card-styles.js';

@customElement('unlock-view')
export class UnlockView extends LitElement {
  static styles = cardStyles;

  @property({ attribute: false }) books!: SavedBooks;
  @state() private password = '';
  @state() private recoveryKey = '';
  @state() private useRecovery = false;
  @state() private busy = false;
  @state() private error = '';

  render() {
    const { passkeys, password, spaceId } = this.books;
    const hasPasskey = passkeys.length > 0;
    const recovery = this.useRecovery || (!hasPasskey && !password);
    return html`
      <div class="card">
        <h1>Absurd Money</h1>
        <p class="lede">These books are locked.</p>

        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : ''}

        ${recovery ? this.renderRecovery() : html`
          ${hasPasskey ? html`
            <button class="primary" ?disabled=${this.busy} @click=${() => this.start('unlock-passkey', {})}>
              ${this.busy ? 'Working…' : 'Unlock with passkey'}
            </button>
          ` : ''}
          ${hasPasskey && password ? html`<p class="or">or</p>` : ''}
          ${password ? html`
            <form @submit=${this.submitPassword}>
              <input hidden name="username" autocomplete="username" .value=${spaceId} readonly />
              <label for="password">Password</label>
              <input id="password" type="password" name="password" autocomplete="current-password" required
                .value=${this.password} @input=${(e: Event) => (this.password = (e.target as HTMLInputElement).value)} />
              <button class=${hasPasskey ? 'secondary' : 'primary'} type="submit" ?disabled=${this.busy}>
                Unlock with password
              </button>
            </form>
          ` : ''}
          <button class="link" @click=${() => ((this.useRecovery = true), (this.error = ''))}>
            Use the recovery key
          </button>
        `}

        <button class="link" @click=${() => this.emit('sign-out', {})}>Sign out of this device</button>
      </div>
    `;
  }

  private renderRecovery() {
    return html`
      <form @submit=${this.submitRecovery}>
        <label for="recovery">Recovery key</label>
        <input id="recovery" type="password" autocomplete="off" required
          .value=${this.recoveryKey} @input=${(e: Event) => (this.recoveryKey = (e.target as HTMLInputElement).value)} />
        <button class="primary" type="submit" ?disabled=${this.busy}>
          ${this.busy ? 'Working…' : 'Unlock'}
        </button>
      </form>
      ${this.books.passkeys.length > 0 || this.books.password
        ? html`<button class="link" @click=${() => ((this.useRecovery = false), (this.error = ''))}>Back</button>`
        : ''}
    `;
  }

  private submitPassword(e: Event) {
    e.preventDefault();
    this.start('unlock-password', { password: this.password });
  }

  private submitRecovery(e: Event) {
    e.preventDefault();
    this.start('unlock-recovery', { recoveryKey: this.recoveryKey });
  }

  private start<T>(name: string, detail: T) {
    this.error = '';
    this.busy = true;
    this.emit(name, detail);
  }

  private emit<T>(name: string, detail: T) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  /** Called by the app shell when unlocking failed. */
  showError(message: string) {
    this.error = message;
    this.busy = false;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'unlock-view': UnlockView;
  }
}
