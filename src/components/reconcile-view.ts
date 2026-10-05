/**
 * Reconcile View
 *
 * Reconciles an asset or liability account against a bank or card statement (0018). Enter
 * the statement's date and closing balance, tick the transactions it shows, and when the
 * cleared balance equals the closing balance, post the whole statement as one
 * `ledger.recon`. Cleared status is derived from these, never stored per transaction.
 *
 * The checklist offers every entry and reversal on the account that no standing
 * reconciliation clears, one row per transaction with its net on the account. The latest
 * reconciliation can be redone: that posts a recon that supersedes it, starting from what
 * it cleared.
 *
 * The ticked list lives only in this view, so leaving the page drops it. Keeping it across
 * visits is 0019.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { minor, sub, type Amount, type Commodity } from '@/core/amount.js';
import { accountPath, chartOf, type Chart } from '@/core/chart.js';
import { periodEnd, previousMonth } from '@/core/close.js';
import { isIsoDate, type AccountId, type MsgId } from '@/core/ids.js';
import type { AccountsDoc, AccountType, PayeesDoc, Recon } from '@/core/messages.js';
import { payeeName } from '@/core/payees.js';
import { clearedBalance, lastRecon } from '@/core/recon.js';
import type { ProjectionClient } from '@/projection/client.js';
import type { Reconciliation, RegisterLine } from '@/projection/projection.js';
import type { LedgerSpace } from '@/services/ledger-space.js';
import { today } from './dates.js';
import { amountOf, comparePaths, errorMessage, formatAmount, shownAs } from './forms.js';

/** One transaction on the account that the statement may clear. */
interface Candidate {
  readonly txn: MsgId;
  readonly date: string;
  readonly payee: string;
  readonly memo?: string;
  readonly reversal: boolean;
  /** The transaction's net on the account. */
  readonly amount: Amount;
}

/** What the projection holds for the chosen account. */
interface Loaded {
  readonly account: AccountId;
  readonly lines: readonly RegisterLine[];
  readonly recons: readonly Reconciliation[];
  readonly held: ReadonlyMap<MsgId, Amount>;
  readonly payees: PayeesDoc | undefined;
}

/** Asset and liability accounts, closed ones included, sorted by path. */
function reconcilableAccounts(chart: Chart): { id: AccountId; label: string }[] {
  return [...chart]
    .filter(([, a]) => a.type === 'asset' || a.type === 'liability')
    .map(([id]) => ({ id, path: accountPath(chart, id) }))
    .sort((x, y) => comparePaths(x.path, y.path))
    .map(({ id, path }) => ({ id, label: path.join(' › ') }));
}

@customElement('reconcile-view')
export class ReconcileView extends LitElement {
  static styles = css`
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
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }

    .fields label {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .balance-input {
      width: 9em;
      text-align: right;
      font-family: var(--font-family-mono);
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

    tbody tr {
      cursor: pointer;
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
    .tag {
      color: var(--color-text-subdued);
    }

    .tag {
      font-size: var(--font-size-xs);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-left: var(--spacing-xs);
    }

    .negative {
      color: var(--color-negative);
    }

    .summary {
      display: grid;
      grid-template-columns: auto auto;
      justify-content: end;
      column-gap: var(--spacing-lg);
      row-gap: var(--spacing-xs);
      margin-bottom: var(--spacing-md);
    }

    .summary dt {
      color: var(--color-text-secondary);
    }

    .summary dd {
      margin: 0;
      text-align: right;
      font-family: var(--font-family-mono);
      font-variant-numeric: tabular-nums;
    }

    .summary .off {
      color: var(--color-warning);
    }

    .summary .even {
      color: var(--color-positive);
    }

    .buttons {
      display: flex;
      justify-content: flex-end;
      flex-wrap: wrap;
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

    .posted {
      color: var(--color-positive);
      margin-bottom: var(--spacing-md);
    }

    .hint {
      color: var(--color-text-subdued);
      font-size: var(--font-size-sm);
      font-family: var(--font-family-mono);
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

    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    li {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
    }

    li:hover {
      background-color: var(--color-bg-secondary);
    }

    li.superseded {
      color: var(--color-text-subdued);
    }

    li .date {
      min-width: 6em;
    }
  `;

