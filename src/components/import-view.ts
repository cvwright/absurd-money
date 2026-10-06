/**
 * Import View
 *
 * Imports a bank or card CSV into an asset or liability account (0022): "CSV import,
 * client-side" in design/ACCOUNTING.md. Choose the account and the file. An account with
 * no profile gets one first, in the profile editor. The file is read with the profile,
 * each row is labeled (0023), and rows already imported or dismissed are dropped.
 *
 * Review shows each remaining row with what it will post as:
 *
 * - **Match**: the row is a split already in the journal with the same amount and a
 *   nearby date, such as the other side of a transfer or an entry made by hand. Approving
 *   marks that split as imported.
 * - **Replace**: the row is a pending charge imported earlier that posted changed, such as
 *   a tip added. Approving reverses the pending entry and posts the row in its place.
 * - **Add**: a new entry, with the category and payee the import rules chose (0021).
 * - **Dismiss**: never import the row.
 *
 * Ticked rows that are complete post when approved; the others stay for the next import
 * of an overlapping file. A rule can be made from a row, and it applies at once to the rows
 * not yet changed by hand. Review isn't kept: leaving the page drops it, and choosing the
 * file again picks up where the journal stands.
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Commodity } from '@/core/amount.js';
import { accountPath, chartOf, type Chart } from '@/core/chart.js';
import { readStatement, type MappedRows, type SkipReason } from '@/core/csv-import.js';
import { newRuleId, type AccountId, type IsoDate, type Label } from '@/core/ids.js';
import { freshRows, type LabeledRow } from '@/core/import-ids.js';
import { profileOf } from '@/core/import-profiles.js';
import type { AccountsDoc, AccountType, ImportProfilesDoc, PayeesDoc, Profile, RulesDoc } from '@/core/messages.js';
import { cleanPayeeName, findPayee, payeeChoices, payeeName } from '@/core/payees.js';
import { findMatches, findReplacements, MATCH_DAYS, rowMemo, shiftDate, type JournalSplit } from '@/core/review.js';
import { categorize, rulePattern, withRule } from '@/core/rules.js';
import type { ProjectionClient } from '@/projection/client.js';
import { approve, type Approval, type ReviewProjection } from '@/services/import-review.js';
import type { LedgerSpace } from '@/services/ledger-space.js';
import { today } from './dates.js';
import { comparePaths, errorMessage, formatAmount, shownAs } from './forms.js';
import { viewStyles } from './view-styles.js';
import './profile-editor.js';

type Kind = 'add' | 'match' | 'replace' | 'dismiss';

/** What the user has chosen for a row, kept by label while the journal changes under it. */
interface Choice {
  readonly include: boolean;
  readonly kind: Kind;
  readonly category: AccountId | '';
  readonly payee: string;
  /** Changed by hand, so new rules don't overwrite it. */
  readonly touched: boolean;
}

/** The file, read with the account's profile. */
interface Statement {
  readonly account: AccountId;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mapped: MappedRows;
  readonly labeled: readonly LabeledRow[];
}

/** The rows still to review, and what the journal suggests for them. */
interface Review {
  readonly fresh: readonly LabeledRow[];
  readonly matches: ReadonlyMap<Label, JournalSplit>;
  readonly replacements: ReadonlyMap<Label, JournalSplit>;
  readonly payees: PayeesDoc | undefined;
  readonly rules: RulesDoc | undefined;
}

const SKIP_TEXT: Record<SkipReason, string> = {
  'pending': 'pending',
  'no-amount': 'no amount',
  'zero-amount': 'zero amount',
};

const KIND_TEXT: Record<Kind, string> = {
  add: 'Add',
  match: 'Match',
  replace: 'Replace pending',
  dismiss: 'Dismiss',
};

/** Open asset and liability accounts, sorted by path. */
function importableAccounts(chart: Chart): { id: AccountId; label: string }[] {
  return [...chart]
    .filter(([, a]) => (a.type === 'asset' || a.type === 'liability') && a.closed_at === undefined)
    .map(([id]) => ({ id, path: accountPath(chart, id) }))
    .sort((x, y) => comparePaths(x.path, y.path))
    .map(({ id, path }) => ({ id, label: path.join(' › ') }));
}

