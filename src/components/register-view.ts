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
 * pages.
 *
 * An entry and its reversal on the same date show as one line with their net, and a
 * replacement entry is marked as the corrected line (see `Projection.register`). "Show
 * reversals" lists every line as posted instead. Any entry not yet reversed can be
 * reversed from here: the dialog shows the inverse splits, with the effective accounts,
 * and posts a `ledger.reversal` dated per the routing rule unless the user changes it
 * (0014).
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { accountLabel, accountPath, chartOf, type Chart } from '@/core/chart.js';
import { isIsoDate, yearOf, type AccountId, type MsgId, type PayeeId } from '@/core/ids.js';
import { ACCOUNT_TYPES, type AccountsDoc, type AccountType, type PayeesDoc } from '@/core/messages.js';
import { defaultReversalDate, inverseSplits, reversalOf, type ReversalTarget } from '@/core/reversal.js';
import type { ProjectionClient } from '@/projection/client.js';
import type { RegisterLine } from '@/projection/projection.js';
import type { LedgerSpace } from '@/services/ledger-space.js';
import { today } from './dates.js';
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

/** The reversal being drafted in the dialog. */
interface Draft {
  target: ReversalTarget;
  date: string;
  memo: string;
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

    .collapsed td {
      color: var(--color-text-subdued);
    }

