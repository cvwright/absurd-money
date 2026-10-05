import { describe, expect, it } from 'vitest';
import { readStatement, type ImportRow } from './csv-import.js';
import { importConsumption } from './fold/ledger.js';
import { foldSegment, type RawMessage } from './fold/segment.js';
import type { AccountId, Label } from './ids.js';
import {
  dismissPostProblems, freshRows, importInputs, labelRows, packDismissals, type LabeledRow,
} from './import-ids.js';
import { deriveLabelKeys } from './labels.js';
import type { Profile } from './messages.js';
import { A, chart, day, entry, lbl, msg, usd } from './testing.js';

const keys = deriveLabelKeys(new Uint8Array(32), `S${'A'.repeat(43)}`);
const ACCT = 'acct_7bQ2xV9mKd4TnR1sYgLp' as AccountId;
const row = (date: string, amount: bigint, exp: number, description: string, extra: Partial<ImportRow> = {}): ImportRow => ({
  line: 1, date: day(date), amount: { amount, exp }, description, ...extra,
});

describe('importInputs', () => {
  it('counts earlier rows with the same date, amount by value, and normalized description', () => {
    // The vectors in design/NORMALIZATION.md, "Label input", with `n` computed here.
    expect(importInputs([
      row('2026-09-14', -500n, 2, 'BLUE BOTTLE'),
      row('2026-09-14', -5000n, 3, 'Blue  Bottle '),
      row('2026-09-14', 1234n, 2, 'REFUND | ACME'),
    ], ACCT)).toEqual([
      `${ACCT}|2026-09-14|-5|blue bottle|#0`,
      `${ACCT}|2026-09-14|-5|blue bottle|#1`,
      `${ACCT}|2026-09-14|12.34|refund | acme|#0`,
    ]);
  });

  it('counts within each date, not across the file', () => {
    const inputs = importInputs([
      row('2026-09-13', -500n, 2, 'BLUE BOTTLE'),
      row('2026-09-14', -500n, 2, 'BLUE BOTTLE'),
      row('2026-09-14', -600n, 2, 'BLUE BOTTLE'),
      row('2026-09-14', -500n, 2, 'BLUE BOTTLE'),
    ], ACCT);
    expect(inputs.map((s) => s.slice(s.indexOf('|') + 1))).toEqual([
      '2026-09-13|-5|blue bottle|#0',
      '2026-09-14|-5|blue bottle|#0',
      '2026-09-14|-6|blue bottle|#0',
      '2026-09-14|-5|blue bottle|#1',
    ]);
  });

  it('uses the fitid scheme for fitid rows, and never mixes the two', () => {
    expect(importInputs([row('2026-09-14', -500n, 2, 'X', { fitid: '20260914-ABc01' })], ACCT))
      .toEqual([`${ACCT}|fitid|20260914-ABc01`]);
    expect(() => importInputs([row('2026-09-14', -500n, 2, 'X', { fitid: 'a' }), row('2026-09-14', -500n, 2, 'X')], ACCT))
      .toThrow(RangeError);
  });

  it('gives the same row in two accounts two labels', () => {
    const r = [row('2026-09-14', -500n, 2, 'TRANSFER')];
    expect(labelRows(r, A.checking, keys)[0].importId).not.toBe(labelRows(r, A.visa, keys)[0].importId);
  });
});

const profile: Profile = {
  delimiter: ',',
  skip_rows: 0,
  header: true,
  date: { column: 'Date', format: 'YYYY-MM-DD' },
  amount: { column: 'Amount', negate: false },
  description: { column: 'Description' },
  exp: 2,
};
const csv = (...lines: string[]) => new TextEncoder().encode(['Date,Description,Amount', ...lines].join('\n'));

/**
 * One account's books as the import flow sees them: each import labels the file's rows,
 * drops the consumed ones, and posts an entry per row that is left, as approving them
 * all in review would.
 */
function books(p: Profile = profile) {
  const log: RawMessage[] = [];
  const fold = () => foldSegment('journal-2026', log, { chart });
  const consumed = () => new Set(importConsumption([fold()]).consumed.keys());
  const append = (type: string, data: unknown) => log.push({ id: msg(`m${log.length}`), type, data });
  return {
    /** Labels and filters a file, as review shows it. */
    review(bytes: Uint8Array): LabeledRow[] {
      return freshRows(labelRows(readStatement(bytes, p).rows, A.checking, keys), consumed());
    },
    /** Reviews a file and approves every row. Returns what was posted. */
    import(bytes: Uint8Array): LabeledRow[] {
      const rows = this.review(bytes);
      for (const r of rows) {
        const cents = Number(r.amount.amount);
        append('ledger.entry', entry(r.date, [usd(A.checking, cents, { import_id: r.importId }), usd(A.dining, -cents)]));
      }
      return rows;
    },
    dismiss(rows: readonly LabeledRow[]) {
      for (const { msg: m } of packDismissals(rows)) append('ledger.dismiss', m);
    },
    /** Each posted entry as `date amount`, its amount in checking, sorted. The fold must be clean. */
    posted(): string[] {
      const f = fold();
      expect(f.anomalies).toEqual([]);
      return [...f.entries.values()].map((e) => `${e.entry.date} ${e.entry.splits[0].amount}`).sort();
    },
    consumed,
  };
}

