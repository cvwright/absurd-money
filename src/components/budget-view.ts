/**
 * Budget View
 *
 * The envelopes in `ledger/budget` (0024): add, rename, close, and reopen them, choose
 * which envelope each expense account is spent from, and allocate money to an envelope by
 * posting a `ledger.allocation` to `budget`. Each envelope shows what it has available
 * from the projection: everything allocated to it, less everything spent from it, so a
 * leftover rolls over. Every change to the document goes through
 * `LedgerSpace.updateBudget`, which enforces the post-time rules.
 *
 * Pairing is timeless, so moving an expense account to another envelope moves all of its
 * spending, past and future. The view says how much before it does.
 *
 * Budgetable accounts, To Be Budgeted, and moves between envelopes come with 0026; the
 * monthly schedule with 0025.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { isCommodity, isZero, minor, type Amount, type Commodity } from '@/core/amount.js';
import { budgetRefProblems, EMPTY_BUDGET, pairedTo, withEnvelope, withPairing } from '@/core/budget.js';
import { accountLabel, accountPath, chartOf, type Chart } from '@/core/chart.js';
import { ParseError } from '@/core/errors.js';
import { balanceOf, type Balances } from '@/core/fold/ledger.js';
import { isIsoDate, newEnvelopeId, type AccountId, type EnvelopeId } from '@/core/ids.js';
import type { AccountsDoc, BudgetDoc, Envelope } from '@/core/messages.js';
import type { ProjectionClient } from '@/projection/client.js';
import type { LedgerSpace } from '@/services/ledger-space.js';
import { today } from './dates.js';
import { amountOf, comparePaths, errorMessage, formatAmount } from './forms.js';
import { viewStyles } from './view-styles.js';

interface AllocationInput {
  envelope: EnvelopeId;
  amount: string;
  date: string;
  memo: string;
}

/** The envelopes by name, open ones only unless `showClosed`. */
function envelopesOf(doc: BudgetDoc, showClosed: boolean): [EnvelopeId, Envelope][] {
  return (Object.entries(doc.envelopes) as [EnvelopeId, Envelope][])
    .filter(([, e]) => showClosed || e.closed_at === undefined)
    .sort((x, y) => x[1].name.localeCompare(y[1].name));
}

/** The expense accounts that can be paired, plus closed ones that already are, by path. */
function expenseAccounts(chart: Chart, doc: BudgetDoc): { id: AccountId; path: string[] }[] {
  return [...chart]
    .filter(([id, a]) => a.type === 'expense' && (a.closed_at === undefined || Object.hasOwn(doc.spent_from, id)))
    .map(([id]) => ({ id, path: accountPath(chart, id) }))
    .sort((x, y) => comparePaths(x.path, y.path));
}

@customElement('budget-view')
export class BudgetView extends LitElement {
  static styles = [
    viewStyles,
    css`
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

      input[name='cur'] {
        width: 7em;
        text-transform: uppercase;
      }

      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      li {
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
      }

      li:hover {
        background-color: var(--color-bg-secondary);
      }

      .row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
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

      form.allocate {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--spacing-sm);
        margin: var(--spacing-xs) 0 var(--spacing-sm);
      }

      form.allocate input[name='amount'] {
        width: 8em;
      }

      form.allocate input[name='memo'] {
        flex: 1 1 120px;
      }
    `,
  ];

  @property({ attribute: false }) ledger!: LedgerSpace;
  @property({ attribute: false }) projection!: ProjectionClient;
  @property({ attribute: false }) doc!: AccountsDoc;

  @state() private budget: BudgetDoc = EMPTY_BUDGET;
  @state() private available = new Map<EnvelopeId, Amount>();
  @state() private balances: Balances = new Map();
  @state() private showClosed = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private posted = '';
  @state() private renaming: EnvelopeId | null = null;
  @state() private allocating: AllocationInput | null = null;

  private readonly onChange = () => void this.load();

  connectedCallback() {
    super.connectedCallback();
    this.projection.addEventListener('change', this.onChange);
    void this.load();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.projection.removeEventListener('change', this.onChange);
  }

  private async load() {
    try {
      const [doc, available, balances] = await Promise.all([
        this.projection.call('doc', 'ledger/budget') as Promise<BudgetDoc | undefined>,
        this.projection.call('available'),
        this.projection.call('balances'),
      ]);
      // A document just written here may not have synced back yet.
      if (doc && doc.rev >= this.budget.rev) this.budget = doc;
      this.available = available;
      this.balances = balances;
    } catch (err) {
      console.warn('[budget-view] projection unavailable:', err);
    }
  }

  private get chart(): Chart {
    return chartOf(this.doc);
  }

