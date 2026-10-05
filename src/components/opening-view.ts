/**
 * Opening Balances View
 *
 * Enter each asset and liability account's balance on the day the books start, and post
 * them as one `ledger.entry` (0009). An investment account can take lots instead, each
 * with its real acquisition date and total cost. Each commodity is balanced against an
 * open equity account named "Opening Balances" in that commodity, which is added to the
 * chart first if it isn't there.
 *
 * An account that a standing opening entry already opened is marked, and posting it again
 * needs a second confirmation (0035). An opening entry has no flag: it is any entry that
 * posts to an "Opening Balances" equity account, and that hasn't been reversed.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { canonical, isCommodity, minor, type Commodity } from '@/core/amount.js';
import { accountLabel, accountPath, chartOf, type Chart } from '@/core/chart.js';
import { ParseError } from '@/core/errors.js';
import { isIsoDate, newAccountId, yearOf, type AccountId, type IsoDate, type MsgId } from '@/core/ids.js';
import type { Account, AccountsDoc, Entry } from '@/core/messages.js';
import {
  findOpeningEquity, openingCommodities, openingEntry, openingEquityAccount, openingEquityAccounts,
  type OpeningLine, type OpeningLot,
} from '@/core/opening.js';
import type { ProjectionClient } from '@/projection/client.js';
import type { Opening } from '@/projection/projection.js';
import { InvalidEntryError, type LedgerSpace } from '@/services/ledger-space.js';
import { today } from './dates.js';
import { amountOf, comparePaths, errorMessage } from './forms.js';

interface LotInput {
  qty: string;
  cost: string;
  costCur: string;
  acquired: string;
}

const emptyLot = (): LotInput => ({ qty: '', cost: '', costCur: 'USD', acquired: '' });

interface Row {
  id: AccountId;
  account: Account;
  /** Names from the top-level ancestor down, so "Vanguard › VTI" and "Fidelity › VTI" differ. */
  path: string[];
}

/** Open accounts of `type`, sorted by path so children follow their parents. */
function rowsOf(doc: AccountsDoc, type: 'asset' | 'liability'): Row[] {
  const chart = chartOf(doc);
  return [...chart]
    .filter(([, a]) => a.type === type && a.closed_at === undefined)
    .map(([id, account]) => ({ id, account, path: accountPath(chart, id) }))
    .sort((x, y) => comparePaths(x.path, y.path));
}

/**
 * `doc` plus an Opening Balances equity account for each commodity still without one.
 * Pure, so it can run again on a fresher chart.
 */
function withEquity(doc: AccountsDoc, missing: readonly (readonly [Commodity, AccountId])[]): AccountsDoc {
  const chart = chartOf(doc);
  const added = missing.filter(([c]) => !findOpeningEquity(chart, c)).map(([c, id]) => [id, openingEquityAccount(c)]);
  return added.length === 0 ? doc : { ...doc, accounts: { ...doc.accounts, ...Object.fromEntries(added) } };
}

/** The opening entry on `doc`'s chart, or an `InvalidEntryError`. */
function build(date: IsoDate, lines: OpeningLine[], doc: AccountsDoc): Entry {
  const chart = chartOf(doc);
  const equity = new Map<Commodity, AccountId>();
  for (const c of openingCommodities(date, lines, chart)) {
    const id = findOpeningEquity(chart, c);
    if (id) equity.set(c, id);
  }
  const result = openingEntry({ date, lines, equity }, chart);
  if (result.problems) throw new InvalidEntryError(result.problems);
  return result.entry;
}

@customElement('opening-view')
export class OpeningView extends LitElement {
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