/** The accounts a row's other side may post to: open, in the same commodity, not the account itself. */
function categories(chart: Chart, account: AccountId): { id: AccountId; label: string }[] {
  const cur = chart.get(account)?.cur;
  return [...chart]
    .filter(([id, a]) => id !== account && a.cur === cur && a.closed_at === undefined)
    .map(([id]) => ({ id, path: accountPath(chart, id) }))
    .sort((x, y) => comparePaths(x.path, y.path))
    .map(({ id, path }) => ({ id, label: path.join(' › ') }));
}

@customElement('import-view')
export class ImportView extends LitElement {
  static styles = viewStyles;

  @property({ attribute: false }) ledger!: LedgerSpace;
  @property({ attribute: false }) projection!: ProjectionClient;
  @property({ attribute: false }) doc!: AccountsDoc;

  @state() private account: AccountId | null = null;
  @state() private profiles: ImportProfilesDoc | undefined;
  @state() private file: { name: string; bytes: Uint8Array } | null = null;
  @state() private editing = false;
  @state() private statement: Statement | null = null;
  @state() private review: Review | null = null;
  @state() private choices = new Map<Label, Choice>();
  @state() private failures = new Map<Label, string>();
  @state() private busy = false;
  @state() private error = '';
  @state() private posted = '';

  /** Counts reviews, so a slow answer for a file no longer shown is dropped. */
  private generation = 0;
  private readonly onChange = () => void this.loadProfiles().then(() => this.refresh());

  connectedCallback() {
    super.connectedCallback();
    this.projection.addEventListener('change', this.onChange);
    void this.loadProfiles();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.projection.removeEventListener('change', this.onChange);
  }

  private async loadProfiles() {
    try {
      this.profiles = (await this.projection.call('doc', 'ledger/import-profiles')) as ImportProfilesDoc | undefined;
    } catch (err) {
      this.error = errorMessage(err);
    }
  }

  private get profile(): Profile | undefined {
    return this.account === null ? undefined : profileOf(this.profiles, this.account);
  }

  render() {
    const chart = chartOf(this.doc);
    const options = importableAccounts(chart);
    return html`
      <div class="toolbar">
        <h2>Import</h2>
        <select aria-label="Account" @change=${this.pickAccount}>
          <option value="" ?selected=${this.account === null} disabled>Choose an account</option>
          ${options.map((o) => html`<option value=${o.id} ?selected=${o.id === this.account}>${o.label}</option>`)}
        </select>
      </div>
      <p class="intro">
        Import a CSV statement from your bank or card. Nothing posts until you approve it,
        and rows already imported are never imported again.
      </p>
      ${this.posted ? html`<p class="posted" role="status">${this.posted}</p>` : nothing}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${options.length === 0
        ? html`<p class="empty">Add an asset or liability account to import into it.</p>`
        : this.account === null
          ? html`<p class="empty">Choose the account the statement is for.</p>`
          : this.renderAccount(chart, this.account)}
    `;
  }

  private renderAccount(chart: Chart, account: AccountId) {
    const profile = this.profile;
    return html`
      <div class="fields">
        <label>Statement file
          <input type="file" accept=".csv,text/csv,text/plain" @change=${this.pickFile} />
        </label>
        ${profile && this.file && !this.editing
          ? html`<button class="link" @click=${() => (this.editing = true)}>Change the profile</button>`
          : nothing}
      </div>
      ${this.file && (this.editing || !profile)
        ? html`<profile-editor .ledger=${this.ledger} .account=${account} .cur=${chart.get(account)!.cur}
            .file=${this.file.bytes} .profile=${profile}
            @profile-saved=${this.profileSaved} @profile-cancel=${() => (this.editing = false)}></profile-editor>`
        : this.statement?.account === account && this.review
          ? this.renderReview(chart, this.statement, this.review)
          : this.file && this.statement?.account === account
            ? html`<p class="empty">Loading…</p>`
            : nothing}
    `;
  }