  render() {
    const chart = this.chart;
    const envelopes = envelopesOf(this.budget, this.showClosed);
    const problems = budgetRefProblems(this.budget, chart);
    return html`
      <div class="toolbar">
        <h2>Budget</h2>
        <label class="link">
          <input type="checkbox" .checked=${this.showClosed}
            @change=${(e: Event) => (this.showClosed = (e.target as HTMLInputElement).checked)} />
          Show closed
        </label>
      </div>
      <p class="intro">
        An envelope holds money set aside for spending. Each expense account is spent from at
        most one envelope. What an envelope has available is everything allocated to it, less
        everything spent from it, so whatever is left over rolls into next month.
      </p>

      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${this.posted ? html`<div class="posted" role="status">${this.posted}</div>` : nothing}
      ${problems.length > 0
        ? html`<div class="warning">These parts of the budget don't count: ${problems.join('; ')}.</div>`
        : nothing}

      <form class="add" @submit=${this.add}>
        <input name="name" placeholder="New envelope name" required autocomplete="off" />
        <input name="cur" value="USD" required title="Commodity, such as USD" autocomplete="off" />
        <button class="primary" type="submit" ?disabled=${this.busy}>Add envelope</button>
      </form>

      <h3>Envelopes</h3>
      ${envelopes.length === 0
        ? html`<div class="empty">No envelopes yet.</div>`
        : html`<ul>${envelopes.map(([id, e]) => this.renderEnvelope(chart, id, e))}</ul>`}

      ${this.renderPairings(chart)}

