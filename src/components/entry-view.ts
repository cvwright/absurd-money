/**
 * Entry View
 *
 * Type in a journal entry with any number of splits and post it as one `ledger.entry`
 * (0010). Each line is an account with a debit or a credit. One line per commodity may
 * leave its amount blank and takes the remainder. What is out of balance is shown as you
 * type, and the entry is checked against the post-time rules before it posts.
 *
 * Lots and payees are left to later issues (0027, 0036).
 *
 * Given `reenter`, the form is a replacement for a reversed entry (0042): it starts as a
 * copy of that entry, with its effective accounts, and posts with `replaces`, so the
 * register shows it as the corrected line. Posting or cancelling fires `re-enter-done`.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { canonical, minor, neg, type Decimal } from '@/core/amount.js';
import { accountLabel, accountPath, chartOf, type Chart } from '@/core/chart.js';
import { ParseError } from '@/core/errors.js';
import { isAccountId, isIsoDate, type AccountId, type IsoDate, type MsgId } from '@/core/ids.js';
import {
  describeImbalance, imbalances, isPostable, manualEntry, type ManualLine,
} from '@/core/manual.js';
import { ACCOUNT_TYPES, type AccountsDoc, type AccountType, type Entry } from '@/core/messages.js';
import { defaultReversalDate, type ReversalTarget } from '@/core/reversal.js';
import type { ProjectionClient } from '@/projection/client.js';
import { InvalidEntryError, type LedgerSpace } from '@/services/ledger-space.js';
import { today } from './dates.js';
import { amountOf, comparePaths, errorMessage, formatAmount } from './forms.js';

/** A reversed entry to re-enter, as `re-enter` events carry it. */
export interface ReEnter {
  /** `reversedBy` is set, though the projection may not have the reversal yet. */
  readonly target: ReversalTarget;
  /** The entry's effective memo. */
  readonly memo?: string;
}

const TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expenses',
};

interface LineInput {
  account: AccountId | '';
  debit: string;
  credit: string;
}

const emptyLine = (): LineInput => ({ account: '', debit: '', credit: '' });

interface Option {
  id: AccountId;
  label: string;
}

/** The accounts a manual entry can post to, by type, sorted by path. */
function optionsOf(chart: Chart): [AccountType, Option[]][] {
  return ACCOUNT_TYPES.map((type) => {
    const opts = [...chart]
      .filter(([, a]) => a.type === type && isPostable(a))
      .map(([id]) => ({ id, path: accountPath(chart, id) }))
      .sort((x, y) => comparePaths(x.path, y.path))
      .map(({ id, path }) => ({ id, label: path.join(' › ') }));
    return [type, opts] as [AccountType, Option[]];
  }).filter(([, opts]) => opts.length > 0);
}

/**
 * One typed line as a manual line, or `null` if it is entirely blank. Throws a
 * `ParseError` naming the line.
 */
function lineOf(l: LineInput, i: number, chart: Chart): ManualLine | null {
  const at = `Line ${i + 1}`;
  if (l.account === '') {
    if (l.debit.trim() === '' && l.credit.trim() === '') return null;
    throw new ParseError(`${at}: choose an account`);
  }
  const a = chart.get(l.account);
  if (!a) throw new ParseError(`${at}: unknown account`);
  const field = `${at} ("${accountLabel(chart, l.account)}")`;
  const debit = amountOf(l.debit, minor(a.cur), `${field} debit`);
  const credit = amountOf(l.credit, minor(a.cur), `${field} credit`);
  if (debit && credit) throw new ParseError(`${field}: enter a debit or a credit, not both`);
  const amount: Decimal | undefined = debit ?? (credit && neg(credit));
  return amount ? { account: l.account, amount } : { account: l.account };
}

/** The typed lines that parse, for the running balance. Lines that don't are skipped. */
function lenientLines(inputs: readonly LineInput[], chart: Chart): ManualLine[] {
  const lines: ManualLine[] = [];
  inputs.forEach((l, i) => {
    try {
      const line = lineOf(l, i, chart);
      if (line) lines.push(line);
    } catch {
      // Shown when posting.
    }
  });
  return lines;
}

