/**
 * Edit Dialog
 *
 * Changes a posted entry's memo, payee, receipts, and the category of its income and
 * expense splits, and posts the difference as one `ledger.edit` (0015). Amounts, dates,
 * and asset, liability, and equity accounts can't be edited; they need a reversal. A
 * locked or reversed entry keeps its categories, but its memo, payee, and receipts can
 * still change.
 *
 * Receipts picked here are encrypted and uploaded when the edit is saved. A receipt is
 * opened by downloading it and showing it from a blob URL. Its type is sniffed from its
 * first bytes and limited to PDF and common images, so a receipt can never be shown as
 * HTML or SVG in the app's origin; anything else downloads.
 *
 * The register calls `open` with the entry as the projection holds it.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { accountLabel, accountPath, chartOf, isNominal, type Chart } from '@/core/chart.js';
import { canRecategorize, editOf, type EditTarget } from '@/core/edit.js';
import { isPayeeId, type AccountId, type BlobRef, type PayeeId } from '@/core/ids.js';
import { isPostable } from '@/core/manual.js';
import type { AccountsDoc, PayeesDoc } from '@/core/messages.js';
import type { LedgerSpace } from '@/services/ledger-space.js';
import { comparePaths, errorMessage, formatAmount } from './forms.js';

/** A receipt already on the entry, or a file picked here and not yet uploaded. */
type Receipt = { readonly ref: BlobRef } | { readonly file: File };

const RECEIPT_TYPES = 'application/pdf,image/jpeg,image/png,image/gif,image/webp';

/** The type of a receipt from its first bytes: PDF or an image, else a download. */
function receiptType(b: Uint8Array): string {
  const at = (offset: number, ...xs: number[]) => xs.every((x, i) => b[offset + i] === x);
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return 'application/octet-stream';
}

/** The open income and expense accounts in `cur`, sorted by path, plus `current`. */
function categoriesOf(chart: Chart, cur: string, current: AccountId): { id: AccountId; label: string }[] {
  return [...chart]
    .filter(([id, a]) => id === current || (isNominal(a) && isPostable(a) && a.cur === cur))
    .map(([id]) => ({ id, path: accountPath(chart, id) }))
    .sort((x, y) => comparePaths(x.path, y.path))
    .map(({ id, path }) => ({ id, label: path.join(' › ') }));
}

