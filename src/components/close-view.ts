/**
 * Close View
 *
 * Closes a month, a quarter, or a year (0016) by posting a `ledger.checkpoint` that cites
 * the head of that year's journal segment. Every entry posted there so far is then locked
 * against category changes, and a final close of a whole year also freezes the segment.
 * Lists the closes already posted.
 *
 * The lock is positional, so the form says how many entries dated after the period are
 * already posted and will be locked along with it.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { periodEnd, periodYear, previousMonth } from '@/core/close.js';
import { segmentOf, type MsgId } from '@/core/ids.js';
import type { ProjectionClient } from '@/projection/client.js';
import type { Close } from '@/projection/projection.js';
import type { LedgerSpace } from '@/services/ledger-space.js';
import { today } from './dates.js';
import { errorMessage } from './forms.js';

type Kind = 'month' | 'quarter' | 'year';

/** What the projection says about the segment a close would cite. */
interface Segment {
  readonly year: number;
  readonly listed: boolean;
  readonly open: boolean;
  /** Entries dated after the period that the close would lock too. */
  readonly after: number;
}

@customElement('close-view')
export class CloseView extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    h2,
    h3,
    p {
      margin: 0;
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
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-md);
    }

    .year {
      width: 6em;
    }

    .final {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      margin-bottom: var(--spacing-md);
    }

    .note {
      color: var(--color-text-secondary);
      font-size: var(--font-size-sm);
      margin-bottom: var(--spacing-md);
    }

    .warn {
      color: var(--color-warning);
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

    .period {
      font-family: var(--font-family-mono);
      min-width: 6em;
    }

    .hint {
      color: var(--color-text-subdued);
      font-size: var(--font-size-sm);
      font-family: var(--font-family-mono);
    }

    .tag {
      color: var(--color-text-secondary);
      font-size: var(--font-size-sm);
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

    .primary {
      font: inherit;
      border: none;
      cursor: pointer;
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

  @state() private kind: Kind = 'month';
  @state() private month = previousMonth(today());
  @state() private year = this.month.slice(0, 4);
  @state() private quarter = 'Q1';
  @state() private final = false;
  @state() private closes: Close[] = [];
  @state() private segment: Segment | null = null;
  @state() private busy = false;
  @state() private error = '';
  @state() private posted: { id: MsgId; period: string; final: boolean } | null = null;

  /** Counts queries, so a slow answer for a period no longer shown is dropped. */
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
    if (['projection', 'kind', 'month', 'year', 'quarter'].some((k) => changed.has(k))) void this.load();
  }

  /** The period the form names, or undefined if it names none. */
  private get period(): string | undefined {
    const p = this.kind === 'month' ? this.month : this.kind === 'quarter' ? `${this.year}-${this.quarter}` : this.year;
    return periodEnd(p) === undefined ? undefined : p;
  }

  private async load() {
    const generation = ++this.generation;
    const period = this.period;
    try {
      const [closes, years] = await Promise.all([this.projection.call('closes'), this.projection.call('years')]);
      let segment: Segment | null = null;
      if (period !== undefined) {
        const year = periodYear(period)!;
        const [open, after] = await Promise.all([
          this.projection.call('segmentOpen', year),
          this.projection.call('entriesAfter', year, periodEnd(period)!),
        ]);
        segment = { year, listed: years.includes(year), open, after };
      }
      if (generation !== this.generation) return;
      this.closes = closes;
      this.segment = segment;
    } catch (err) {
      if (generation === this.generation) this.error = errorMessage(err);
    }
  }

  render() {
    const period = this.period;
    const s = this.segment;
    const final = this.kind === 'year' && this.final;
    const blocked = !period || !s || !s.listed || !s.open;
    return html`
      <h2>Close the books</h2>
      <p class="intro">
        Closing a period locks every entry already posted to that year's journal, so its
        categories can't change. Memos, payees, and receipts still can. The lock follows the
        order entries were posted, not their dates. To fix a category on a locked entry,
        post a new entry that moves the amount. A final close of a year also freezes it, so
        nothing more can be posted to it. Do that once its taxes are filed.
      </p>

      ${this.posted
        ? html`<p class="posted" role="status">
            ${this.posted.final ? 'Froze' : 'Closed'} ${this.posted.period}.
            <span class="hint" title=${this.posted.id}>${this.posted.id.slice(0, 12)}…</span>
          </p>`
        : nothing}
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}

      <div class="fields">
        <select aria-label="Period" @change=${(e: Event) => (this.kind = (e.target as HTMLSelectElement).value as Kind)}>
          <option value="month" ?selected=${this.kind === 'month'}>Month</option>
          <option value="quarter" ?selected=${this.kind === 'quarter'}>Quarter</option>
          <option value="year" ?selected=${this.kind === 'year'}>Year</option>
        </select>
        ${this.kind === 'month'
          ? html`<input type="month" aria-label="Month" required .value=${this.month}
              @input=${(e: Event) => (this.month = (e.target as HTMLInputElement).value)} />`
          : html`<input class="year" type="number" aria-label="Year" min="1900" max="9999" required .value=${this.year}
              @input=${(e: Event) => (this.year = (e.target as HTMLInputElement).value)} />`}
        ${this.kind === 'quarter'
          ? html`<select aria-label="Quarter" @change=${(e: Event) => (this.quarter = (e.target as HTMLSelectElement).value)}>
              ${['Q1', 'Q2', 'Q3', 'Q4'].map((q) => html`<option ?selected=${this.quarter === q}>${q}</option>`)}
            </select>`
          : nothing}
      </div>

      ${this.kind === 'year'
        ? html`<label class="final">
            <input type="checkbox" .checked=${this.final}
              @change=${(e: Event) => (this.final = (e.target as HTMLInputElement).checked)} />
            Final: freeze ${this.year}, so nothing more can be posted to it
          </label>`
        : nothing}

      ${period && s ? this.renderNote(period, s) : nothing}

      <button class="primary" type="button" ?disabled=${this.busy || blocked} @click=${this.post}>
        ${final ? `Freeze ${period ?? ''}` : `Close ${period ?? ''}`}
      </button>

      ${this.renderCloses()}
    `;
  }

  private renderNote(period: string, s: Segment) {
    if (!s.listed) return html`<p class="note">Nothing has been posted for ${s.year}, so there is nothing to close.</p>`;
    if (!s.open) return html`<p class="note">${s.year} is frozen. Nothing more can be closed or posted there.</p>`;
    return html`<p class="note">
      Locks everything posted to ${segmentOf(s.year)} so far.
      ${s.after > 0
        ? html`<span class="warn">${s.after} ${s.after === 1 ? 'entry' : 'entries'} dated after ${period}
            ${s.after === 1 ? 'is' : 'are'} already posted there and will be locked too.</span>`
        : nothing}
    </p>`;
  }

  private renderCloses() {
    const byTopic = new Map<string, Close[]>();
    for (const c of this.closes) byTopic.set(c.topic, [...(byTopic.get(c.topic) ?? []), c]);
    const topics = [...byTopic.keys()].sort().reverse();
    return html`
      <section>
        <h3>Closes</h3>
        ${topics.length === 0
          ? html`<p class="empty">Nothing has been closed yet.</p>`
          : topics.map(
              (t) => html`<ul aria-label=${t}>
                ${byTopic.get(t)!.slice().reverse().map(
                  (c) => html`<li>
                    <span class="period">${c.period}</span>
                    <span class="tag">${c.final ? `froze ${t}` : `locked ${t}`}</span>
                    ${c.held ? nothing : html`<span class="tag">waiting for sync</span>`}
                    <span class="hint" title=${c.msg}>${c.msg.slice(0, 12)}…</span>
                  </li>`,
                )}
              </ul>`,
            )}
      </section>
    `;
  }

  private async post() {
    const period = this.period;
    const s = this.segment;
    if (!period || !s) return;
    const final = this.kind === 'year' && this.final;
    this.error = '';
    this.posted = null;
    const what = final
      ? `Freeze ${s.year}? Everything posted to it so far is locked, and nothing more can be posted to it, ever.`
      : `Close ${period}? Everything posted to ${s.year} so far is locked against category changes.`;
    if (!confirm(`${what} Closes are permanent.`)) return;
    this.busy = true;
    try {
      // Fresh, in case a final close arrived since the form loaded.
      const segmentOpen = await this.projection.call('segmentOpen', s.year);
      const id = await this.ledger.postClose(period, { final, segmentOpen });
      this.posted = { id, period, final };
      this.final = false;
    } catch (err) {
      this.error = errorMessage(err);
    } finally {
      this.busy = false;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'close-view': CloseView;
  }
}
