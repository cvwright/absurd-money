import { describe, expect, it } from 'vitest';
import { commodity } from '@/core/amount.js';
import type { EditTarget } from '@/core/edit.js';
import type { BlobId, BlobRef, IsoDate, Label, MsgId, PayeeId } from '@/core/ids.js';
import type { LabeledRow } from '@/core/import-ids.js';
import type { Edit, Entry, Reversal } from '@/core/messages.js';
import type { JournalSplit } from '@/core/review.js';
import { A, day, lbl, msg } from '@/core/testing.js';
import { approve, type Approval, type ReviewLedger, type ReviewProjection } from './import-review.js';

const USD = commodity('USD');
const SOURCE: BlobRef = { blob: `B${'s'.repeat(43)}` as BlobId, dek: 'k'.repeat(43) };
const row = (name: string, date = '2026-09-14', cents = -500n): LabeledRow => ({
  line: 2, date: day(date), amount: { amount: cents, exp: 2 }, description: name.toUpperCase(), importId: lbl(name),
});
const split = (name: string, date = '2026-09-14'): JournalSplit => ({
  txn: msg(name), split: 0, date: day(date), amount: { amount: -500n, exp: 2, cur: USD }, others: [A.dining],
});
const target = (name: string, extra: Partial<EditTarget> = {}): EditTarget => ({
  id: msg(name), date: day('2026-09-14'), year: 2026, locked: false, segmentOpen: true, receipts: [],
  splits: [{ account: A.checking, amount: -500n, exp: 2, cur: USD }, { account: A.dining, amount: 500n, exp: 2, cur: USD }],
  accounts: [A.checking, A.dining], importIds: [undefined, undefined], ...extra,
});

/** Records what approval posts. `failEntry` makes posting that date's entries fail. */
function fakes(opts: { consumed?: Label[]; targets?: EditTarget[]; frozen?: number[]; failEntry?: string } = {}) {
  const calls: string[] = [];
  const entries: { entry: Entry; replaced?: unknown; consumed?: ReadonlySet<Label> }[] = [];
  const edits: Edit[] = [];
  const reversals: Reversal[] = [];
  const dismissed: Label[] = [];
  const targets = new Map((opts.targets ?? []).map((t) => [t.id, t]));
  let n = 0;
  const ledger: ReviewLedger = {
    async postEntry(entry, _open, replaced, consumed) {
      if (entry.date === opts.failEntry) throw new Error('the server said no');
      calls.push('entry');
      entries.push({ entry, replaced, consumed });
      return msg(`e${n++}`);
    },
    async postEdits(es) {
      calls.push('edits');
      edits.push(...es);
      return [msg(`ed${n++}`)];
    },
    async postDismissals(rows) {
      calls.push('dismiss');
      dismissed.push(...rows.map((r) => r.importId));
      return [msg(`d${n++}`)];
    },
    async postReversal(rev) {
      calls.push('reversal');
      reversals.push(rev);
      return msg('rev');
    },
    async addPayee(name) {
      calls.push(`payee ${name}`);
      return `payee_${name.padEnd(20, 'x')}` as PayeeId;
    },
    async uploadReceipt() {
      calls.push('upload');
      return SOURCE;
    },
  };
  const projection: ReviewProjection = {
    async consumed(labels) {
      return new Set(labels.filter((l) => opts.consumed?.includes(l)));
    },
    async editTarget(id: MsgId) {
      return targets.get(id);
    },
    async reversalTarget(id: MsgId) {
      return targets.get(id);
    },
    async segmentOpen(year) {
      return !opts.frozen?.includes(year);
    },
  };
  return { ledger, projection, calls, entries, edits, reversals, dismissed };
}

const ctx = { account: A.checking, cur: USD, file: new Uint8Array([1]), payees: undefined, today: '2026-10-05' as IsoDate };