    button {
      font: inherit;
      border: none;
      cursor: pointer;
      background: none;
      color: inherit;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-md);
    }

    .controls label {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: var(--font-size-sm);
      color: var(--color-text-secondary);
    }

    .action {
      color: var(--color-text-subdued);
      font-size: var(--font-size-xs);
      visibility: hidden;
    }

    tbody tr:hover .action,
    .action:focus {
      visibility: visible;
    }

    .action:hover {
      color: var(--color-accent);
    }

    @media (hover: none) {
      .action {
        visibility: visible;
      }
    }

    dialog {
      background-color: var(--color-bg-elevated);
      color: var(--color-text-primary);
      border: none;
      border-radius: var(--radius-lg);
      padding: var(--spacing-lg);
      width: min(520px, calc(100vw - 2 * var(--spacing-md)));
    }

    dialog::backdrop {
      background: rgb(0 0 0 / 50%);
    }

    dialog h3 {
      margin: 0 0 var(--spacing-sm);
    }

    dialog p {
      margin: 0 0 var(--spacing-md);
      color: var(--color-text-secondary);
      font-size: var(--font-size-sm);
    }

    dialog .fields {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }

    dialog .fields label {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    dialog .fields .memo {
      flex: 1 1 200px;
    }

    dialog .fields .memo input {
      flex: 1;
    }

    dialog input {
      font: inherit;
      padding: var(--spacing-xs) var(--spacing-sm);
      background-color: var(--color-bg-highlight);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-primary);
      outline: none;
      min-width: 0;
    }

    dialog input:focus {
      border-color: var(--color-accent);
    }

    dialog table {
      margin-bottom: var(--spacing-md);
    }

    .buttons {
      display: flex;
      justify-content: flex-end;
      gap: var(--spacing-md);
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

    .others {
      color: var(--color-text-secondary);
    }

    .negative {
      color: var(--color-negative);
    }
  `;

  @property({ attribute: false }) projection!: ProjectionClient;
  @property({ attribute: false }) ledger!: LedgerSpace;
  @property({ attribute: false }) doc!: AccountsDoc;
  @property({ attribute: false }) account: AccountId | null = null;

  @state() private lines: RegisterLine[] | null = null;
  @state() private payees: PayeesDoc | undefined;
  @state() private error = '';
  /** List every line as posted, without collapsing reversed pairs. */
  @state() private showReversals = false;
  @state() private draft: Draft | null = null;
  @state() private draftError = '';
  @state() private busy = false;
  @query('dialog') private dialog?: HTMLDialogElement;

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
    if (changed.has('account') || changed.has('projection') || changed.has('showReversals')) {
      this.lines = null;
      void this.load();
    }
  }

  updated(changed: Map<PropertyKey, unknown>) {
    if (changed.has('draft') && this.draft && !this.dialog?.open) this.dialog?.showModal();
  }

  private async load() {
    const generation = ++this.generation;
    const account = this.account;
    if (account === null) return;
    try {
      const [lines, payees] = await Promise.all([
        this.projection.call('register', account, !this.showReversals),
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
        <div class="controls">
          <label>
            <input type="checkbox" .checked=${this.showReversals}
              @change=${(e: Event) => (this.showReversals = (e.target as HTMLInputElement).checked)} />
            Show reversals
          </label>
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
      </div>

      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${account ? this.renderLines(chart, account.type, account.cur) : html`<div class="empty">Choose an account to see its register.</div>`}
      ${this.renderDialog(chart)}
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
              <th aria-label="Actions"></th>
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
    const tag = l.reversedBy ? 'Reversed' : l.replaces ? 'Corrected' : KIND_TAGS[l.kind];
    const others = l.others.map((id) => accountLabel(chart, id) || id);
    const rowClass = l.collapsed ? 'collapsed' : l.reversedBy ? 'reversed' : '';
    const reversible = l.kind === 'entry' && !l.reversedBy;
    return html`
      <tr class=${rowClass} title=${l.collapsed ? 'Reversed the same day; the amount is the net' : ''}>
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
        <td>
          ${reversible
            ? html`<button class="action" type="button" ?disabled=${this.busy}
                @click=${() => this.startReversal(l.txn)}>Reverse</button>`
            : nothing}
        </td>
      </tr>
    `;
  }

  private renderDialog(chart: Chart) {
    const d = this.draft;
    return html`
      <dialog @close=${() => (this.draft = null)} aria-labelledby="reverse-title">
        ${d
          ? html`
              <h3 id="reverse-title">Reverse this entry</h3>
              <p>
                Posts the opposite of every split, so the entry no longer counts. Both stay in
                the journal.${d.target.locked || !d.target.segmentOpen
                  ? ' The entry is in a closed period, so the reversal is dated today.'
                  : ''}
              </p>
              ${this.draftError ? html`<div class="error" role="alert">${this.draftError}</div>` : nothing}
              <div class="fields">
                <label>
                  Date
                  <input type="date" required .value=${d.date}
                    @input=${(e: Event) => (this.draft = { ...d, date: (e.target as HTMLInputElement).value })} />
                </label>
                <label class="memo">
                  Memo
                  <input .value=${d.memo} placeholder="Optional"
                    @input=${(e: Event) => (this.draft = { ...d, memo: (e.target as HTMLInputElement).value })} />
                </label>
              </div>
              <table>
                <thead>
                  <tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr>
                </thead>
                <tbody>
                  ${inverseSplits(d.target).map(
                    (s) => html`<tr>
                      <td>${accountLabel(chart, s.account) || s.account}</td>
                      <td class="num">${s.amount > 0n ? formatAmount(s) : ''}</td>
                      <td class="num">${s.amount < 0n ? formatAmount({ ...s, amount: -s.amount }) : ''}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
              <div class="buttons">
                <button type="button" @click=${() => this.dialog?.close()}>Cancel</button>
                <button class="primary" type="button" ?disabled=${this.busy} @click=${this.postReversal}>
                  Post reversal
                </button>
              </div>
            `
          : nothing}
      </dialog>
    `;
  }

  private async startReversal(id: MsgId) {
    this.error = '';
    try {
      const target = await this.projection.call('reversalTarget', id);
      if (!target) throw new Error('That entry is no longer in the local books.');
      if (target.reversedBy) throw new Error('That entry has already been reversed.');
      this.draftError = '';
      this.draft = { target, date: defaultReversalDate(target, today()), memo: '' };
    } catch (err) {
      this.error = errorMessage(err);
    }
  }

  private async postReversal() {
    const d = this.draft;
    if (!d) return;
    if (!isIsoDate(d.date)) {
      this.draftError = 'Enter the date.';
      return;
    }
    this.busy = true;
    this.draftError = '';
    try {
      const reversal = reversalOf(d.target, { date: d.date, memo: d.memo });
      const segmentOpen = await this.projection.call('segmentOpen', yearOf(d.date));
      await this.ledger.postReversal(reversal, d.target, segmentOpen);
      this.dialog?.close();
    } catch (err) {
      this.draftError = errorMessage(err);
    } finally {
      this.busy = false;
    }
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