describe('import idempotency', () => {
  const sept = csv(
    '2026-09-01,PAYROLL,2500.00',
    '2026-09-14,BLUE BOTTLE,-5.00',
    '2026-09-14,BLUE BOTTLE,-5.00',
    '2026-09-20,MARKET,-84.23',
  );

  it('posts nothing when the same file is imported twice', () => {
    const b = books();
    expect(b.import(sept)).toHaveLength(4);
    expect(b.import(sept)).toEqual([]);
    expect(b.posted()).toHaveLength(4);
  });

  it('posts two entries for two identical same-day rows', () => {
    const b = books();
    b.import(sept);
    expect(b.posted().filter((p) => p === '2026-09-14 -500')).toHaveLength(2);
  });

  it('posts the union of two overlapping exports', () => {
    const b = books();
    b.import(sept);
    const overlap = csv(
      '2026-09-14,BLUE BOTTLE,-5.00',
      '2026-09-14,Blue Bottle,-5.00',
      '2026-09-20,MARKET,-84.23',
      '2026-10-01,PAYROLL,2500.00',
      '2026-10-14,BLUE BOTTLE,-5.00',
    );
    expect(b.import(overlap).map((r) => r.date)).toEqual(['2026-10-01', '2026-10-14']);
    expect(b.posted()).toEqual([
      '2026-09-01 250000', '2026-09-14 -500', '2026-09-14 -500', '2026-09-20 -8423',
      '2026-10-01 250000', '2026-10-14 -500',
    ]);
  });

  it('posts a row missing from an earlier export', () => {
    const b = books();
    b.import(csv('2026-09-14,BLUE BOTTLE,-5.00'));
    const later = b.import(csv('2026-09-14,BLUE BOTTLE,-5.00', '2026-09-14,BLUE BOTTLE,-5.00'));
    expect(later).toHaveLength(1);
    expect(b.posted()).toEqual(['2026-09-14 -500', '2026-09-14 -500']);
  });

  it('does not show dismissed rows again', () => {
    const b = books();
    b.dismiss(b.review(sept).filter((r) => r.description === 'PAYROLL'));
    expect(b.import(sept).map((r) => r.description)).toEqual(['BLUE BOTTLE', 'BLUE BOTTLE', 'MARKET']);
    expect(b.review(sept)).toEqual([]);
  });

  it('cannot recognize a pending row that posts changed; review has to', () => {
    // A tip added: the posted row has another date and amount, so another label.
    const b = books();
    b.import(csv('2026-09-14,CAFE,-20.00'));
    expect(b.import(csv('2026-09-14,CAFE,-20.00', '2026-09-15,CAFE,-24.00')).map((r) => r.amount.amount)).toEqual([-2400n]);
    expect(b.posted()).toEqual(['2026-09-14 -2000', '2026-09-15 -2400']);
  });

  it('never sees a pending row the profile skips, so it posts once', () => {
    const withStatus = (...lines: string[]) =>
      new TextEncoder().encode(['Date,Description,Amount,Status', ...lines].join('\n'));
    const b = books({ ...profile, pending: { column: 'Status', value: 'Pending' } });
    expect(b.import(withStatus('2026-09-14,CAFE,-20.00,Pending'))).toEqual([]);
    expect(b.import(withStatus('2026-09-15,CAFE,-24.00,Posted'))).toHaveLength(1);
    expect(b.import(withStatus('2026-09-15,CAFE,-24.00,Posted'))).toEqual([]);
    expect(b.posted()).toEqual(['2026-09-15 -2400']);
  });

  it('keys a fitid profile on the fitid alone', () => {
    const withId = (...lines: string[]) =>
      new TextEncoder().encode(['Date,Description,Amount,Id', ...lines].join('\n'));
    const b = books({ ...profile, fitid: { column: 'Id' } });
    b.import(withId('2026-09-14,CAFE,-20.00,T1', '2026-09-14,CAFE,-20.00,T2'));
    // The bank rewrote the description; the IDs still match.
    expect(b.import(withId('2026-09-14,CAFE #42,-20.00,T2', '2026-09-15,CAFE,-3.00,T3'))).toHaveLength(1);
    expect(b.posted()).toEqual(['2026-09-14 -2000', '2026-09-14 -2000', '2026-09-15 -300']);
  });
});

describe('packDismissals', () => {
  const d = (date: string, name: string) => ({ date: day(date), importId: lbl(name) });

  it('routes by year, drops repeats, and splits long lists', () => {
    expect(packDismissals([d('2026-01-02', 'a'), d('2025-12-31', 'b'), d('2026-03-01', 'c'), d('2026-01-02', 'a'),
      d('2026-04-01', 'e')], 2)).toEqual([
      { year: 2025, msg: { v: 1, import_ids: [lbl('b')] } },
      { year: 2026, msg: { v: 1, import_ids: [lbl('a'), lbl('c')] } },
      { year: 2026, msg: { v: 1, import_ids: [lbl('e')] } },
    ]);
    expect(packDismissals([])).toEqual([]);
  });

  it('refuses consumed rows and a frozen segment', () => {
    const m = { v: 1 as const, import_ids: [lbl('a'), lbl('b')] };
    const consumed = new Set<Label>([lbl('b')]);
    expect(dismissPostProblems(m, { consumed: new Set(), segmentOpen: true, year: 2026 })).toEqual([]);
    expect(dismissPostProblems(m, { consumed, segmentOpen: false, year: 2026 })).toEqual([
      `import row ${lbl('b')} is already consumed`,
      'journal-2026 is frozen',
    ]);
  });
});