  @property({ attribute: false }) ledger!: LedgerSpace;
  @property({ attribute: false }) projection!: ProjectionClient;
  @property({ attribute: false }) doc!: AccountsDoc;

  @state() private account: AccountId | null = null;
  @state() private loaded: Loaded | null = null;
  @state() private date: string = periodEnd(previousMonth(today()))!;
  @state() private balance = '';
  @state() private checked = new Set<MsgId>();
  /** The reconciliation being redone, if any. */
  @state() private supersedes: MsgId | null = null;
  @state() private busy = false;
  @state() private error = '';
  @state() private posted: { id: MsgId; date: string } | null = null;

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
    if (changed.has('account') || changed.has('projection')) void this.load();
  }

  private async load() {
    const generation = ++this.generation;
    const account = this.account;
    if (account === null) return;
    try {
      const [lines, recons, held, payees] = await Promise.all([
        this.projection.call('register', account, false),
        this.projection.call('reconciliations', account),
        this.projection.call('reconcilable', account),
        this.projection.call('doc', 'ledger/payees') as Promise<PayeesDoc | undefined>,
      ]);
      if (generation !== this.generation) return;
      this.loaded = { account, lines, recons, held, payees };
      // A redo whose target was superseded elsewhere meanwhile can't be posted.
      if (this.supersedes && recons.find((r) => r.id === this.supersedes)?.supersededBy) this.cancelRedo();
    } catch (err) {
      if (generation === this.generation) this.error = errorMessage(err);
    }
  }

  /** The transactions the statement may clear, in register order. */
  private candidates(l: Loaded): Candidate[] {
    const out: Candidate[] = [];
    const seen = new Set<MsgId>();
    for (const line of l.lines) {
      if (seen.has(line.txn) || line.kind === 'lotadjust') continue;
      if (line.reconciled !== undefined && line.reconciled !== this.supersedes) continue;
      const amount = l.held.get(line.txn);
      if (!amount) continue;
      seen.add(line.txn);
      out.push({
        txn: line.txn,
        date: line.date,
        payee: line.payee ? payeeName(l.payees, line.payee) : '',
        ...(line.memo !== undefined && { memo: line.memo }),
        reversal: line.kind === 'reversal',
        amount,
      });
    }
    return out;
  }

  render() {
    const chart = chartOf(this.doc);
    const options = reconcilableAccounts(chart);
    const account = this.account === null ? undefined : chart.get(this.account);
    return html`
      <div class="toolbar">
        <h2>Reconcile</h2>
        <select aria-label="Account" @change=${this.pick}>
          <option value="" ?selected=${!account} disabled>Choose an account</option>
          ${options.map((o) => html`<option value=${o.id} ?selected=${o.id === this.account}>${o.label}</option>`)}
        </select>
      </div>
      <p class="intro">
        Match an account against its statement. Tick each transaction the statement shows.
        When the cleared balance equals the statement's closing balance, finish to record
        the reconciliation.
      </p>

      ${this.posted
        ? html`<p class="posted" role="status">
            Reconciled to ${this.posted.date}.
            <span class="hint" title=${this.posted.id}>${this.posted.id.slice(0, 12)}…</span>
          </p>`
        : nothing}
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}

      ${options.length === 0
        ? html`<p class="empty">Add an asset or liability account to reconcile it.</p>`
        : account && this.loaded?.account === this.account
          ? this.renderSession(this.loaded, account.type, account.cur)
          : account
            ? html`<p class="empty">Loading…</p>`
            : html`<p class="empty">Choose an account to reconcile.</p>`}
    `;
  }

  private renderSession(l: Loaded, type: AccountType, cur: Commodity) {
    const zero: Amount = { amount: 0n, exp: minor(cur), cur };
    const candidates = this.candidates(l);
    const ctx = { recons: l.recons, postings: l.held };
    const supersedes = this.supersedes ?? undefined;
    const last = lastRecon(l.recons, supersedes);
    const cleared = clearedBalance(ctx, zero, this.checked, supersedes);
    let statement: Amount | undefined;
    let parseError = '';
    try {
      const d = amountOf(this.balance, minor(zero.cur), 'Closing balance');
      if (d) statement = shownAs(type, { ...d, cur: zero.cur });
    } catch (err) {
      parseError = errorMessage(err);
    }
    const difference = statement && sub(statement, cleared);
    const ready = isIsoDate(this.date) && difference !== undefined && difference.amount === 0n && !this.busy;
    const show = (a: Amount) => {
      const s = shownAs(type, a);
      return html`<span class=${s.amount < 0n ? 'negative' : ''}>${formatAmount(s)}</span>`;
    };

    return html`
      ${this.supersedes
        ? html`<p class="note">
            Redoing the reconciliation to ${l.recons.find((r) => r.id === this.supersedes)?.statementDate}. Finishing
            replaces it; until then it stands.
          </p>`
        : nothing}
      <p class="note">
        ${last
          ? html`Last reconciled to ${last.statementDate}, at ${show(l.recons.find((r) => r.id === last.id)!.closingBalance)} ${cur}.`
          : 'Never reconciled. The first statement starts from zero, so tick the opening balance too.'}
      </p>

      <div class="fields">
        <label>
          Statement date
          <input type="date" required .value=${this.date}
            @input=${(e: Event) => (this.date = (e.target as HTMLInputElement).value)} />
        </label>
        <label>
          Closing balance
          <input class="balance-input" inputmode="decimal" placeholder="0.00" .value=${this.balance}
            @input=${(e: Event) => (this.balance = (e.target as HTMLInputElement).value)} />
          ${cur}
        </label>
      </div>
      ${parseError ? html`<div class="error" role="alert">${parseError}</div>` : nothing}

      ${candidates.length === 0
        ? html`<p class="empty">Every transaction on this account is reconciled.</p>`
        : html`
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input type="checkbox" aria-label="Tick all"
                        .checked=${candidates.every((c) => this.checked.has(c.txn))}
                        @change=${(e: Event) => this.tickAll(candidates, (e.target as HTMLInputElement).checked)} />
                    </th>
                    <th>Date</th>
                    <th>Description</th>
                    <th class="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  ${candidates.map(
                    (c) => html`<tr @click=${(e: Event) => this.rowClick(e, c.txn)}>
                      <td>
                        <input type="checkbox" aria-label="Cleared" .checked=${this.checked.has(c.txn)}
                          @change=${() => this.toggle(c.txn)} />
                      </td>
                      <td class="date">${c.date}</td>
                      <td>
                        ${c.payee}${c.payee && c.memo ? html`<br />` : nothing}${c.memo ? html`<span class="memo">${c.memo}</span>` : nothing}
                        ${c.reversal ? html`<span class="tag">Reversal</span>` : nothing}
                      </td>
                      <td class="num">${show(c.amount)}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>
          `}

      <dl class="summary">
        <dt>Cleared balance</dt>
        <dd>${show(cleared)}</dd>
        <dt>Statement balance</dt>
        <dd>${statement ? show(statement) : '—'}</dd>
        <dt>Difference</dt>
        <dd class=${difference === undefined ? '' : difference.amount === 0n ? 'even' : 'off'}>
          ${difference ? show(difference) : '—'}
        </dd>
      </dl>

      <div class="buttons">
        ${this.supersedes ? html`<button class="link" type="button" @click=${this.cancelRedo}>Cancel redo</button>` : nothing}
        <button class="primary" type="button" ?disabled=${!ready} @click=${() => this.finish(l, statement!)}>
          Finish reconciling
        </button>
      </div>

      ${this.renderHistory(l, type, cur)}
    `;
  }

  private renderHistory(l: Loaded, type: AccountType, cur: string) {
    const last = lastRecon(l.recons);
    return html`
      <section>
        <h3>Reconciliations</h3>
        ${l.recons.length === 0
          ? html`<p class="empty">This account has not been reconciled yet.</p>`
          : html`<ul>
              ${l.recons.slice().reverse().map((r) => {
                const missing = r.cleared.length - r.held;
                return html`<li class=${r.supersededBy ? 'superseded' : ''}>
                  <span class="date">${r.statementDate}</span>
                  <span>${formatAmount(shownAs(type, r.closingBalance))} ${cur}</span>
                  <span class="tag">${r.cleared.length} ${r.cleared.length === 1 ? 'transaction' : 'transactions'}</span>
                  ${r.supersededBy ? html`<span class="tag">Superseded</span>` : nothing}
                  ${missing > 0 ? html`<span class="tag">${missing} not synced</span>` : nothing}
                  <span class="hint" title=${r.id}>${r.id.slice(0, 12)}…</span>
                  ${r.id === last?.id && !this.supersedes
                    ? html`<button class="link" type="button" @click=${() => this.redo(r, type)}>Redo</button>`
                    : nothing}
                </li>`;
              })}
            </ul>`}
      </section>
    `;
  }

  private pick(e: Event) {
    this.account = (e.target as HTMLSelectElement).value as AccountId;
    this.loaded = null;
    this.checked = new Set();
    this.supersedes = null;
    this.balance = '';
    this.error = '';
    this.posted = null;
  }

  private toggle(txn: MsgId) {
    const next = new Set(this.checked);
    if (!next.delete(txn)) next.add(txn);
    this.checked = next;
  }

  /** A click anywhere on a row toggles it, except on the checkbox, which toggles itself. */
  private rowClick(e: Event, txn: MsgId) {
    if ((e.target as HTMLElement).tagName !== 'INPUT') this.toggle(txn);
  }

  private tickAll(candidates: readonly Candidate[], on: boolean) {
    const next = new Set(this.checked);
    for (const c of candidates) {
      if (on) next.add(c.txn);
      else next.delete(c.txn);
    }
    this.checked = next;
  }

  /** Starts over from the latest reconciliation, to replace it. */
  private redo(r: Reconciliation, type: AccountType) {
    this.supersedes = r.id;
    this.date = r.statementDate;
    this.balance = formatAmount(shownAs(type, r.closingBalance));
    this.checked = new Set(r.cleared);
    this.error = '';
    this.posted = null;
  }

  private readonly cancelRedo = () => {
    this.supersedes = null;
    this.checked = new Set();
    this.balance = '';
    this.date = periodEnd(previousMonth(today()))!;
  };

  private async finish(l: Loaded, statement: Amount) {
    if (!isIsoDate(this.date)) return;
    // Only what is still offered: a transaction ticked and then cleared elsewhere drops out.
    const offered = new Set(this.candidates(l).map((c) => c.txn));
    const recon: Recon = {
      v: 1,
      account: l.account,
      statement_date: this.date,
      closing_balance: statement,
      cleared: [...this.checked].filter((t) => offered.has(t)),
      ...(this.supersedes && { supersedes: this.supersedes }),
    };
    this.busy = true;
    this.error = '';
    this.posted = null;
    try {
      const id = await this.ledger.postRecon(recon, { recons: l.recons, postings: l.held });
      this.posted = { id, date: this.date };
      this.checked = new Set();
      this.supersedes = null;
      this.balance = '';
    } catch (err) {
      this.error = errorMessage(err);
    } finally {
      this.busy = false;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'reconcile-view': ReconcileView;
  }
}
