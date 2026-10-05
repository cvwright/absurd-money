/**
 * Styles shared by the full-screen cards shown before the books are open: setup, unlock,
 * and protecting the keys.
 */

import { css } from 'lit';

export const cardStyles = css`
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
  h2,
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

  h2 {
    font-size: var(--font-size-lg);
    margin-bottom: var(--spacing-sm);
  }

  .lede {
    color: var(--color-text-secondary);
    text-align: center;
    margin-bottom: var(--spacing-lg);
  }

  .note {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    margin-bottom: var(--spacing-md);
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

  .primary,
  .secondary {
    width: 100%;
    padding: var(--spacing-sm) var(--spacing-md);
    border-radius: var(--radius-full);
    font-size: var(--font-size-lg);
  }

  .primary {
    background-color: var(--color-accent);
    color: #000;
    font-weight: 700;
  }

  .primary:hover {
    background-color: var(--color-accent-hover);
  }

  .secondary {
    background-color: var(--color-bg-highlight);
    color: var(--color-text-primary);
    font-weight: 600;
  }

  .primary:disabled,
  .secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .link {
    display: block;
    margin: var(--spacing-md) auto 0;
    background: none;
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .or {
    text-align: center;
    color: var(--color-text-subdued);
    font-size: var(--font-size-sm);
    margin: var(--spacing-md) 0;
  }

  .error {
    color: var(--color-error);
    font-size: var(--font-size-sm);
    margin-bottom: var(--spacing-md);
    text-align: center;
  }

  .done {
    color: var(--color-accent);
    font-weight: 600;
    margin-bottom: var(--spacing-md);
  }

  section + section {
    margin-top: var(--spacing-lg);
    padding-top: var(--spacing-lg);
    border-top: 1px solid var(--color-bg-highlight);
  }
`;