/** Payees to choose from: those not merged away, by name, plus `current`. */
function payeeOptions(doc: PayeesDoc | undefined, current: PayeeId | undefined): { id: PayeeId; name: string }[] {
  return Object.entries(doc?.payees ?? {})
    .filter(([id, p]) => id === current || p.merged_into === undefined)
    .map(([id, p]) => ({ id: id as PayeeId, name: p.name }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

@customElement('edit-dialog')
export class EditDialog extends LitElement {
  static styles = css`
    dialog {
      background-color: var(--color-bg-elevated);
      color: var(--color-text-primary);
      border: none;
      border-radius: var(--radius-lg);
      padding: var(--spacing-lg);
      width: min(560px, calc(100vw - 2 * var(--spacing-md)));
    }

    dialog::backdrop {
      background: rgb(0 0 0 / 50%);
    }

    h3,
    h4 {
      margin: 0 0 var(--spacing-sm);
    }

    h4 {
      font-size: var(--font-size-sm);
      color: var(--color-text-secondary);
    }

    p {
      margin: 0 0 var(--spacing-md);
      color: var(--color-text-secondary);
      font-size: var(--font-size-sm);
    }

    .error {
      color: var(--color-error);
      margin-bottom: var(--spacing-md);
    }

    .fields {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }

    .fields label {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      flex: 1 1 200px;
    }

    .fields input,
    .fields select {
      flex: 1;
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

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--font-size-sm);
      margin-bottom: var(--spacing-md);
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
    }

    .num {
      font-family: var(--font-family-mono);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      text-align: right;
    }

    ul {
      list-style: none;
      margin: 0 0 var(--spacing-sm);
      padding: 0;
      font-size: var(--font-size-sm);
    }

    li {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      padding: var(--spacing-xs) 0;
    }

    li .name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .receipts {
      margin-bottom: var(--spacing-md);
    }

    button {
      font: inherit;
      border: none;
      cursor: pointer;
      background: none;
      color: inherit;
    }

    .link {
      color: var(--color-text-subdued);
      font-size: var(--font-size-xs);
    }

    .link:hover {
      color: var(--color-accent);
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
  `;

  @property({ attribute: false }) ledger!: LedgerSpace;
  @property({ attribute: false }) doc!: AccountsDoc;
  @property({ attribute: false }) payees: PayeesDoc | undefined;

  @state() private target: EditTarget | null = null;
  @state() private memo = '';
  @state() private payee: PayeeId | '' = '';
  @state() private splits = new Map<number, AccountId>();
  @state() private receipts: Receipt[] = [];
  @state() private error = '';
  @state() private busy = false;
  @query('dialog') private dialog?: HTMLDialogElement;

  /** Shows the dialog for `target`, as the projection holds it now. */
  open(target: EditTarget): void {
    this.target = target;
    this.memo = target.memo ?? '';
    this.payee = target.payee ?? '';
    this.splits = new Map(target.accounts.map((a, i) => [i, a]));
    this.receipts = target.receipts.map((ref) => ({ ref }));
    this.error = '';
  }

  updated(changed: Map<PropertyKey, unknown>) {
    if (changed.has('target') && this.target && !this.dialog?.open) this.dialog?.showModal();
  }

  render() {
    const t = this.target;
    return html`
      <dialog @close=${() => (this.target = null)} aria-labelledby="edit-title">
        ${t ? this.renderForm(t, chartOf(this.doc)) : nothing}
      </dialog>
    `;
  }

  private renderForm(t: EditTarget, chart: Chart) {
    const payees = payeeOptions(this.payees, t.payee);
    const frozen = t.locked || t.reversedBy !== undefined;
    return html`
      <h3 id="edit-title">Edit this entry</h3>
      <p>
        Amounts, the date, and asset, liability, and equity accounts can't be changed here;
        reverse the entry and re-enter it instead.${frozen
          ? t.locked
            ? ' The entry is in a closed period, so its categories are fixed too; post an adjusting entry to move them.'
            : ' The entry has been reversed, so its categories are fixed.'
          : ''}
      </p>
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      <div class="fields">
        <label>
          Memo
          <input .value=${this.memo} placeholder="None"
            @input=${(e: Event) => (this.memo = (e.target as HTMLInputElement).value)} />
        </label>
        ${payees.length > 0
          ? html`<label>
              Payee
              <select @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                this.payee = isPayeeId(v) ? v : '';
              }}>
                <option value="" ?selected=${this.payee === ''}>None</option>
                ${payees.map((p) => html`<option value=${p.id} ?selected=${p.id === this.payee}>${p.name}</option>`)}
              </select>
            </label>`
          : nothing}
      </div>
      <table>
        <thead>
          <tr><th>Account</th><th class="num">Amount</th></tr>
        </thead>
        <tbody>
          ${t.splits.map((s, i) => {
            const current = this.splits.get(i) ?? t.accounts[i];
            return html`<tr>
              <td>
                ${canRecategorize(t, chart, i)
                  ? html`<select aria-label=${`Split ${i + 1} account`} @change=${(e: Event) =>
                      (this.splits = new Map(this.splits).set(i, (e.target as HTMLSelectElement).value as AccountId))}>
                      ${categoriesOf(chart, s.cur, t.accounts[i]).map(
                        (o) => html`<option value=${o.id} ?selected=${o.id === current}>${o.label}</option>`,
                      )}
                    </select>`
                  : accountLabel(chart, t.accounts[i]) || t.accounts[i]}
              </td>
              <td class="num">${formatAmount(s)}</td>
            </tr>`;
          })}
        </tbody>
      </table>
      <div class="receipts">
        <h4>Receipts</h4>
        ${this.receipts.length > 0
          ? html`<ul>
              ${this.receipts.map(
                (r, i) => html`<li>
                  <span class="name">${'file' in r ? `${r.file.name} (new)` : `Receipt ${i + 1}`}</span>
                  <button class="link" type="button" @click=${() => void this.view(r)}>Open</button>
                  <button class="link" type="button" ?disabled=${this.busy}
                    @click=${() => (this.receipts = this.receipts.filter((x) => x !== r))}>Remove</button>
                </li>`,
              )}
            </ul>`
          : nothing}
        <input type="file" accept=${RECEIPT_TYPES} multiple aria-label="Add receipts" ?disabled=${this.busy}
          @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            this.receipts = [...this.receipts, ...[...(input.files ?? [])].map((file) => ({ file }))];
            input.value = '';
          }} />
      </div>
      <div class="buttons">
        <button type="button" @click=${() => this.dialog?.close()}>Cancel</button>
        <button class="primary" type="button" ?disabled=${this.busy} @click=${() => void this.save()}>
          ${this.busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    `;
  }

  /**
   * Opens a receipt in a new tab. The tab is opened before the download, while the click
   * still counts as a user gesture, so a popup blocker lets it through.
   */
  private async view(r: Receipt) {
    const w = window.open('', '_blank');
    try {
      const bytes = 'file' in r ? new Uint8Array(await r.file.arrayBuffer()) : await this.ledger.downloadReceipt(r.ref);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: receiptType(bytes) }));
      if (w) w.location.href = url;
      else window.location.assign(url);
      // The tab has its own reference once it loads.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      w?.close();
      this.error = `Could not open the receipt: ${errorMessage(err)}`;
    }
  }

  private async save() {
    const t = this.target;
    if (!t) return;
    this.busy = true;
    this.error = '';
    try {
      const receipts: BlobRef[] = [];
      for (const r of this.receipts) {
        receipts.push('file' in r ? await this.ledger.uploadReceipt(new Uint8Array(await r.file.arrayBuffer())) : r.ref);
      }
      // Uploaded files stay on the entry's list if posting fails, so a retry doesn't upload them again.
      this.receipts = receipts.map((ref) => ({ ref }));
      const edit = editOf(t, {
        memo: this.memo,
        payee: this.payee === '' ? null : this.payee,
        receipts,
        splits: this.splits,
      });
      if (edit) await this.ledger.postEdits([edit], new Map([[t.id, t]]), this.payees);
      this.dialog?.close();
    } catch (err) {
      this.error = errorMessage(err);
    } finally {
      this.busy = false;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'edit-dialog': EditDialog;
  }
}