    input {
      font: inherit;
      padding: var(--spacing-xs) var(--spacing-sm);
      background-color: var(--color-bg-highlight);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--color-text-primary);
      outline: none;
      min-width: 0;
    }

    input:focus {
      border-color: var(--color-accent);
    }

    .intro {
      color: var(--color-text-secondary);
      margin: var(--spacing-sm) 0 var(--spacing-md);
    }

    .date {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-lg);
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

    .row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
    }

    .row:hover {
      background-color: var(--color-bg-secondary);
    }

    .name {
      flex: 1 1 140px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .amount {
      width: 10em;
      text-align: right;
      font-family: var(--font-family-mono);
    }

    .parent {
      color: var(--color-text-subdued);
    }

    .cur,
    .hint {
      color: var(--color-text-subdued);
      font-size: var(--font-size-sm);
      font-family: var(--font-family-mono);
    }

    .cur {
      width: 4.5em;
    }

    .link {
      color: var(--color-text-secondary);
      font-size: var(--font-size-sm);
    }

    .link:hover {
      color: var(--color-accent);
    }

    .lots {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      padding: 0 var(--spacing-sm) var(--spacing-sm) var(--spacing-xl);
    }

    .lot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-xs);
    }

    .lot .qty {
      width: 7em;
      text-align: right;
      font-family: var(--font-family-mono);
    }

    .lot .cost {
      width: 9em;
      text-align: right;
      font-family: var(--font-family-mono);
    }

    .lot .cost-cur {
      width: 5em;
      text-transform: uppercase;
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

    .opened {
      color: var(--color-text-subdued);
      font-size: var(--font-size-sm);
    }

    .posted {
      color: var(--color-positive);
      margin-bottom: var(--spacing-md);
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
  `;

  @property({ attribute: false }) ledger!: LedgerSpace;
  @property({ attribute: false }) projection!: ProjectionClient;
  @property({ attribute: false }) doc!: AccountsDoc;

  @state() private date: string = today();
  @state() private balances: Record<AccountId, string> = {};
  /** Accounts entered as lots instead of a balance. */
  @state() private lots: Record<AccountId, LotInput[]> = {};
  @state() private busy = false;
  @state() private error = '';
  @state() private posted: { id: MsgId; date: IsoDate } | null = null;
  /** The accounts standing opening entries already open, earliest first. */
  @state() private openings: Opening[] = [];

  /** Counts queries, so a slow answer for an older chart is dropped. */
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
    if (changed.has('projection') || changed.has('doc')) void this.load();
  }

  private async load() {
    const generation = ++this.generation;
    try {
      const openings = await this.projection.call('openings', openingEquityAccounts(chartOf(this.doc)));
      if (generation === this.generation) this.openings = openings;
    } catch (err) {
      if (generation === this.generation) this.error = errorMessage(err);
    }
  }

  /** The first opening entry date of each account that has one. */
  private openedOn(openings: readonly Opening[]): Map<AccountId, IsoDate> {
    const out = new Map<AccountId, IsoDate>();
    for (const o of openings) if (!out.has(o.account)) out.set(o.account, o.date);
    return out;
  }

  render() {
    const assets = rowsOf(this.doc, 'asset');
    const liabilities = rowsOf(this.doc, 'liability');
    const opened = this.openedOn(this.openings);
    return html`
      <h2>Opening balances</h2>
      <p class="intro">
        Enter what each account held, or owed, at the start of the day you begin these
        books. Leave an account blank if it was zero. Each commodity is balanced against an
        Opening Balances equity account. Post this once: entries are permanent, and a
        mistake is fixed by reversing it.
      </p>

      ${this.posted
        ? html`<p class="posted" role="status">
            Posted opening balances for ${this.posted.date}.
            <span class="hint" title=${this.posted.id}>${this.posted.id.slice(0, 12)}…</span>
          </p>`
        : nothing}
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}

      <label class="date">
        Opening date
        <input type="date" required .value=${this.date}
          @input=${(e: Event) => (this.date = (e.target as HTMLInputElement).value)} />
      </label>

      ${opened.size > 0
        ? html`<p class="warning">
            Opening balances have already been posted for ${opened.size === 1 ? 'one account' : `${opened.size} accounts`},
            marked below. Posting them again counts those balances twice; to correct one,
            reverse its opening entry in the register instead.
          </p>`
        : nothing}

      ${this.renderSection('Assets', assets, true, opened)}
      ${this.renderSection('Liabilities, amount owed', liabilities, false, opened)}

      <button class="primary" type="button" ?disabled=${this.busy || assets.length + liabilities.length === 0}
        @click=${this.post}>Post opening balances</button>
    `;
  }

  private renderSection(title: string, rows: Row[], lotsAllowed: boolean, opened: ReadonlyMap<AccountId, IsoDate>) {
    return html`
      <section>
        <h3>${title}</h3>
        ${rows.length === 0
          ? html`<div class="empty">No open accounts. Add them under Accounts.</div>`
          : rows.map((r) => this.renderAccount(r, lotsAllowed, opened.get(r.id)))}
      </section>
    `;
  }

  private renderAccount({ id, account: a, path }: Row, lotsAllowed: boolean, openedOn: IsoDate | undefined) {
    const lots = this.lots[id];
    const label = path.join(' › ');
    return html`
      <div class="row">
        <span class="name" title=${label}>${path.slice(0, -1).map(
          (p) => html`<span class="parent">${p} › </span>`,
        )}${a.name}</span>
        ${openedOn ? html`<span class="opened">opened ${openedOn}</span>` : nothing}
        ${lots
          ? html`<button class="link" type="button" @click=${() => this.setLots(id, undefined)}>Enter a balance</button>`
          : html`
              ${lotsAllowed
                ? html`<button class="link" type="button" @click=${() => this.setLots(id, [emptyLot()])}>Enter lots</button>`
                : nothing}
              <input class="amount" inputmode="decimal" placeholder="0" .value=${this.balances[id] ?? ''}
                aria-label=${`${label} balance`}
                @input=${(e: Event) => (this.balances = { ...this.balances, [id]: (e.target as HTMLInputElement).value })} />
            `}
        <span class="cur">${a.cur}</span>
      </div>
      ${lots ? this.renderLots(id, a, label, lots) : nothing}
    `;
  }

  private renderLots(id: AccountId, a: Account, label: string, lots: LotInput[]) {
    const edit = (i: number, field: keyof LotInput) => (e: Event) =>
      this.setLots(id, lots.map((l, j) => (j === i ? { ...l, [field]: (e.target as HTMLInputElement).value } : l)));
    return html`
      <div class="lots">
        ${lots.map(
          (l, i) => html`
            <div class="lot">
              <input class="qty" inputmode="decimal" placeholder="Quantity" .value=${l.qty}
                aria-label=${`${label} lot ${i + 1} quantity of ${a.cur}`} @input=${edit(i, 'qty')} />
              <span class="hint">${a.cur} cost</span>
              <input class="cost" inputmode="decimal" placeholder="Total cost" .value=${l.cost}
                aria-label=${`${label} lot ${i + 1} total cost`} @input=${edit(i, 'cost')} />
              <input class="cost-cur" .value=${l.costCur} aria-label=${`${label} lot ${i + 1} cost commodity`}
                @input=${edit(i, 'costCur')} />
              <span class="hint">acquired</span>
              <input type="date" .value=${l.acquired} aria-label=${`${label} lot ${i + 1} acquisition date`}
                @input=${edit(i, 'acquired')} />
              <button class="link" type="button"
                @click=${() => this.setLots(id, lots.length > 1 ? lots.filter((_, j) => j !== i) : undefined)}>
                Remove
              </button>
            </div>
          `,
        )}
        <div><button class="link" type="button" @click=${() => this.setLots(id, [...lots, emptyLot()])}>Add a lot</button></div>
      </div>
    `;
  }

  private setLots(id: AccountId, lots: LotInput[] | undefined) {
    const { [id]: _, ...rest } = this.lots;
    this.lots = lots ? { ...rest, [id]: lots } : rest;
  }

  /** The typed balances and lots as opening lines. Throws a `ParseError` naming the field. */
  private lines(chart: Chart): OpeningLine[] {
    const lines: OpeningLine[] = [];
    for (const [id, a] of chart) {
      if ((a.type !== 'asset' && a.type !== 'liability') || a.closed_at !== undefined) continue;
      const lots = this.lots[id];
      if (lots) {
        const parsed = lots
          .filter((l) => [l.qty, l.cost, l.acquired].some((s) => s.trim() !== ''))
          .map((l, i) => this.lot(l, `${accountLabel(chart, id)} lot ${i + 1}`));
        if (parsed.length > 0) lines.push({ account: id, lots: parsed });
        continue;
      }
      const balance = amountOf(this.balances[id] ?? '', minor(a.cur), accountLabel(chart, id));
      if (balance) lines.push({ account: id, balance });
    }
    return lines;
  }

  private lot(l: LotInput, field: string): OpeningLot {
    const costCur = l.costCur.trim().toUpperCase();
    if (!isCommodity(costCur)) throw new ParseError(`${field}: ${costCur || 'the cost commodity'} is not a commodity code`);
    const qty = amountOf(l.qty, 0, `${field} quantity`);
    const cost = amountOf(l.cost, minor(costCur), `${field} cost`);
    if (!qty) throw new ParseError(`${field}: enter a quantity`);
    if (!cost) throw new ParseError(`${field}: enter the total cost`);
    if (!isIsoDate(l.acquired)) throw new ParseError(`${field}: enter the acquisition date`);
    return { qty, cost: { ...cost, cur: costCur }, acquired: l.acquired };
  }

  private async post() {
    this.error = '';
    this.posted = null;
    const date = this.date;
    if (!isIsoDate(date)) {
      this.error = 'Enter the opening date.';
      return;
    }
    this.busy = true;
    try {
      const lines = this.lines(chartOf(this.doc));
      if (lines.length === 0) throw new ParseError('Every balance is blank.');

      // Show the entry as it will post, with any equity accounts it needs, before writing
      // anything. Then add those accounts and build it again on the chart as written.
      const missing = openingCommodities(date, lines, chartOf(this.doc))
        .filter((c) => !findOpeningEquity(chartOf(this.doc), c))
        .map((c) => [c, newAccountId(crypto.getRandomValues(new Uint8Array(15)))] as const);
      const proposed = withEquity(this.doc, missing);
      const preview = build(date, lines, proposed);
      // Ask the projection again rather than trust what was last shown.
      const openings = await this.projection.call('openings', openingEquityAccounts(chartOf(this.doc)));
      this.openings = openings;
      const opened = this.openedOn(openings);
      const again = lines.filter((l) => opened.has(l.account));
      if (!confirm(this.summary(preview, chartOf(proposed)))) return;
      if (again.length > 0 && !confirm(this.repeatWarning(again.map((l) => l.account), opened))) return;

      const doc = missing.length > 0 ? await this.addEquityAccounts(missing) : this.doc;
      const segmentOpen = await this.projection.call('segmentOpen', yearOf(date));
      const id = await this.ledger.postEntry(build(date, lines, doc), segmentOpen);
      this.posted = { id, date };
      this.balances = {};
      this.lots = {};
    } catch (err) {
      this.error = errorMessage(err);
    } finally {
      this.busy = false;
    }
  }

  private async addEquityAccounts(missing: readonly (readonly [Commodity, AccountId])[]): Promise<AccountsDoc> {
    const doc = await this.ledger.updateAccounts((doc) => withEquity(doc, missing));
    this.dispatchEvent(new CustomEvent<AccountsDoc>('accounts-changed', { detail: doc, bubbles: true }));
    return doc;
  }

  private repeatWarning(accounts: readonly AccountId[], opened: ReadonlyMap<AccountId, IsoDate>): string {
    const chart = chartOf(this.doc);
    const lines = accounts.map((id) => `${accountLabel(chart, id)}: opened ${opened.get(id)}`);
    return (
      'These accounts already have opening balances. Posting again adds to them, so each ' +
      'balance counts twice. To correct one, reverse its opening entry instead.\n\n' +
      `${lines.join('\n')}\n\nPost anyway?`
    );
  }

  private summary(entry: Entry, chart: Chart): string {
    const lines = entry.splits.map((s) => {
      const lot = s.cost ? ` (cost ${canonical(s.cost)} ${s.cost.cur}, acquired ${s.acquired})` : '';
      return `${accountLabel(chart, s.account)}: ${canonical(s)} ${s.cur}${lot}`;
    });
    return `Post opening balances dated ${entry.date}? Entries are permanent.\n\n${lines.join('\n')}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'opening-view': OpeningView;
  }
}
