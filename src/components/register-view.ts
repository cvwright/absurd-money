/**
 * Register View
 *
 * One account's register: every split posted to it, sorted by entry date and then by
 * chain position, with the running balance. Each line shows the effective payee, memo,
 * and other accounts, after edits. Amounts and balances are signed the way the chart
 * shows the account's type. The lines come from the projection's `register` query, and
 * are queried again whenever the projection changes.
 *
 * Picking another account fires `account-selected`, so the app keeps the choice across
 * pages. Reversals show as their own lines, marked on both sides; collapsing a pair into
 * its net belongs with reversals (0014).
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { accountLabel, accountPath, chartOf, type Chart } from '@/core/chart.js';
import type { AccountId, PayeeId } from '@/core/ids.js';
import { ACCOUNT_TYPES, type AccountsDoc, type AccountType, type PayeesDoc } from '@/core/messages.js';
import type { ProjectionClient } from '@/projection/client.js';
import type { RegisterLine } from '@/projection/projection.js';
import { comparePaths, errorMessage, formatAmount, shownAs } from './forms.js';

const TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expenses',
};

const KIND_TAGS: Record<RegisterLine['kind'], string> = {
  entry: '',
  reversal: 'Reversal',
  lotadjust: 'Lot adjustment',
};

/** Every account, by type, sorted by path, closed ones included. */
function optionsOf(chart: Chart): [AccountType, { id: AccountId; label: string }[]][] {
  return ACCOUNT_TYPES.map((type) => [
    type,
    [...chart]
      .filter(([, a]) => a.type === type)
      .map(([id]) => ({ id, path: accountPath(chart, id) }))
      .sort((x, y) => comparePaths(x.path, y.path))
      .map(({ id, path }) => ({ id, label: path.join(' › ') })),
  ]);
}

/** A payee's name, following one merge. */
function payeeName(doc: PayeesDoc | undefined, id: PayeeId): string {
  const p = doc?.payees[id];
  if (!p) return '';
  return (p.merged_into && doc.payees[p.merged_into]?.name) || p.name;
}

@customElement('register-view')
export class RegisterView extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    h2 {
      margin: 0;
    }

    select {
      font: inherit;
      padding: var(--spacing-xs) var(--spacing-sm);
      background-color: var(--color-bg-highlight);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-primary);
      outline: none;
      max-width: 100%;
    }

    select:focus {
      border-color: var(--color-accent);
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }

    .error {
      color: var(--color-error);
      margin-bottom: var(--spacing-md);
    }

    .empty {
      color: var(--color-text-subdued);
      font-size: var(--font-size-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
    }

    .scroll {
      overflow-x: auto;
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

    .desc {
      min-width: 10em;
    }

    .memo,
    .tag {
      color: var(--color-text-subdued);
    }

    .tag {
      font-size: var(--font-size-xs);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-left: var(--spacing-xs);
    }

    .reversed .num.amount {
      text-decoration: line-through;
      color: var(--color-text-subdued);
    }

    .others {
      color: var(--color-text-secondary);
    }

    .negative {
      color: var(--color-negative);
    }
  `;

  @property({ attribute: false }) projection!: ProjectionClient;
  @property({ attribute: false }) doc!: AccountsDoc;
  @property({ attribute: false }) account: AccountId | null = null;

  @state() private lines: RegisterLine[] | null = null;
  @state() private payees: PayeesDoc | undefined;
  @state() private error = '';

  /** Counts queries, so a slow answer for an account no longer shown is dropped. */
  private generation = 0;
  private readonly onChange = () => void this.load();

  connectedCallback() {
    super.connectedCallback();
    this.projection.addEventListener('change', this.onChange);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.projection.removeEventListener('change', this.onChange);
  }

  willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has('account') || changed.has('projection')) {
      this.lines = null;
      void this.load();
    }
  }

  private async load() {
    const generation = ++this.generation;
    const account = this.account;
    if (account === null) return;
    try {
      const [lines, payees] = await Promise.all([
        this.projection.call('register', account),
        this.projection.call('doc', 'ledger/payees') as Promise<PayeesDoc | undefined>,
      ]);
      if (generation !== this.generation) return;
      this.lines = lines;
      this.payees = payees;
      this.error = '';
    } catch (err) {
      if (generation === this.generation) this.error = errorMessage(err);
    }
  }

  render() {
    const chart = chartOf(this.doc);
    const account = this.account === null ? undefined : chart.get(this.account);
    return html`
      <div class="toolbar">
        <h2>Register</h2>
        <select aria-label="Account" @change=${this.pick}>
          <option value="" ?selected=${!account} disabled>Choose an account</option>
          ${optionsOf(chart).map(([type, options]) =>
            options.length === 0
              ? nothing
              : html`<optgroup label=${TYPE_LABELS[type]}>
                  ${options.map((o) => html`<option value=${o.id} ?selected=${o.id === this.account}>${o.label}</option>`)}
                </optgroup>`,
          )}
        </select>
      </div>

      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${account ? this.renderLines(chart, account.type, account.cur) : html`<div class="empty">Choose an account to see its register.</div>`}
    `;
  }

  private renderLines(chart: Chart, type: AccountType, cur: string) {
    if (this.lines === null) return html`<div class="empty">Loading…</div>`;
    if (this.lines.length === 0) return html`<div class="empty">Nothing posted to this account yet.</div>`;
    return html`
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Account</th>
              <th class="num">Amount</th>
              <th class="num">Balance ${cur}</th>
            </tr>
          </thead>
          <tbody>
            ${this.lines.map((l) => this.renderLine(l, chart, type))}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderLine(l: RegisterLine, chart: Chart, type: AccountType) {
    const amount = shownAs(type, l.amount);
    const balance = shownAs(type, l.balance);
    const payee = l.payee ? payeeName(this.payees, l.payee) : '';
    const tag = l.reversedBy ? 'Reversed' : KIND_TAGS[l.kind];
    const others = l.others.map((id) => accountLabel(chart, id) || id);
    return html`
      <tr class=${l.reversedBy ? 'reversed' : ''}>
        <td class="date">${l.date}</td>
        <td class="desc">
          ${payee}${payee && l.memo ? html`<br />` : nothing}${l.memo ? html`<span class="memo">${l.memo}</span>` : nothing}
          ${tag ? html`<span class="tag">${tag}</span>` : nothing}
        </td>
        <td class="others" title=${others.join('\n')}>
          ${others.length === 0 ? '—' : others.length === 1 ? others[0] : `Split: ${others.join(', ')}`}
        </td>
        <td class="num amount ${amount.amount < 0n ? 'negative' : ''}">${formatAmount(amount)}</td>
        <td class="num ${balance.amount < 0n ? 'negative' : ''}">${formatAmount(balance)}</td>
      </tr>
    `;
  }

  private pick(e: Event) {
    const id = (e.target as HTMLSelectElement).value as AccountId;
    this.dispatchEvent(new CustomEvent<AccountId>('account-selected', { detail: id, bubbles: true }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'register-view': RegisterView;
  }
}
