/**
 * Profile Editor
 *
 * Creates or changes an account's CSV mapping profile (`ledger/import-profiles`, 0022)
 * against a file the user picked: the encoding, delimiter, and lines to skip, which column
 * is which, the date format, and the sign. A new profile starts from a guess
 * (`guessDraft`). A preview maps the file with the draft as it stands, so a mistake shows
 * before anything is saved.
 *
 * A profile decides each row's import label, so the scheme (row or ID column) is fixed
 * once saved, and changing a column that feeds the label asks first: rows already
 * imported would look new.
 *
 * Fires `profile-saved` (a `CustomEvent<Profile>`) once written, and `profile-cancel`.
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { minor, type Commodity } from '@/core/amount.js';
import { decodeBytes, mapRows, skipLines, type MappedRows } from '@/core/csv-import.js';
import { parseCsv, type CsvRecord } from '@/core/csv.js';
import type { AccountId } from '@/core/ids.js';
import {
  draftProfile, guessDraft, profileDraft, relabelWarnings, usesFitid, withProfile, type ProfileDraft,
} from '@/core/import-profiles.js';
import { PROFILE_ENCODINGS, type Profile } from '@/core/messages.js';
import { trimWhitespace } from '@/core/normalize.js';
import type { LedgerSpace } from '@/services/ledger-space.js';
import { errorMessage, formatAmount } from './forms.js';
import { viewStyles } from './view-styles.js';

const DELIMITERS: { value: string; label: string }[] = [
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Bar' },
];

const DATE_FORMATS = ['YYYY-MM-DD', 'MM/DD/YYYY', 'M/D/YYYY', 'DD/MM/YYYY', 'D/M/YYYY', 'DD.MM.YYYY', 'MM/DD/YY', 'YYYYMMDD'];

/** How many mapped rows the preview shows. */
const PREVIEW_ROWS = 8;

type ColumnKey = 'date' | 'amount' | 'debit' | 'credit' | 'description' | 'memo' | 'fitid' | 'pending';

@customElement('profile-editor')
export class ProfileEditor extends LitElement {
  static styles = viewStyles;

  @property({ attribute: false }) ledger!: LedgerSpace;
  @property({ attribute: false }) account!: AccountId;
  @property({ attribute: false }) cur!: Commodity;
  @property({ attribute: false }) file!: Uint8Array;
  /** The account's profile, if it has one. */
  @property({ attribute: false }) profile: Profile | undefined;

  @state() private draft: ProfileDraft | null = null;
  @state() private busy = false;
  @state() private error = '';

  willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has('profile') || changed.has('account') || this.draft === null) {
      this.draft = this.profile ? profileDraft(this.profile) : guessDraft(this.file, minor(this.cur));
      this.error = '';
    }
  }

  /** The file's records under the draft's encoding, delimiter, and skips. */
  private records(d: ProfileDraft): { records: CsvRecord[]; firstLine: number } {
    const { text, firstLine } = skipLines(decodeBytes(this.file, d.encoding), d.skipRows, d.skipEndRows);
    return { records: parseCsv(text, d.delimiter), firstLine };
  }

  render() {
    const d = this.draft;
    if (!d) return nothing;
    let read: { records: CsvRecord[]; firstLine: number } | undefined;
    let readError = '';
    try {
      read = this.records(d);
    } catch (err) {
      readError = errorMessage(err);
    }
    const first = read?.records[0]?.cells ?? [];
    const columns = d.header
      ? first.map((c) => ({ value: trimWhitespace(c), label: trimWhitespace(c) }))
      : first.map((c, i) => ({ value: String(i), label: `${i + 1}: ${trimWhitespace(c).slice(0, 24)}` }));

    let profile: Profile | undefined;
    let mapped: MappedRows | undefined;
    let mapError = '';
    if (read) {
      try {
        profile = draftProfile(d);
        mapped = mapRows(read.records, profile, read.firstLine);
      } catch (err) {
        mapError = errorMessage(err);
      }
    }
    const warnings = this.profile && profile ? relabelWarnings(this.profile, profile) : [];

    return html`
      <h3>${this.profile ? 'Change the import profile' : 'New import profile'}</h3>
      <p class="note">
        Tell the app how this bank's file is laid out. It is saved for the account and used
        for every import into it.
      </p>

      <div class="fields">
        <label>Encoding
          <select @change=${(e: Event) => this.set({ encoding: (e.target as HTMLSelectElement).value as ProfileDraft['encoding'] })}>
            ${PROFILE_ENCODINGS.map((x) => html`<option value=${x} ?selected=${x === d.encoding}>${x}</option>`)}
          </select>
        </label>
        <label>Delimiter
          <select @change=${(e: Event) => this.set({ delimiter: (e.target as HTMLSelectElement).value })}>
            ${DELIMITERS.map((x) => html`<option .value=${x.value} ?selected=${x.value === d.delimiter}>${x.label}</option>`)}
          </select>
        </label>
        <label>Skip lines at start
          <input class="narrow" type="number" min="0" .value=${String(d.skipRows)}
            @input=${(e: Event) => this.set({ skipRows: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })} />
        </label>
        <label>at end
          <input class="narrow" type="number" min="0" .value=${String(d.skipEndRows)}
            @input=${(e: Event) => this.set({ skipEndRows: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })} />
        </label>
        <label>
          <input type="checkbox" .checked=${d.header}
            @change=${(e: Event) => this.set({ header: (e.target as HTMLInputElement).checked, ...blankColumns })} />
          First row names the columns
        </label>
      </div>

      ${readError ? html`<p class="error" role="alert">${readError}</p>` : nothing}

      <div class="fields">
        ${this.column('Date', 'date', columns, false)}
        <label>Format
          <input list="date-formats" .value=${d.dateFormat}
            @input=${(e: Event) => this.set({ dateFormat: (e.target as HTMLInputElement).value })} />
          <datalist id="date-formats">${DATE_FORMATS.map((f) => html`<option value=${f}></option>`)}</datalist>
        </label>
      </div>

      <div class="fields">
        <label>
          <input type="radio" name="amount-mode" .checked=${d.amountMode === 'signed'}
            @change=${() => this.set({ amountMode: 'signed' })} />
          One amount column
        </label>
        <label>
          <input type="radio" name="amount-mode" .checked=${d.amountMode === 'split'}
            @change=${() => this.set({ amountMode: 'split' })} />
          Separate debit and credit columns
        </label>
      </div>
      <div class="fields">
        ${d.amountMode === 'signed'
          ? html`${this.column('Amount', 'amount', columns, false)}
              <label>
                <input type="checkbox" .checked=${d.negate}
                  @change=${(e: Event) => this.set({ negate: (e.target as HTMLInputElement).checked })} />
                Money out is shown positive
              </label>`
          : html`${this.column('Money out', 'debit', columns, false)} ${this.column('Money in', 'credit', columns, false)}`}
        <label>Decimal mark
          <select @change=${(e: Event) => this.set({ decimal: (e.target as HTMLSelectElement).value as '.' | ',' })}>
            <option value="." ?selected=${d.decimal === '.'}>1,234.56</option>
            <option value="," ?selected=${d.decimal === ','}>1.234,56</option>
          </select>
        </label>
        <label>Decimal places
          <input class="narrow" type="number" min="0" max="18" .value=${String(d.exp)}
            @input=${(e: Event) => this.set({ exp: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })} />
        </label>
      </div>

      <div class="fields">
        ${this.column('Description', 'description', columns, false)}
        ${this.column('Memo', 'memo', columns, true)}
      </div>

      <div class="fields">
        ${this.renderFitid(columns)}
        ${this.column('Status', 'pending', columns, true)}
        ${d.pending !== ''
          ? html`<label>Pending when it says
              <input .value=${d.pendingValue}
                @input=${(e: Event) => this.set({ pendingValue: (e.target as HTMLInputElement).value })} />
            </label>`
          : nothing}
      </div>

      ${mapError ? html`<p class="error" role="alert">${mapError}</p>` : nothing}
      ${mapped ? this.renderPreview(mapped) : nothing}
      ${warnings.length > 0
        ? html`<p class="warning">
            Rows already imported will look new, because ${warnings.join(', and ')}. Review them
            carefully next time.
          </p>`
        : nothing}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}

      <div class="buttons">
        ${this.profile
          ? html`<button class="link" @click=${() => this.dispatchEvent(new CustomEvent('profile-cancel'))}>Cancel</button>`
          : nothing}
        <button class="primary" ?disabled=${!mapped || this.busy} @click=${() => void this.save(profile!, warnings)}>
          ${this.busy ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    `;
  }

  /** The ID column: only for a new profile, or one that already uses the ID scheme. */
  private renderFitid(columns: readonly { value: string; label: string }[]) {
    if (this.profile && !usesFitid(this.profile)) return nothing;
    return html`${this.column('Transaction ID', 'fitid', columns, !this.profile)}
      ${this.profile ? nothing : html`<span class="hint">only if every row has its own ID that never changes</span>`}`;
  }

  private column(label: string, key: ColumnKey, columns: readonly { value: string; label: string }[], optional: boolean) {
    const value = this.draft![key];
    const known = columns.some((c) => c.value === value);
    return html`<label>${label}
      <select @change=${(e: Event) => this.set({ [key]: (e.target as HTMLSelectElement).value })}>
        <option value="" ?selected=${value === ''} ?disabled=${!optional}>${optional ? 'None' : 'Choose'}</option>
        ${!known && value !== '' ? html`<option .value=${value} selected>${value} (missing)</option>` : nothing}
        ${columns.map((c) => html`<option .value=${c.value} ?selected=${c.value === value}>${c.label}</option>`)}
      </select>
    </label>`;
  }

  private renderPreview(m: MappedRows) {
    const skipped = m.skipped.length + m.flagged.length;
    return html`
      <p class="note">
        ${m.rows.length} rows to import${skipped ? html`, ${skipped} skipped` : nothing}. The first few:
      </p>
      <div class="scroll">
        <table>
          <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead>
          <tbody>
            ${m.rows.slice(0, PREVIEW_ROWS).map(
              (r) => html`<tr>
                <td class="date">${r.date}</td>
                <td>${r.description}${r.memo ? html` <span class="memo">${r.memo}</span>` : nothing}</td>
                <td class="num ${r.amount.amount < 0n ? 'negative' : ''}">${formatAmount({ ...r.amount, cur: this.cur })}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <p class="note">Money into the account should be positive and money out negative.</p>
    `;
  }

  private set(change: Partial<ProfileDraft>) {
    this.draft = { ...this.draft!, ...change };
    this.error = '';
  }

  private async save(profile: Profile, warnings: readonly string[]) {
    if (warnings.length > 0 && !confirm(`Rows already imported will look new: ${warnings.join(', ')}. Save anyway?`)) return;
    this.busy = true;
    this.error = '';
    try {
      await this.ledger.updateProfiles((doc) => withProfile(doc, this.account, profile));
      this.dispatchEvent(new CustomEvent('profile-saved', { detail: profile }));
    } catch (err) {
      this.error = errorMessage(err);
    } finally {
      this.busy = false;
    }
  }
}

/** Column choices are names with a header and indices without, so switching clears them. */
const blankColumns: Partial<ProfileDraft> = {
  date: '', amount: '', debit: '', credit: '', description: '', memo: '', fitid: '', pending: '',
};

declare global {
  interface HTMLElementTagNameMap {
    'profile-editor': ProfileEditor;
  }
}
