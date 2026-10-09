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
 * Each envelope may have a monthly schedule (0025): steps that each set the allocation from
 * a month on. Saving a step posts the allocations it calls for, as opening the books does
 * (`LedgerSpace.materializeSchedule`), back to the step's month if it is in the past.
 *
 * Which asset and liability accounts are budgetable is in the document too (0026). To Be
 * Budgeted is their balance less what every envelope has available, per commodity: money
 * held that no envelope claims yet. Moving money between envelopes posts one
 * `ledger.reallocation`, so a move is never half done, and leaves To Be Budgeted as it is.
 *
 * Most envelopes fund one expense account of the same name (0050). Each expense account
 * has a "Budget this" checkbox that creates or removes that pairing (`setBudgetThis`), and
 * such an envelope shows as its account: renaming it renames both.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { isCommodity, isZero, minor, type Amount, type Commodity } from '@/core/amount.js';
import {
  budgetRefProblems, EMPTY_BUDGET, moveBetween, pairedTo, soleAccount, withBudgetable, withEnvelope, withPairing,
} from '@/core/budget.js';
import { accountLabel, accountPath, chartOf, type Chart } from '@/core/chart.js';
import { ParseError } from '@/core/errors.js';
import { balanceOf, type Balances } from '@/core/fold/ledger.js';
import { isIsoDate, isMonth, monthOf, newEnvelopeId, type AccountId, type EnvelopeId, type Month } from '@/core/ids.js';
import type { AccountsDoc, BudgetDoc, Envelope, ScheduleStep } from '@/core/messages.js';
import { nextMonth, stepAt, withSchedule, withStep, withoutStep } from '@/core/schedule.js';
import type { ProjectionClient } from '@/projection/client.js';
import type { LedgerSpace } from '@/services/ledger-space.js';
import { isBudgeted, setBudgetThis } from './budget-this.js';
import { today } from './dates.js';
import { amountOf, comparePaths, errorMessage, formatAmount } from './forms.js';
import { viewStyles } from './view-styles.js';

interface StepInput {
  envelope: EnvelopeId;
  from: string;
  amount: string;
}

interface MoveInput {
  from: EnvelopeId;
  to: EnvelopeId | '';
  amount: string;
  date: string;
  memo: string;
}

interface AllocationInput {
  envelope: EnvelopeId;
  amount: string;
  date: string;
  memo: string;
}

/** How many months from `from` through `through`, inclusive. */
function monthsBetween(from: Month, through: Month): number {
  let n = 0;
  for (let m = from; m <= through; m = nextMonth(m)) n++;
  return n;
}

/** The envelopes by name, open ones only unless `showClosed`. */
function envelopesOf(doc: BudgetDoc, showClosed: boolean): [EnvelopeId, Envelope][] {
  return (Object.entries(doc.envelopes) as [EnvelopeId, Envelope][])
    .filter(([, e]) => showClosed || e.closed_at === undefined)
    .sort((x, y) => x[1].name.localeCompare(y[1].name));
}