      <p class="meta">Revision ${this.budget.rev}</p>
    `;
  }

  private renderEnvelope(chart: Chart, id: EnvelopeId, e: Envelope) {
    const closed = e.closed_at !== undefined;
    const avail = this.available.get(id) ?? { amount: 0n, exp: 0, cur: e.cur };
    const funds = pairedTo(this.budget, id).map((a) => accountLabel(chart, a)).sort();
    return html`
      <li class=${closed ? 'closed' : ''}>
        <div class="row">
          ${this.renaming === id
            ? html`<input class="name" .value=${e.name} autofocus
                @keydown=${(ev: KeyboardEvent) => this.renameKey(ev, id)}
                @blur=${() => (this.renaming = null)} />`
            : html`<span class="name">${e.name}</span>`}
          ${closed ? html`<span class="meta">closed ${e.closed_at}</span>` : nothing}
          <span class="num ${avail.amount < 0n ? 'negative' : ''}" title="Available">${formatAmount(avail)}</span>
          <span class="cur">${e.cur}</span>
          <span class="actions">
            ${closed
              ? nothing
              : html`<button type="button" ?disabled=${this.busy} @click=${() => this.startAllocating(id)}>Allocate</button>`}
            <button type="button" ?disabled=${this.busy} @click=${() => (this.renaming = id)}>Rename</button>
            ${closed
              ? html`<button type="button" ?disabled=${this.busy} @click=${() => this.reopen(id)}>Reopen</button>`
              : html`<button type="button" ?disabled=${this.busy} @click=${() => this.close(id, e, avail)}>Close</button>`}
          </span>
        </div>
        <div class="hint">${funds.length > 0 ? `Spent from by ${funds.join(', ')}` : 'No expense accounts spend from it.'}</div>
        ${this.allocating?.envelope === id ? this.renderAllocate(this.allocating) : nothing}
      </li>
    `;
  }

  private renderAllocate(input: AllocationInput) {
    const set = (field: 'amount' | 'date' | 'memo') => (ev: Event) => {
      this.allocating = { ...input, [field]: (ev.target as HTMLInputElement).value };
    };
    return html`
      <form class="allocate" @submit=${this.allocate}>
        <input name="amount" .value=${input.amount} @input=${set('amount')} placeholder="Amount" required
          autocomplete="off" autofocus title="A negative amount takes money out of the envelope" />
        <input name="date" type="date" .value=${input.date} @input=${set('date')} required />
        <input name="memo" .value=${input.memo} @input=${set('memo')} placeholder="Memo (optional)" autocomplete="off" />
        <button class="primary" type="submit" ?disabled=${this.busy}>Allocate</button>
        <button class="link" type="button" @click=${() => (this.allocating = null)}>Cancel</button>
      </form>
    `;
  }

  private renderPairings(chart: Chart) {
    const accounts = expenseAccounts(chart, this.budget);
    const open = envelopesOf(this.budget, false);
    return html`
      <section>
        <h3>Spending</h3>
        <p class="note intro">Which envelope each expense account is spent from.</p>
        ${accounts.length === 0
          ? html`<div class="empty">No expense accounts yet. Add them in Accounts.</div>`
          : html`<div class="scroll"><table>
              <thead><tr><th>Expense account</th><th>Spent from</th></tr></thead>
              <tbody>
                ${accounts.map(({ id, path }) => {
                  const cur = chart.get(id)!.cur;
                  const current = this.budget.spent_from[id] as EnvelopeId | undefined;
                  const choices = open.filter(([eid, e]) => e.cur === cur || eid === current);
                  if (current && !choices.some(([eid]) => eid === current)) {
                    const e = this.budget.envelopes[current];
                    choices.push([current, e ?? { name: 'Unknown envelope', cur }]);
                  }
                  return html`<tr>
                    <td>${path.join(' › ')}</td>
                    <td>
                      <select ?disabled=${this.busy} @change=${(ev: Event) => this.pair(id, ev)}>
                        <option value="" ?selected=${!current}>No envelope</option>
                        ${choices.map(([eid, e]) => html`<option value=${eid} ?selected=${eid === current}>${e.name}</option>`)}
                      </select>
                    </td>
                  </tr>`;
                })}
              </tbody>
            </table></div>`}
      </section>
    `;
  }

  private async add(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const name = String(data.get('name')).trim();
    const cur = String(data.get('cur')).trim().toUpperCase();
    if (!name) return;
    if (!isCommodity(cur)) {
      this.error = `${cur} is not a commodity code.`;
      return;
    }
    const id = newEnvelopeId(crypto.getRandomValues(new Uint8Array(15)));
    const envelope: Envelope = { name, cur };
    if (await this.save((doc) => ({ ...doc, envelopes: { ...doc.envelopes, [id]: envelope } }))) form.reset();
  }

  private renameKey(e: KeyboardEvent, id: EnvelopeId) {
    if (e.key === 'Escape') this.renaming = null;
    if (e.key !== 'Enter') return;
    const name = (e.target as HTMLInputElement).value.trim();
    this.renaming = null;
    if (name && name !== this.budget.envelopes[id]?.name) {
      void this.save((doc) => withEnvelope(doc, id, (env) => ({ ...env, name })));
    }
  }

  private close(id: EnvelopeId, e: Envelope, avail: Amount) {
    const funds = pairedTo(this.budget, id);
    if (funds.length > 0) {
      const names = funds.map((a) => accountLabel(this.chart, a)).join(', ');
      this.error = `${e.name} is still spent from by ${names}. Choose another envelope for them first.`;
      return;
    }
    if (!isZero(avail)) {
      const ok = confirm(
        `${e.name} still has ${formatAmount(avail)} ${avail.cur}. Closing it leaves that there. Allocate it away first to return it to the budget. Close anyway?`,
      );
      if (!ok) return;
    }
    const closed_at = today();
    void this.save((doc) => withEnvelope(doc, id, (env) => ({ ...env, closed_at })));
  }

  private reopen(id: EnvelopeId) {
    void this.save((doc) =>
      withEnvelope(doc, id, (env) => {
        const { closed_at: _, ...open } = env;
        return open;
      }),
    );
  }

  /** Re-pairs `account`, after saying how much past spending moves with it. */
  private pair(account: AccountId, e: Event) {
    const select = e.target as HTMLSelectElement;
    const env = (select.value || null) as EnvelopeId | null;
    const before = this.budget.spent_from[account] as EnvelopeId | undefined;
    if ((before ?? null) === env) return;
    const chart = this.chart;
    const spent = balanceOf(this.balances, account, chart.get(account)!.cur as Commodity);
    if (!isZero(spent)) {
      const name = (id: EnvelopeId | null | undefined) => (id ? `“${this.budget.envelopes[id]?.name ?? id}”` : 'no envelope');
      const ok = confirm(
        `${accountLabel(chart, account)} has ${formatAmount(spent)} ${spent.cur} of spending, including past months. ` +
          `All of it will count against ${name(env)} instead of ${name(before)}. Continue?`,
      );
      if (!ok) {
        select.value = before ?? '';
        return;
      }
    }
    void this.save((doc) => withPairing(doc, account, env)).then((ok) => {
      if (!ok) select.value = before ?? '';
    });
  }

  private startAllocating(envelope: EnvelopeId) {
    this.posted = '';
    this.error = '';
    this.allocating = { envelope, amount: '', date: today(), memo: '' };
  }

  private async allocate(e: Event) {
    e.preventDefault();
    const input = this.allocating;
    if (!input) return;
    const env = this.budget.envelopes[input.envelope];
    this.error = '';
    this.posted = '';
    try {
      if (!env) throw new Error('That envelope is no longer in the budget.');
      const amount = amountOf(input.amount, minor(env.cur), 'Amount');
      if (!amount || isZero(amount)) throw new ParseError('Amount: enter an amount other than zero');
      if (!isIsoDate(input.date)) throw new ParseError('Date: enter a date');
      const memo = input.memo.trim();
      this.busy = true;
      await this.ledger.postAllocation({
        v: 1, date: input.date, envelope: input.envelope, amount: amount.amount, exp: amount.exp, cur: env.cur,
        ...(memo && { memo }),
      });
      this.allocating = null;
      this.posted = `Allocated ${formatAmount({ ...amount, cur: env.cur })} ${env.cur} to ${env.name}.`;
    } catch (err) {
      this.error = errorMessage(err);
    } finally {
      this.busy = false;
    }
  }

  /** Applies `edit` to the latest budget document in the space, and shows the result. */
  private async save(edit: (doc: BudgetDoc) => BudgetDoc): Promise<boolean> {
    this.busy = true;
    this.error = '';
    this.posted = '';
    try {
      this.budget = await this.ledger.updateBudget(edit);
      return true;
    } catch (err) {
      this.error = errorMessage(err);
      return false;
    } finally {
      this.busy = false;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'budget-view': BudgetView;
  }
}