  private renderReview(chart: Chart, s: Statement, r: Review) {
    const type = chart.get(s.account)!.type;
    const cur = chart.get(s.account)!.cur;
    const cats = categories(chart, s.account);
    const seen = s.labeled.length - r.fresh.length;
    const skipped = new Map<SkipReason, number>();
    for (const k of s.mapped.skipped) skipped.set(k.reason, (skipped.get(k.reason) ?? 0) + 1);
    const ready = this.approvals(r).length;

    return html`
      <p class="note">
        ${s.name}: ${s.labeled.length} rows${seen ? html`, ${seen} already imported` : nothing}${[...skipped]
          .map(([reason, n]) => html`, ${n} skipped (${SKIP_TEXT[reason]})`)}.
      </p>
      ${s.mapped.flagged.length
        ? html`<p class="warning">
            ${s.mapped.flagged.length} rows have no transaction ID and can't be imported. Enter them by
            hand: ${s.mapped.flagged.map((f) => `line ${f.line}, ${f.date}, ${f.description.trim()}`).join('; ')}.
          </p>`
        : nothing}
      ${r.fresh.length === 0
        ? html`<p class="empty">Nothing new to import.</p>`
        : html`
            <datalist id="import-payees">
              ${payeeChoices(r.payees).map((p) => html`<option value=${p.name}></option>`)}
            </datalist>
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th><input type="checkbox" aria-label="All" .checked=${r.fresh.every((x) => this.choices.get(x.importId)?.include)}
                      @change=${(e: Event) => this.includeAll(r, (e.target as HTMLInputElement).checked)} /></th>
                    <th>Date</th><th>Description</th><th class="num">Amount</th><th>Action</th><th>Category</th><th>Payee</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  ${r.fresh.map((row) => this.renderRow(chart, r, row, type, cur, cats))}
                </tbody>
              </table>
            </div>
            <div class="buttons">
              <span class="note">Unticked rows, and rows with no category, are left for later.</span>
              <button class="primary" ?disabled=${this.busy || ready === 0} @click=${() => void this.approveAll(r)}>
                ${this.busy ? 'Posting…' : `Approve ${ready} ${ready === 1 ? 'row' : 'rows'}`}
              </button>
            </div>
          `}
    `;
  }

  private renderRow(
    chart: Chart, r: Review, row: LabeledRow, type: AccountType, cur: Commodity,
    cats: readonly { id: AccountId; label: string }[],
  ) {
    const c = this.choices.get(row.importId);
    if (!c) return nothing;
    const match = r.matches.get(row.importId);
    const pending = r.replacements.get(row.importId);
    const kinds: Kind[] = ['add', ...(match ? (['match'] as const) : []), ...(pending ? (['replace'] as const) : []), 'dismiss'];
    const amount = shownAs(type, { ...row.amount, cur });
    const failure = this.failures.get(row.importId);
    const describe = (s: JournalSplit) => {
      const who = s.payee ? payeeName(r.payees, s.payee) : s.memo ?? s.others.map((a) => accountPath(chart, a).join(' › ')).join(', ');
      return `${s.date} ${formatAmount(shownAs(type, s.amount))} ${who}`;
    };
    const set = (change: Partial<Choice>) => this.choose(row.importId, { ...change, touched: true });

    return html`<tr>
      <td><input type="checkbox" .checked=${c.include} @change=${(e: Event) => set({ include: (e.target as HTMLInputElement).checked })} /></td>
      <td class="date">${row.date}</td>
      <td>
        ${rowMemo(row)}${row.memo?.trim() ? html` <span class="memo">${row.memo.trim()}</span>` : nothing}
        ${failure ? html`<div class="error">${failure}</div>` : nothing}
      </td>
      <td class="num ${amount.amount < 0n ? 'negative' : ''}">${formatAmount(amount)}</td>
      <td>
        <select aria-label="Action" @change=${(e: Event) => set({ kind: (e.target as HTMLSelectElement).value as Kind })}>
          ${kinds.map((k) => html`<option value=${k} ?selected=${k === c.kind}>${KIND_TEXT[k]}</option>`)}
        </select>
      </td>
      ${c.kind === 'match' && match
        ? html`<td colspan="3" class="memo">Already in the journal: ${describe(match)}</td>`
        : c.kind === 'dismiss'
          ? html`<td colspan="3" class="memo">Never imported</td>`
          : html`
              <td>
                ${c.kind === 'replace' && pending ? html`<div class="hint">Replaces ${describe(pending)}</div>` : nothing}
                <select aria-label="Category" @change=${(e: Event) => set({ category: (e.target as HTMLSelectElement).value as AccountId })}>
                  <option value="" ?selected=${c.category === ''} disabled>Choose</option>
                  ${cats.map((o) => html`<option value=${o.id} ?selected=${o.id === c.category}>${o.label}</option>`)}
                </select>
              </td>
              <td>
                <input aria-label="Payee" list="import-payees" .value=${c.payee} placeholder="Optional" autocomplete="off"
                  @input=${(e: Event) => set({ payee: (e.target as HTMLInputElement).value })} />
                ${cleanPayeeName(c.payee) !== '' && !findPayee(r.payees, cleanPayeeName(c.payee)) ? html`<span class="hint">new</span>` : nothing}
              </td>
              <td><button class="link" title="Always categorize rows like this one" @click=${() => void this.makeRule(row, c)}>Rule…</button></td>
            `}
    </tr>`;
  }

