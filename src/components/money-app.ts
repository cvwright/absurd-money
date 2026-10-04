/**
 * Money App - Main Application Shell
 *
 * Root component. For now it only proves the app boots and the reeeductio SDK
 * is linked; login, the chart of accounts, and registers come in later issues.
 */

import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { setLogLevel } from 'reeeductio';

setLogLevel(import.meta.env.DEV ? 'debug' : 'warn');

@customElement('money-app')
export class MoneyApp extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-sm);
      min-height: 100vh;
      min-height: 100dvh;
      padding: var(--spacing-md);
      text-align: center;
    }

    h1 {
      font-size: var(--font-size-xxl);
      font-weight: 600;
    }

    p {
      color: var(--color-text-secondary);
    }
  `;

  render() {
    return html`
      <h1>Absurd Money</h1>
      <p>Encrypted double-entry bookkeeping. Nothing here yet.</p>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'money-app': MoneyApp;
  }
}
