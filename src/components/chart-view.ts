/**
 * Chart View
 *
 * The chart of accounts: list by type and parent, add an account, rename, close, and
 * reopen. Every change rewrites the whole `ledger/accounts` document through
 * `LedgerSpace.updateAccounts`, which enforces the post-time rules. Envelope and budget
 * flags are left to the budgeting issues (0024).
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { isCommodity } from '@/core/amount.js';
import { newAccountId, type AccountId, type IsoDate } from '@/core/ids.js';
import { ACCOUNT_TYPES, type Account, type AccountsDoc, type AccountType } from '@/core/messages.js';
import type { LedgerSpace } from '@/services/ledger-space.js';
import { InvalidDocError } from '@/services/state-store.js';

const TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expenses',
};

interface Row {
  id: AccountId;
  account: Account;
  depth: number;
}

/** The accounts of one type, parents before children, siblings by name. */
function rowsOf(doc: AccountsDoc, type: AccountType, showClosed: boolean): Row[] {
  const all = (Object.entries(doc.accounts) as [AccountId, Account][]).filter(([, a]) => a.type === type);
  const byName = (x: [AccountId, Account], y: [AccountId, Account]) => x[1].name.localeCompare(y[1].name);
  const rows: Row[] = [];
  const walk = (parent: AccountId | null, depth: number) => {
    for (const [id, account] of all.filter(([, a]) => a.parent === parent).sort(byName)) {
      if (account.closed_at && !showClosed) continue;
      rows.push({ id, account, depth });
      walk(id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

function today(): IsoDate {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` as IsoDate;
}

function message(err: unknown): string {
  if (err instanceof InvalidDocError) return err.problems.join('. ');
  return err instanceof Error ? err.message : String(err);
}

@customElement('chart-view')
export class ChartView extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    h2,
    h3 {
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
    }

    input:focus,
    select:focus {
      border-color: var(--color-accent);
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }

    .toolbar label {
      color: var(--color-text-secondary);
      font-size: var(--font-size-sm);
    }

    form.add {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      background-color: var(--color-bg-elevated);
      border-radius: var(--radius-md);
      margin-bottom: var(--spacing-lg);
    }

    form.add input[name='name'] {
      flex: 1 1 160px;
    }

    form.add input[name='cur'] {
      width: 7em;
      text-transform: uppercase;
    }

    .primary {
      padding: var(--spacing-xs) var(--spacing-md);
      background-color: var(--color-accent);
      color: #000;
      font-weight: 600;
      border-radius: var(--radius-full);
    }

    .primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .error {
      color: var(--color-error);
      margin-bottom: var(--spacing-md);
    }

    section {
      margin-bottom: var(--spacing-lg);
    }

    h3 {
      font-size: var(--font-size-sm);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--color-text-secondary);
      margin-bottom: var(--spacing-xs);
    }

    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    li {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
    }

    li:hover {
      background-color: var(--color-bg-secondary);
    }

    .name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .closed .name {
      color: var(--color-text-subdued);
      text-decoration: line-through;
    }

    .cur,
    .meta {
      color: var(--color-text-subdued);
      font-size: var(--font-size-sm);
      font-family: var(--font-family-mono);
    }

    .actions button {
      color: var(--color-text-secondary);
      font-size: var(--font-size-sm);
      padding: 0 var(--spacing-xs);
    }

    .actions button:hover {
      color: var(--color-accent);
    }

    .empty {
      color: var(--color-text-subdued);
      font-size: var(--font-size-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
    }
  `;

  @property({ attribute: false }) ledger!: LedgerSpace;
  @property({ attribute: false }) doc!: AccountsDoc;

  @state() private showClosed = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private newType: AccountType = 'asset';
  @state() private renaming: AccountId | null = null;

  render() {
    return html`
      <div class="toolbar">
        <h2>Chart of accounts</h2>
        <label>
          <input type="checkbox" .checked=${this.showClosed}
            @change=${(e: Event) => (this.showClosed = (e.target as HTMLInputElement).checked)} />
          Show closed
        </label>
      </div>

      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${this.renderAddForm()}
      ${ACCOUNT_TYPES.map((type) => this.renderType(type))}

      <p class="meta">Revision ${this.doc.rev}</p>
    `;
  }

  private renderAddForm() {
    const parents = rowsOf(this.doc, this.newType, false);
    return html`
      <form class="add" @submit=${this.add}>
        <input name="name" placeholder="New account name" required autocomplete="off" />
        <select name="type" @change=${(e: Event) => (this.newType = (e.target as HTMLSelectElement).value as AccountType)}>
          ${ACCOUNT_TYPES.map((t) => html`<option value=${t} ?selected=${t === this.newType}>${TYPE_LABELS[t]}</option>`)}
        </select>
        <select name="parent">
          <option value="">No parent</option>
          ${parents.map((r) => html`<option value=${r.id}>${'  '.repeat(r.depth)}${r.account.name}</option>`)}
        </select>
        <input name="cur" value="USD" required title="Commodity, such as USD or VTI" autocomplete="off" />
        <button class="primary" type="submit" ?disabled=${this.busy}>Add</button>
      </form>
    `;
  }

  private renderType(type: AccountType) {
    const rows = rowsOf(this.doc, type, this.showClosed);
    return html`
      <section>
        <h3>${TYPE_LABELS[type]}</h3>
        ${rows.length === 0
          ? html`<div class="empty">None yet.</div>`
          : html`<ul>${rows.map((r) => this.renderRow(r))}</ul>`}
      </section>
    `;
  }

  private renderRow({ id, account, depth }: Row) {
    const closed = account.closed_at !== undefined;
    return html`
      <li class=${closed ? 'closed' : ''} style="padding-left: calc(var(--spacing-sm) + ${depth} * var(--spacing-lg))">
        ${this.renaming === id
          ? html`<input class="name" .value=${account.name} autofocus
              @keydown=${(e: KeyboardEvent) => this.renameKey(e, id)}
              @blur=${() => (this.renaming = null)} />`
          : html`<span class="name">${account.name}</span>`}
        ${closed ? html`<span class="meta">closed ${account.closed_at}</span>` : nothing}
        <span class="cur">${account.cur}</span>
        <span class="actions">
          <button type="button" ?disabled=${this.busy} @click=${() => (this.renaming = id)}>Rename</button>
          ${closed
            ? html`<button type="button" ?disabled=${this.busy} @click=${() => this.reopen(id)}>Reopen</button>`
            : html`<button type="button" ?disabled=${this.busy} @click=${() => this.close(id)}>Close</button>`}
        </span>
      </li>
    `;
  }

  private async add(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const name = String(data.get('name')).trim();
    const cur = String(data.get('cur')).trim().toUpperCase();
    const parent = (String(data.get('parent')) || null) as AccountId | null;
    if (!name) return;
    if (!isCommodity(cur)) {
      this.error = `${cur} is not a commodity code.`;
      return;
    }
    const account: Account = { name, type: this.newType, cur, parent };
    const id = newAccountId(crypto.getRandomValues(new Uint8Array(15)));
    if (await this.save((doc) => ({ ...doc, accounts: { ...doc.accounts, [id]: account } }))) {
      form.reset();
      this.newType = account.type;
    }
  }

  private renameKey(e: KeyboardEvent, id: AccountId) {
    if (e.key === 'Escape') this.renaming = null;
    if (e.key !== 'Enter') return;
    const name = (e.target as HTMLInputElement).value.trim();
    this.renaming = null;
    if (name && name !== this.doc.accounts[id].name) {
      void this.save((doc) => patch(doc, id, (a) => ({ ...a, name })));
    }
  }

  private close(id: AccountId) {
    const closed_at = today();
    void this.save((doc) => patch(doc, id, (a) => ({ ...a, closed_at })));
  }

  private reopen(id: AccountId) {
    void this.save((doc) =>
      patch(doc, id, (a) => {
        const { closed_at: _, ...open } = a;
        return open;
      }),
    );
  }

  /** Applies `edit` to the latest chart in the space, and shows the result. */
  private async save(edit: (doc: AccountsDoc) => AccountsDoc): Promise<boolean> {
    this.busy = true;
    this.error = '';
    try {
      this.doc = await this.ledger.updateAccounts(edit);
      return true;
    } catch (err) {
      this.error = message(err);
      return false;
    } finally {
      this.busy = false;
    }
  }
}

function patch(doc: AccountsDoc, id: AccountId, f: (a: Account) => Account): AccountsDoc {
  const a = doc.accounts[id];
  if (!a) throw new Error('That account is no longer in the chart.');
  return { ...doc, accounts: { ...doc.accounts, [id]: f(a) } };
}

declare global {
  interface HTMLElementTagNameMap {
    'chart-view': ChartView;
  }
}