/** The asset and liability accounts that can be budgetable, plus closed ones that are, by path. */
function holdingAccounts(chart: Chart, doc: BudgetDoc): { id: AccountId; path: string[] }[] {
  return [...chart]
    .filter(([id, a]) =>
      (a.type === 'asset' || a.type === 'liability') && (a.closed_at === undefined || doc.budgetable.includes(id)))
    .map(([id]) => ({ id, path: accountPath(chart, id) }))
    .sort((x, y) => comparePaths(x.path, y.path));
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

      .tbb {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
        background-color: var(--color-bg-elevated);
        border-radius: var(--radius-md);
        margin-bottom: var(--spacing-lg);
      }

      .tbb .figure {
        font-size: var(--font-size-lg);
      }

      form.allocate input[name='memo'] {
        flex: 1 1 120px;
      }

      .schedule {
        margin: var(--spacing-xs) 0 var(--spacing-sm);
      }

      .schedule li {
        padding: 0 var(--spacing-sm);
      }
    `,
  ];

  @property({ attribute: false }) ledger!: LedgerSpace;
  @property({ attribute: false }) projection!: ProjectionClient;
  @property({ attribute: false }) doc!: AccountsDoc;

  @state() private budget: BudgetDoc = EMPTY_BUDGET;
  @state() private available = new Map<EnvelopeId, Amount>();
  @state() private balances: Balances = new Map();
  @state() private tbb = new Map<Commodity, Amount>();
  @state() private showClosed = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private posted = '';
  @state() private renaming: EnvelopeId | null = null;
  @state() private allocating: AllocationInput | null = null;
  @state() private moving: MoveInput | null = null;
  @state() private scheduling: StepInput | null = null;

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
      const [doc, available, balances, tbb] = await Promise.all([
        this.projection.call('doc', 'ledger/budget') as Promise<BudgetDoc | undefined>,
        this.projection.call('available'),
        this.projection.call('balances'),
        this.projection.call('toBeBudgeted'),
      ]);
      // A document just written here may not have synced back yet.
      if (doc && doc.rev >= this.budget.rev) this.budget = doc;
      this.available = available;
      this.balances = balances;
      this.tbb = tbb;
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

      ${this.renderToBeBudgeted()}

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
      ${this.renderBudgetable(chart)}

      <p class="meta">Revision ${this.budget.rev}</p>
    `;
  }

  private renderEnvelope(chart: Chart, id: EnvelopeId, e: Envelope) {
    const closed = e.closed_at !== undefined;
    const avail = this.available.get(id) ?? { amount: 0n, exp: 0, cur: e.cur };
    const funds = pairedTo(this.budget, id).map((a) => accountLabel(chart, a)).sort();
    const sole = soleAccount(this.budget, chart, id);
    return html`
      <li class=${closed ? 'closed' : ''}>
        <div class="row">
          ${this.renaming === id
            ? html`<input class="name" .value=${e.name} autofocus
                @keydown=${(ev: KeyboardEvent) => this.renameKey(ev, id, sole)}
                @blur=${() => (this.renaming = null)} />`
            : html`<span class="name">${e.name}</span>`}
          ${closed ? html`<span class="meta">closed ${e.closed_at}</span>` : nothing}
          <span class="num ${avail.amount < 0n ? 'negative' : ''}" title="Available">${formatAmount(avail)}</span>
          <span class="cur">${e.cur}</span>
          <span class="actions">
            ${closed
              ? nothing
              : html`<button type="button" ?disabled=${this.busy} @click=${() => this.startAllocating(id)}>Allocate</button>
                  <button type="button" ?disabled=${this.busy} @click=${() => this.startMoving(id)}>Move</button>
                  <button type="button" ?disabled=${this.busy} @click=${() => this.startScheduling(id)}>Schedule</button>`}
            <button type="button" ?disabled=${this.busy} @click=${() => (this.renaming = id)}>Rename</button>
            ${closed
              ? html`<button type="button" ?disabled=${this.busy} @click=${() => this.reopen(id)}>Reopen</button>`
              : html`<button type="button" ?disabled=${this.busy} @click=${() => this.close(id, e, avail)}>Close</button>`}
          </span>
        </div>
        <div class="hint">
          ${sole
            ? `Envelope and expense account${accountPath(chart, sole).length > 1 ? ` ${accountLabel(chart, sole)}` : ''}.`
            : funds.length > 0 ? `Spent from by ${funds.join(', ')}` : 'No expense accounts spend from it.'}
          ${this.scheduleSummary(e)}
        </div>
        ${this.allocating?.envelope === id ? this.renderAllocate(this.allocating) : nothing}
        ${this.moving?.from === id ? this.renderMove(e, this.moving) : nothing}
        ${this.scheduling?.envelope === id ? this.renderSchedule(e, this.scheduling) : nothing}
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

  /** To Be Budgeted per commodity: money in budgetable accounts that no envelope holds. */
  private renderToBeBudgeted() {
    if (this.budget.budgetable.length === 0) {
      return html`<div class="tbb hint">
        No accounts count toward To Be Budgeted yet. Choose the accounts your spending money is in, under
        Budgetable accounts below.
      </div>`;
    }
    const figures = [...this.tbb.values()].sort((x, y) => x.cur.localeCompare(y.cur));
    return html`
      <div class="tbb" title="Budgetable balances, less what every envelope has available">
        <span>To Be Budgeted</span>
        ${figures.map((a) => html`<span class="figure">
          <span class="num ${a.amount < 0n ? 'negative' : ''}">${formatAmount(a)}</span>
          <span class="cur">${a.cur}</span>
        </span>`)}
        ${figures.some((a) => a.amount < 0n)
          ? html`<span class="hint">Below zero, the envelopes hold more than the budgetable accounts do. Take some
              back from an envelope with a negative allocation.</span>`
          : nothing}
      </div>
    `;
  }

  private renderMove(e: Envelope, input: MoveInput) {
    const set = (field: 'to' | 'amount' | 'date' | 'memo') => (ev: Event) => {
      this.moving = { ...input, [field]: (ev.target as HTMLInputElement | HTMLSelectElement).value };
    };
    const targets = envelopesOf(this.budget, false).filter(([id, x]) => id !== input.from && x.cur === e.cur);
    if (targets.length === 0) {
      return html`<div class="hint">
        There is no other open ${e.cur} envelope to move money to.
        <button class="link" type="button" @click=${() => (this.moving = null)}>Cancel</button>
      </div>`;
    }
    return html`
      <form class="allocate" @submit=${this.move}>
        <input name="amount" .value=${input.amount} @input=${set('amount')} placeholder="Amount" required
          autocomplete="off" autofocus />
        <label>to
          <select name="to" required @change=${set('to')}>
            <option value="" ?selected=${input.to === ''}>Choose an envelope</option>
            ${targets.map(([id, x]) => html`<option value=${id} ?selected=${id === input.to}>${x.name}</option>`)}
          </select>
        </label>
        <input name="date" type="date" .value=${input.date} @input=${set('date')} required />
        <input name="memo" .value=${input.memo} @input=${set('memo')} placeholder="Memo (optional)" autocomplete="off" />
        <button class="primary" type="submit" ?disabled=${this.busy}>Move</button>
        <button class="link" type="button" @click=${() => (this.moving = null)}>Cancel</button>
      </form>
    `;
  }

  /** The monthly allocation in effect this month, and the next change, if any. */
  private scheduleSummary(e: Envelope) {
    if (!e.schedule || e.closed_at !== undefined) return nothing;
    const month = monthOf(today());
    const now = stepAt(e.schedule, month);
    const upcoming = e.schedule.find((s) => s.from > month);
    const parts: string[] = [];
    if (now && now.amount !== 0n) parts.push(`${formatAmount({ ...now, cur: e.cur })} a month`);
    if (upcoming) parts.push(`${formatAmount({ ...upcoming, cur: e.cur })} a month from ${upcoming.from}`);
    return parts.length > 0 ? html` · Scheduled ${parts.join(', then ')}.` : nothing;
  }

  private renderSchedule(e: Envelope, input: StepInput) {
    const set = (field: 'from' | 'amount') => (ev: Event) => {
      this.scheduling = { ...input, [field]: (ev.target as HTMLInputElement).value };
    };
    const steps = e.schedule ?? [];
    return html`
      <div class="schedule">
        ${steps.length === 0
          ? html`<div class="hint">No schedule. Each step sets the monthly allocation from its month on.</div>`
          : html`<ul>${steps.map((s) => html`<li class="row">
              <span class="name">From ${s.from}: ${s.amount === 0n ? 'nothing' : `${formatAmount({ ...s, cur: e.cur })} a month`}</span>
              <span class="actions">
                <button type="button" ?disabled=${this.busy} @click=${() => this.removeStep(input.envelope, s)}>Remove</button>
              </span>
            </li>`)}</ul>`}
        <form class="allocate" @submit=${this.addStep}>
          <input name="from" type="month" .value=${input.from} @input=${set('from')} required title="First month" />
          <input name="amount" .value=${input.amount} @input=${set('amount')} placeholder="Monthly amount" required
            autocomplete="off" autofocus title="Zero stops allocating from that month" />
          <button class="primary" type="submit" ?disabled=${this.busy}>Set</button>
          <button class="link" type="button" @click=${() => (this.scheduling = null)}>Done</button>
        </form>
        <div class="hint">
          A month already allocated by the schedule keeps what it got. A change applies to months not yet allocated.
        </div>
      </div>
    `;
  }

  private renderPairings(chart: Chart) {
    const accounts = expenseAccounts(chart, this.budget);
    const open = envelopesOf(this.budget, false);
    return html`
      <section>
        <h3>Spending</h3>
        <p class="note intro">
          Which envelope each expense account is spent from. Budget this gives an account an envelope of its own name.
        </p>
        ${accounts.length === 0
          ? html`<div class="empty">No expense accounts yet. Add them in Accounts.</div>`
          : html`<div class="scroll"><table>
              <thead><tr><th>Expense account</th><th>Budget this</th><th>Spent from</th></tr></thead>
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
                      <input type="checkbox" .checked=${isBudgeted(this.budget, id)} ?disabled=${this.busy}
                        aria-label=${`Budget ${path.join(' › ')}`}
                        @change=${(ev: Event) => this.budgetThis(id, ev)} />
                    </td>
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

  private renderBudgetable(chart: Chart) {
    const accounts = holdingAccounts(chart, this.budget);
    return html`
      <section>
        <h3>Budgetable accounts</h3>
        <p class="note intro">
          The accounts whose money you budget, usually checking, savings you spend from, and credit cards. Their
          balances, less what the envelopes hold, are To Be Budgeted. A card's balance owed counts against it, so
          spending on the card from an envelope leaves To Be Budgeted as it is.
        </p>
        ${accounts.length === 0
          ? html`<div class="empty">No asset or liability accounts yet. Add them in Accounts.</div>`
          : html`<div class="scroll"><table>
              <thead><tr><th>Account</th><th class="num">Balance</th><th>Budgetable</th></tr></thead>
              <tbody>
                ${accounts.map(({ id, path }) => {
                  const a = chart.get(id)!;
                  const on = this.budget.budgetable.includes(id);
                  const bal = balanceOf(this.balances, id, a.cur);
                  return html`<tr>
                    <td>${path.join(' › ')}${a.closed_at !== undefined ? html` <span class="meta">closed</span>` : nothing}</td>
                    <td class="num ${bal.amount < 0n ? 'negative' : ''}" title="As it counts toward To Be Budgeted">
                      ${formatAmount(bal)} <span class="cur">${a.cur}</span>
                    </td>
                    <td>
                      <input type="checkbox" .checked=${on} ?disabled=${this.busy}
                        aria-label=${`${path.join(' › ')} is budgetable`}
                        @change=${(ev: Event) => this.setBudgetable(id, ev)} />
                    </td>
                  </tr>`;
                })}
              </tbody>
            </table></div>`}
      </section>
    `;
  }

  private setBudgetable(account: AccountId, e: Event) {
    const box = e.target as HTMLInputElement;
    const on = box.checked;
    void this.save((doc) => withBudgetable(doc, account, on)).then((ok) => {
      if (!ok) box.checked = !on;
    });
  }

  private async budgetThis(account: AccountId, e: Event) {
    const box = e.target as HTMLInputElement;
    const on = box.checked;
    this.busy = true;
    this.error = '';
    this.posted = '';
    try {
      const doc = await setBudgetThis(this.ledger, this.projection, this.chart, this.budget, account, on);
      if (doc) this.budget = doc;
      else box.checked = !on;
    } catch (err) {
      box.checked = !on;
      this.error = errorMessage(err);
    } finally {
      this.busy = false;
    }
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

  /** Renames envelope `id`, and `account` with it if the two show as one. */
  private async renameKey(e: KeyboardEvent, id: EnvelopeId, account: AccountId | undefined) {
    if (e.key === 'Escape') this.renaming = null;
    if (e.key !== 'Enter') return;
    const name = (e.target as HTMLInputElement).value.trim();
    this.renaming = null;
    if (!name || name === this.budget.envelopes[id]?.name) return;
    if (!(await this.save((doc) => withEnvelope(doc, id, (env) => ({ ...env, name }))))) return;
    if (account) await this.renameAccount(account, name);
  }

  private async renameAccount(id: AccountId, name: string) {
    this.busy = true;
    try {
      const doc = await this.ledger.updateAccounts((d) => {
        const a = d.accounts[id];
        if (!a) throw new Error('That account is no longer in the chart.');
        return a.name === name ? d : { ...d, accounts: { ...d.accounts, [id]: { ...a, name } } };
      });
      this.dispatchEvent(new CustomEvent<AccountsDoc>('accounts-changed', { detail: doc, bubbles: true }));
    } catch (err) {
      this.error = `The envelope was renamed, but its expense account wasn't: ${errorMessage(err)}`;
    } finally {
      this.busy = false;
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
    this.scheduling = null;
    this.moving = null;
    this.allocating = { envelope, amount: '', date: today(), memo: '' };
  }

  private startMoving(from: EnvelopeId) {
    this.posted = '';
    this.error = '';
    this.allocating = null;
    this.scheduling = null;
    this.moving = { from, to: '', amount: '', date: today(), memo: '' };
  }

  private startScheduling(envelope: EnvelopeId) {
    this.posted = '';
    this.error = '';
    this.allocating = null;
    this.moving = null;
    this.scheduling = { envelope, from: monthOf(today()), amount: '' };
  }

  private async addStep(e: Event) {
    e.preventDefault();
    const input = this.scheduling;
    if (!input) return;
    const env = this.budget.envelopes[input.envelope];
    this.error = '';
    this.posted = '';
    let step: ScheduleStep;
    try {
      if (!env) throw new Error('That envelope is no longer in the budget.');
      if (!isMonth(input.from)) throw new ParseError('From: enter a month');
      const amount = amountOf(input.amount, minor(env.cur), 'Amount');
      if (!amount || amount.amount < 0n) throw new ParseError('Amount: enter zero or more');
      step = { from: input.from, amount: amount.amount, exp: amount.exp };
    } catch (err) {
      this.error = errorMessage(err);
      return;
    }
    const month = monthOf(today());
    if (step.from < month && step.amount !== 0n) {
      const n = monthsBetween(step.from, month);
      const ok = confirm(
        `${step.from} is in the past. ${env.name} will be allocated ${formatAmount({ ...step, cur: env.cur })} ${env.cur} ` +
          `for each of the ${n} months from ${step.from} through ${month} that the schedule hasn't allocated yet. Continue?`,
      );
      if (!ok) return;
    }
    if (await this.save((doc) => withEnvelope(doc, input.envelope, (x) => withSchedule(x, withStep(x.schedule, step))))) {
      this.scheduling = { ...input, amount: '' };
      await this.materialize();
    }
  }

  private async removeStep(envelope: EnvelopeId, step: ScheduleStep) {
    if (await this.save((doc) => withEnvelope(doc, envelope, (x) => withSchedule(x, withoutStep(x.schedule, step.from))))) {
      await this.materialize();
    }
  }

  /** Posts what the schedule now calls for through this month, and says how much that was. */
  private async materialize() {
    this.busy = true;
    try {
      const n = await this.ledger.materializeSchedule(monthOf(today()));
      if (n > 0) this.posted = `Posted ${n} scheduled allocation${n === 1 ? '' : 's'}.`;
    } catch (err) {
      this.error = `The schedule was saved, but its allocations weren't posted: ${errorMessage(err)}`;
    } finally {
      this.busy = false;
    }
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

  private async move(e: Event) {
    e.preventDefault();
    const input = this.moving;
    if (!input) return;
    const from = this.budget.envelopes[input.from];
    const to = input.to ? this.budget.envelopes[input.to] : undefined;
    this.error = '';
    this.posted = '';
    try {
      if (!from || !input.to || !to) throw new ParseError('To: choose an envelope');
      const amount = amountOf(input.amount, minor(from.cur), 'Amount');
      if (!amount || amount.amount <= 0n) throw new ParseError('Amount: enter an amount greater than zero');
      if (!isIsoDate(input.date)) throw new ParseError('Date: enter a date');
      this.busy = true;
      await this.ledger.postReallocation(
        moveBetween(input.from, input.to, { ...amount, cur: from.cur }, input.date, input.memo.trim() || undefined),
      );
      this.moving = null;
      this.posted = `Moved ${formatAmount({ ...amount, cur: from.cur })} ${from.cur} from ${from.name} to ${to.name}.`;
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