@customElement('entry-view')
export class EntryView extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    h2,
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
    }

    input:focus,
    select:focus {
      border-color: var(--color-accent);
    }

    .intro {
      color: var(--color-text-secondary);
      margin: var(--spacing-sm) 0 var(--spacing-md);
    }

    .fields {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-lg);
    }

    .fields label {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .fields .memo {
      flex: 1 1 240px;
    }

    .fields .memo input {
      flex: 1;
    }

    .head,
    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 8em 8em 4em 2em;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
    }

    .head {
      font-size: var(--font-size-sm);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--color-text-secondary);
    }

    .head .num {
      text-align: right;
    }

    .row {
      border-radius: var(--radius-sm);
    }

    .row:hover {
      background-color: var(--color-bg-secondary);
    }

    .amount {
      text-align: right;
      font-family: var(--font-family-mono);
    }

    .cur,
    .hint {
      color: var(--color-text-subdued);
      font-size: var(--font-size-sm);
      font-family: var(--font-family-mono);
    }

    .remove {
      color: var(--color-text-subdued);
    }

    .remove:hover {
      color: var(--color-error);
    }

    .link {
      color: var(--color-text-secondary);
      font-size: var(--font-size-sm);
    }

    .link:hover {
      color: var(--color-accent);
    }

    .footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-md);
      padding: var(--spacing-sm);
      margin-bottom: var(--spacing-lg);
    }

    .balance {
      font-size: var(--font-size-sm);
      text-align: right;
    }

    .balance.ok {
      color: var(--color-positive);
    }

    .balance.off {
      color: var(--color-error);
    }

    .empty {
      color: var(--color-text-subdued);
      margin-bottom: var(--spacing-lg);
    }

    .error {
      color: var(--color-error);
      margin-bottom: var(--spacing-md);
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

    @media (max-width: 560px) {
      .head {
        display: none;
      }

      .row {
        grid-template-columns: 1fr 1fr 3em 2em;
      }

      .row select {
        grid-column: 1 / -1;
      }
    }
  `;

  @property({ attribute: false }) ledger!: LedgerSpace;
  @property({ attribute: false }) projection!: ProjectionClient;
  @property({ attribute: false }) doc!: AccountsDoc;
  @property({ attribute: false }) reenter: ReEnter | null = null;

  @state() private date: string = today();
  @state() private memo = '';
  @state() private lines: LineInput[] = [emptyLine(), emptyLine()];
  @state() private busy = false;
  @state() private error = '';
  @state() private posted: { id: MsgId; date: IsoDate } | null = null;
  /** The reversed entry this one will replace. */
  @state() private replacing: ReEnter | null = null;

  willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has('reenter')) this.startReplacing(this.reenter);
  }

  private startReplacing(r: ReEnter | null) {
    this.replacing = r;
    if (!r) return;
    const { target } = r;
    this.posted = null;
    this.error = '';
    this.date = defaultReversalDate(target, today());
    this.memo = r.memo ?? '';
    this.lines = target.splits.map((s, i) => {
      const text = formatAmount(s.amount < 0n ? { ...s, amount: -s.amount } : s);
      return { account: target.accounts[i], debit: s.amount > 0n ? text : '', credit: s.amount < 0n ? text : '' };
    });
  }

  private stopReplacing() {
    this.replacing = null;
    this.memo = '';
    this.lines = [emptyLine(), emptyLine()];
    this.dispatchEvent(new CustomEvent('re-enter-done', { bubbles: true }));
  }

  render() {
    const chart = chartOf(this.doc);
    const options = optionsOf(chart);
    const parsed = lenientLines(this.lines, chart);
    const off = imbalances(parsed, chart);

    return html`
      <h2>${this.replacing ? 'Replacement entry' : 'New entry'}</h2>
      ${this.replacing
        ? html`<p class="intro">
            Replaces the entry of ${this.replacing.target.date}, which has been reversed. Change
            what was wrong and post; the register shows this as the corrected entry.
            <button class="link" type="button" @click=${this.stopReplacing}>Cancel</button>
          </p>`
        : nothing}
      <p class="intro">
        Debits increase assets and expenses; credits increase liabilities, income, and
        equity. Debits and credits must be equal in each commodity. Leave one line's amount
        blank and it takes the rest. Entries are permanent: a mistake is fixed by reversing
        it.
      </p>

      ${this.posted
        ? html`<p class="posted" role="status">
            Posted an entry for ${this.posted.date}.
            <span class="hint" title=${this.posted.id}>${this.posted.id.slice(0, 12)}…</span>
          </p>`
        : nothing}
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}

      ${options.length === 0
        ? html`<p class="empty">There are no open accounts to post to. Add them under Accounts.</p>`
        : html`
            <div class="fields">
              <label>
                Date
                <input type="date" required .value=${this.date}
                  @input=${(e: Event) => (this.date = (e.target as HTMLInputElement).value)} />
              </label>
              <label class="memo">
                Memo
                <input .value=${this.memo} placeholder="Optional"
                  @input=${(e: Event) => (this.memo = (e.target as HTMLInputElement).value)} />
              </label>
            </div>

            <div class="head" aria-hidden="true">
              <span>Account</span><span class="num">Debit</span><span class="num">Credit</span><span></span><span></span>
            </div>
            ${this.lines.map((l, i) => this.renderLine(l, i, chart, options, parsed))}

            <div class="footer">
              <button class="link" type="button" @click=${() => (this.lines = [...this.lines, emptyLine()])}>
                Add a line
              </button>
              ${off.length === 0
                ? html`<span class="balance ok">${parsed.some((l) => l.amount) ? 'Balanced' : nothing}</span>`
                : html`<span class="balance off" role="status">${off.map(
                    (s) => html`<div>${describeImbalance(s)}${this.blankFor(s.cur, chart) !== undefined ? ' (filled by the blank line)' : ''}</div>`,
                  )}</span>`}
            </div>

            <button class="primary" type="button" ?disabled=${this.busy} @click=${this.post}>
              ${this.replacing ? 'Post replacement' : 'Post entry'}
            </button>
          `}
    `;
  }

  private renderLine(l: LineInput, i: number, chart: Chart, options: [AccountType, Option[]][], parsed: ManualLine[]) {
    const a = l.account === '' ? undefined : chart.get(l.account);
    const label = `Line ${i + 1}`;
    // A blank line shows the remainder it would take.
    let debitHint = '';
    let creditHint = '';
    if (a && this.blankFor(a.cur, chart) === i) {
      const s = imbalances(parsed, chart).find((x) => x.cur === a.cur);
      if (s) {
        if (s.amount < 0n) debitHint = canonical(neg(s));
        else creditHint = canonical(s);
      }
    }
    const edit = (field: keyof LineInput) => (e: Event) => {
      const value = (e.target as HTMLInputElement | HTMLSelectElement).value;
      this.lines = this.lines.map((x, j) => (j === i ? { ...x, [field]: value } : x));
    };
    return html`
      <div class="row">
        <select aria-label=${`${label} account`} @change=${edit('account')}>
          <option value="" .selected=${l.account === ''}>Choose an account…</option>
          ${options.map(
            ([type, opts]) => html`<optgroup label=${TYPE_LABELS[type]}>
              ${opts.map((o) => html`<option value=${o.id} .selected=${o.id === l.account}>${o.label}</option>`)}
            </optgroup>`,
          )}
        </select>
        <input class="amount" inputmode="decimal" placeholder=${debitHint} .value=${l.debit}
          aria-label=${`${label} debit`} @input=${edit('debit')} />
        <input class="amount" inputmode="decimal" placeholder=${creditHint} .value=${l.credit}
          aria-label=${`${label} credit`} @input=${edit('credit')} />
        <span class="cur">${a?.cur ?? ''}</span>
        <button class="remove" type="button" title="Remove line" aria-label=${`Remove line ${i + 1}`}
          ?disabled=${this.lines.length <= 2}
          @click=${() => (this.lines = this.lines.filter((_, j) => j !== i))}>✕</button>
      </div>
    `;
  }

  /** The index of the only line in `cur` with an account and no amount, if there is one. */
  private blankFor(cur: string, chart: Chart): number | undefined {
    const blanks = this.lines.flatMap((l, i) =>
      isAccountId(l.account) && chart.get(l.account)?.cur === cur && l.debit.trim() === '' && l.credit.trim() === ''
        ? [i]
        : [],
    );
    return blanks.length === 1 ? blanks[0] : undefined;
  }

  private async post() {
    this.error = '';
    this.posted = null;
    const date = this.date;
    if (!isIsoDate(date)) {
      this.error = 'Enter the date.';
      return;
    }
    this.busy = true;
    try {
      const chart = chartOf(this.doc);
      const lines = this.lines.flatMap((l, i) => lineOf(l, i, chart) ?? []);
      const replacing = this.replacing;
      const result = manualEntry({ date, lines, memo: this.memo, replaces: replacing?.target.id }, chart);
      if (result.problems) throw new InvalidEntryError(result.problems);
      if (!confirm(this.summary(result.entry, chart))) return;

      let replaced: ReversalTarget | undefined;
      if (replacing) {
        // Fresh, to see a replacement posted elsewhere. A reversal posted a moment ago may
        // not have synced yet, so the one we were handed still counts.
        const fresh = await this.projection.call('reversalTarget', replacing.target.id);
        replaced = fresh && { ...fresh, reversedBy: fresh.reversedBy ?? replacing.target.reversedBy };
      }
      // postEntry checks the entry again against the latest chart.
      const id = await this.ledger.postEntry(result.entry, replaced);
      if (replacing) this.stopReplacing();
      this.posted = { id, date };
      this.memo = '';
      this.lines = [emptyLine(), emptyLine()];
    } catch (err) {
      this.error = errorMessage(err);
    } finally {
      this.busy = false;
    }
  }

  private summary(entry: Entry, chart: Chart): string {
    const lines = entry.splits.map((s) => {
      const side = s.amount > 0n ? 'debit' : 'credit';
      return `${accountLabel(chart, s.account)}: ${side} ${canonical(s.amount > 0n ? s : neg(s))} ${s.cur}`;
    });
    const memo = entry.memo ? ` "${entry.memo}"` : '';
    const what = entry.replaces ? 'replacement entry' : 'entry';
    return `Post this ${what}${memo} dated ${entry.date}? Entries are permanent.\n\n${lines.join('\n')}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'entry-view': EntryView;
  }
}