describe('approve', () => {
  it('posts each kind of decision, uploading the file and each new payee once', async () => {
    const f = fakes({ targets: [target('hand'), target('pending')] });
    const approvals: Approval[] = [
      { row: row('cafe'), decision: { kind: 'add', category: A.dining, payee: 'Cafe', memo: 'CAFE' } },
      { row: row('cafe2', '2026-09-15'), decision: { kind: 'add', category: A.dining, payee: ' cafe ', memo: '' } },
      { row: row('junk'), decision: { kind: 'dismiss' } },
      { row: row('typed'), decision: { kind: 'match', split: split('hand') } },
      { row: row('tip', '2026-09-16', -2400n), decision: { kind: 'replace', target: split('pending'), category: A.dining, payee: '', memo: 'TIP' } },
    ];
    const result = await approve(f.ledger, f.projection, ctx, approvals);

    expect(result.failed).toEqual(new Map());
    expect(result.done).toEqual(new Set(approvals.map((a) => a.row.importId)));
    expect(f.calls).toEqual(['dismiss', 'edits', 'upload', 'payee Cafe', 'entry', 'entry', 'reversal', 'entry']);
    expect(f.dismissed).toEqual([lbl('junk')]);
    expect(f.edits).toEqual([{ target: msg('hand'), import_ids: { '0': lbl('typed') } }]);
    expect(f.entries[0].entry).toMatchObject({ source: SOURCE, payee: f.entries[1].entry.payee, memo: 'CAFE' });
    expect(f.entries[0].consumed).toEqual(new Set());
    // The pending entry is reversed on its own date, and the row replaces it.
    expect(f.reversals[0]).toMatchObject({ date: '2026-09-14', reverses: msg('pending') });
    expect(f.entries[2].entry).toMatchObject({ replaces: msg('pending'), date: '2026-09-16' });
    expect(f.entries[2].replaced).toMatchObject({ id: msg('pending'), reversedBy: msg('rev') });
  });

  it('skips rows handled elsewhere since review, and posts no file for no entries', async () => {
    const f = fakes({ consumed: [lbl('cafe')] });
    const result = await approve(f.ledger, f.projection, ctx, [
      { row: row('cafe'), decision: { kind: 'add', category: A.dining, payee: '', memo: '' } },
    ]);
    expect(result.failed.get(lbl('cafe'))).toBe('already imported or dismissed');
    expect(f.calls).toEqual([]);
  });

  it('dismisses a match whose entry is in a frozen segment', async () => {
    const f = fakes({ targets: [target('old', { segmentOpen: false })] });
    const result = await approve(f.ledger, f.projection, ctx, [
      { row: row('late', '2026-01-03'), decision: { kind: 'match', split: split('old', '2025-12-30') } },
    ]);
    expect(result.done).toEqual(new Set([lbl('late')]));
    expect(f.calls).toEqual(['dismiss']);
  });

  it('keeps going after a row fails, and reports it', async () => {
    const f = fakes({ failEntry: '2026-09-01' });
    const result = await approve(f.ledger, f.projection, ctx, [
      { row: row('bad', '2026-09-01'), decision: { kind: 'add', category: A.dining, payee: '', memo: '' } },
      { row: row('good'), decision: { kind: 'add', category: A.dining, payee: '', memo: '' } },
      { row: row('gone'), decision: { kind: 'match', split: split('nothing') } },
    ]);
    expect(result.done).toEqual(new Set([lbl('good')]));
    expect(result.failed).toEqual(new Map([
      [lbl('gone'), 'the matched entry is no longer in the journal'],
      [lbl('bad'), 'the server said no'],
    ]));
  });

  it('replaces a pending entry already reversed, without reversing it again', async () => {
    const f = fakes({ targets: [target('pending', { reversedBy: msg('earlier') })] });
    await approve(f.ledger, f.projection, ctx, [
      { row: row('tip'), decision: { kind: 'replace', target: split('pending'), category: A.dining, payee: '', memo: '' } },
    ]);
    expect(f.calls).toEqual(['upload', 'entry']);
    expect(f.entries[0].replaced).toMatchObject({ reversedBy: msg('earlier') });
  });
});
