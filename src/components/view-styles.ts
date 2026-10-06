/**
 * Styles shared by the import view and its profile editor: form controls, tables of
 * rows, and messages.
 */

import { css } from 'lit';

export const viewStyles = css`
  :host {
    display: block;
  }

  h2,
  h3,
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

  input,
  select {
    font: inherit;
    padding: var(--spacing-xs) var(--spacing-sm);
    background-color: var(--color-bg-highlight);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--color-text-primary);
    outline: none;
    min-width: 0;
    max-width: 100%;
  }

  input:focus,
  select:focus {
    border-color: var(--color-accent);
  }

  input[type='checkbox'] {
    padding: 0;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-md);
    margin-bottom: var(--spacing-md);
  }

  .intro,
  .note {
    color: var(--color-text-secondary);
    margin-bottom: var(--spacing-md);
  }

  .note {
    font-size: var(--font-size-sm);
  }

  .fields {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--spacing-sm) var(--spacing-md);
    margin-bottom: var(--spacing-md);
  }

  .fields label {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .narrow {
    width: 5em;
  }

  .scroll {
    overflow-x: auto;
    margin-bottom: var(--spacing-md);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-sm);
  }

  th {
    text-align: left;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: var(--font-size-xs);
    padding: var(--spacing-xs) var(--spacing-sm);
    border-bottom: 1px solid var(--color-bg-highlight);
  }

  td {
    padding: var(--spacing-xs) var(--spacing-sm);
    vertical-align: top;
  }

  tbody tr:hover {
    background-color: var(--color-bg-secondary);
  }

  .date,
  .num {
    font-family: var(--font-family-mono);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  th.num,
  td.num {
    text-align: right;
  }

  .memo,
  .hint {
    color: var(--color-text-subdued);
  }

  .hint {
    font-size: var(--font-size-xs);
  }

  .negative {
    color: var(--color-negative);
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--spacing-md);
  }

  .link {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .link:hover {
    color: var(--color-accent);
  }

  .primary {
    padding: var(--spacing-xs) var(--spacing-lg);
    background-color: var(--color-accent);
    color: #000;
    font-weight: 600;
    border-radius: var(--radius-full);
  }

  .primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .empty {
    color: var(--color-text-subdued);
    font-size: var(--font-size-sm);
    padding: var(--spacing-xs) var(--spacing-sm);
  }

  .error {
    color: var(--color-error);
    margin-bottom: var(--spacing-md);
  }

  .warning {
    color: var(--color-warning);
    margin-bottom: var(--spacing-md);
  }

  .posted {
    color: var(--color-positive);
    margin-bottom: var(--spacing-md);
  }

  section {
    margin-top: var(--spacing-xl);
  }

  h3 {
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-secondary);
    margin-bottom: var(--spacing-xs);
  }
`;