  // --- Loading --------------------------------------------------------------------------

  private pickAccount(e: Event) {
    this.account = (e.target as HTMLSelectElement).value as AccountId;
    this.statement = null;
    this.review = null;
    this.choices = new Map();
    this.failures = new Map();
    this.editing = false;
    this.error = '';
    this.posted = '';
    if (this.file) this.read();
  }

  private async pickFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    this.error = '';
    this.posted = '';
    try {
      this.file = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    } catch (err) {
      this.error = errorMessage(err);
      return;
    }
    this.statement = null;
    this.review = null;
    this.choices = new Map();
    this.failures = new Map();
    this.editing = false;
    this.read();
  }

  private profileSaved(e: CustomEvent<Profile>) {
    if (this.account === null) return;
    // The projection catches up with the write shortly; don't wait for it.
    this.profiles = {
      v: 1,
      rev: (this.profiles?.rev ?? 0) + 1,
      profiles: { ...this.profiles?.profiles, [this.account]: e.detail },
    };
    this.editing = false;
    this.statement = null;
    this.review = null;
    this.choices = new Map();
    this.read();
  }

  /** Reads the file with the account's profile and labels its rows. */
  private read() {
    const account = this.account;
    const profile = this.profile;
    if (!this.file || account === null || !profile) return;
    try {
      const mapped = readStatement(this.file.bytes, profile);
      const labeled = this.ledger.labelRows(mapped.rows, account);
      this.statement = { account, name: this.file.name, bytes: this.file.bytes, mapped, labeled };
    } catch (err) {
      this.error = `${errorMessage(err)}. Check the profile.`;
      this.editing = true;
      return;
    }
    void this.refresh();
  }

  /**
   * Drops the rows the journal already has, and finds matches, pending replacements, and
   * rule choices for the rest. Runs again whenever the projection changes.
   */
  private async refresh() {
    const s = this.statement;
    if (!s || s.account !== this.account) return;
    const generation = ++this.generation;
    try {
      const labels = s.labeled.map((r) => r.importId);
      const dates = s.labeled.map((r) => r.date).sort();
      const from = (dates[0] ?? today()) as IsoDate;
      const to = (dates[dates.length - 1] ?? today()) as IsoDate;
      const [consumed, splits, payees, rules] = await Promise.all([
        this.projection.call('consumed', labels),
        this.projection.call('importSplits', s.account, shiftDate(from, -MATCH_DAYS), shiftDate(to, MATCH_DAYS)),
        this.projection.call('doc', 'ledger/payees') as Promise<PayeesDoc | undefined>,
        this.projection.call('doc', 'ledger/rules') as Promise<RulesDoc | undefined>,
      ]);
      if (generation !== this.generation) return;
      const fresh = freshRows(s.labeled, consumed);
      const byIndex = findMatches(fresh, splits);
      const matches = new Map([...byIndex].map(([i, m]) => [fresh[i].importId, m]));
      const rest = fresh.filter((r) => !matches.has(r.importId));
      const replacements = new Map(
        [...findReplacements(rest, splits, { labels: new Set(labels), from, to })].map(([i, m]) => [rest[i].importId, m]),
      );
      const review: Review = { fresh, matches, replacements, payees, rules };
      this.review = review;
      this.choices = this.defaults(s.account, review);
    } catch (err) {
      if (generation === this.generation) this.error = errorMessage(err);
    }
  }

  /** A choice for each row: kept if changed by hand, otherwise what the journal and rules suggest. */
  private defaults(account: AccountId, r: Review): Map<Label, Choice> {
    const chart = chartOf(this.doc);
    const out = new Map<Label, Choice>();
    for (const row of r.fresh) {
      const kept = this.choices.get(row.importId);
      if (kept?.touched) {
        const valid = kept.kind === 'add' || kept.kind === 'dismiss'
          || (kept.kind === 'match' && r.matches.has(row.importId))
          || (kept.kind === 'replace' && r.replacements.has(row.importId));
        if (valid) {
          out.set(row.importId, kept);
          continue;
        }
      }
      const pending = r.replacements.get(row.importId);
      if (r.matches.has(row.importId)) {
        out.set(row.importId, { include: true, kind: 'match', category: '', payee: '', touched: false });
      } else if (pending) {
        out.set(row.importId, {
          include: true,
          kind: 'replace',
          category: pending.others.length === 1 ? pending.others[0] : '',
          payee: pending.payee ? payeeName(r.payees, pending.payee) : '',
          touched: false,
        });
      } else {
        const c = categorize(r.rules, { account, amount: row.amount, description: row.description, ...(row.memo !== undefined && { memo: row.memo }) }, { chart, payees: r.payees });
        out.set(row.importId, {
          include: true,
          kind: 'add',
          category: c.account ?? '',
          payee: c.payee ? payeeName(r.payees, c.payee) : '',
          touched: false,
        });
      }
    }
    return out;
  }

  private choose(label: Label, change: Partial<Choice>) {
    const prev = this.choices.get(label);
    if (!prev) return;
    this.choices = new Map(this.choices).set(label, { ...prev, ...change });
  }

  private includeAll(r: Review, include: boolean) {
    const next = new Map(this.choices);
    for (const row of r.fresh) {
      const c = next.get(row.importId);
      if (c) next.set(row.importId, { ...c, include, touched: true });
    }
    this.choices = next;
  }

  // --- Posting --------------------------------------------------------------------------

  /** The ticked rows that are complete, as decisions. */
  private approvals(r: Review): Approval[] {
    const out: Approval[] = [];
    for (const row of r.fresh) {
      const c = this.choices.get(row.importId);
      if (!c?.include) continue;
      const memo = rowMemo(row);
      const match = r.matches.get(row.importId);
      const pending = r.replacements.get(row.importId);
      if (c.kind === 'dismiss') out.push({ row, decision: { kind: 'dismiss' } });
      else if (c.kind === 'match' && match) out.push({ row, decision: { kind: 'match', split: match } });
      else if (c.kind === 'add' && c.category !== '') {
        out.push({ row, decision: { kind: 'add', category: c.category, payee: c.payee, memo } });
      } else if (c.kind === 'replace' && pending && c.category !== '') {
        out.push({ row, decision: { kind: 'replace', target: pending, category: c.category, payee: c.payee, memo } });
      }
    }
    return out;
  }

  private async approveAll(r: Review) {
    const s = this.statement;
    if (!s) return;
    const approvals = this.approvals(r);
    const cur = chartOf(this.doc).get(s.account)!.cur;
    this.busy = true;
    this.error = '';
    this.posted = '';
    try {
      const result = await approve(this.ledger, this.reviewProjection(), {
        account: s.account, cur, file: s.bytes, payees: r.payees, today: today(),
      }, approvals);
      this.failures = new Map(result.failed);
      const n = result.done.size;
      this.posted = `Imported ${n} ${n === 1 ? 'row' : 'rows'}.${result.failed.size ? ` ${result.failed.size} failed; see the rows below.` : ''}`;
    } catch (err) {
      this.error = errorMessage(err);
    } finally {
      this.busy = false;
    }
    await this.refresh();
  }

  private reviewProjection(): ReviewProjection {
    const p = this.projection;
    return {
      consumed: (labels) => p.call('consumed', labels),
      editTarget: (id) => p.call('editTarget', id),
      reversalTarget: (id) => p.call('reversalTarget', id),
      segmentOpen: (year) => p.call('segmentOpen', year),
    };
  }

  /**
   * Makes an import rule from a row: rows into this account whose description contains
   * the text get the row's category and payee. Rows not changed by hand follow it at once.
   */
  private async makeRule(row: LabeledRow, c: Choice) {
    const s = this.statement;
    if (!s) return;
    const payee = cleanPayeeName(c.payee);
    if (c.category === '' && payee === '') {
      this.error = 'Choose a category or a payee for the row first.';
      return;
    }
    const text = prompt('Always categorize rows whose description contains:', rulePattern(row.description));
    if (text === null) return;
    this.error = '';
    try {
      const payeeId = payee === '' ? undefined : (findPayee(this.review?.payees, payee) ?? (await this.ledger.addPayee(payee)));
      const id = newRuleId(crypto.getRandomValues(new Uint8Array(15)));
      await this.ledger.updateRules((doc) =>
        withRule(doc, {
          id,
          op: 'contains',
          pattern: text,
          scope: s.account,
          ...(payeeId && { payee: payeeId }),
          ...(c.category !== '' && { account: c.category }),
        }),
      );
      this.choose(row.importId, { touched: true });
      this.posted = `Rows containing "${rulePattern(text)}" will be categorized like this one.`;
    } catch (err) {
      this.error = errorMessage(err);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'import-view': ImportView;
  }
}
