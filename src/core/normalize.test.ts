// Test vectors from design/NORMALIZATION.md.
import { describe, expect, it } from 'vitest';
import type { AccountId, IsoDate } from './ids.js';
import { importInputFitid, importInputRow, normalizeDescription } from './normalize.js';

const hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join(' ');

describe('normalizeDescription', () => {
  it.each([
    ['BLUE BOTTLE', 'blue bottle'],
    ['  SQ *BLUE   BOTTLE 0412  ', 'sq *blue bottle 0412'],
    ['Blue\tBottle\r\nCoffee', 'blue bottle coffee'],
    ['BLUE BOTTLE COFFEE\u3000SF', 'blue bottle coffee sf'],
    ['BLUE\u0085BOTTLE COFFEE', 'blue bottle coffee'],
    ['ＡＭＡＺＯＮ．ＣＯＭ', 'amazon.com'],
    ['Oﬃce Depot', 'office depot'],
    ['STRASSE', 'strasse'],
    ['\u212A-MART', 'k-mart'],
    ['AT&T  *Bill-Pay #123', 'at&t *bill-pay #123'],
    ['PAYPAL *J.DOE', 'paypal *j.doe'],
    ['', ''],
    [' \t ', ''],
  ])('%j', (input, output) => expect(normalizeDescription(input)).toBe(output));

  it.each([
    ['Caf\u00E9 Rouge', '63 61 66 c3 a9 20 72 6f 75 67 65'],
    ['Cafe\u0301 Rouge', '63 61 66 c3 a9 20 72 6f 75 67 65'],
    ['Straße', '73 74 72 61 c3 9f 65'],
    ['ΟΔΟΣ 5', 'ce bf ce b4 ce bf cf 82 20 35'],
    ['İSTANBUL', '69 cc 87 73 74 61 6e 62 75 6c'],
    ['Unit Ⅷ ① ½ m²', '75 6e 69 74 20 76 69 69 69 20 31 20 31 e2 81 84 32 20 6d 32'],
    ['BLUE\u200BBOTTLE', '62 6c 75 65 e2 80 8b 62 6f 74 74 6c 65'],
    ['\uFEFFBLUE', 'ef bb bf 62 6c 75 65'],
    ['\uD800X', 'ef bf bd 78'],
  ])('%j as UTF-8', (input, bytes) => expect(hex(normalizeDescription(input))).toBe(bytes));

  it('is idempotent on the vectors', () => {
    for (const s of ['İSTANBUL', 'ΟΔΟΣ', 'Cafe\u0301', '  A  B  ']) {
      const n = normalizeDescription(s);
      expect(normalizeDescription(n)).toBe(n);
    }
  });
});

describe('import/v1 label input', () => {
  const account = 'acct_7bQ2xV9mKd4TnR1sYgLp' as AccountId;
  const date = '2026-09-14' as IsoDate;
  it.each([
    [-500n, 2, 'BLUE BOTTLE', 0, `${account}|2026-09-14|-5|blue bottle|#0`],
    [-5000n, 3, 'Blue  Bottle ', 1, `${account}|2026-09-14|-5|blue bottle|#1`],
    [1234n, 2, 'REFUND | ACME', 0, `${account}|2026-09-14|12.34|refund | acme|#0`],
    [-5n, 2, '', 12, `${account}|2026-09-14|-0.05||#12`],
  ] as const)('row (%s, %s) %j #%s', (amount, exp, description, n, out) => {
    expect(importInputRow({ account, date, amount: { amount, exp }, description, n })).toBe(out);
  });
  it('fitid', () => {
    expect(importInputFitid(account, ' 20260914-ABc01 ')).toBe(`${account}|fitid|20260914-ABc01`);
    expect(importInputFitid(account, ' X\u200B')).toBe(`${account}|fitid|X\u200B`);
  });
});
