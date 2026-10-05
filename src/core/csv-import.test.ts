import { describe, expect, it } from 'vitest';
import { decodeBytes, mapRows, parseDate, readStatement, skipLines } from './csv-import.js';
import { parseCsv } from './csv.js';
import { ParseError } from './errors.js';
import type { Profile } from './messages.js';

const bytes = (...xs: number[]) => new Uint8Array(xs);
const utf8 = (s: string) => new TextEncoder().encode(s);
const latin = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe('decodeBytes', () => {
  it('decodes UTF-8 and removes its BOM', () => {
    expect(decodeBytes(bytes(0xef, 0xbb, 0xbf, 0x61, 0xc3, 0xa9))).toBe('aé');
  });
  it('rejects invalid UTF-8 instead of minting U+FFFD', () => {
    expect(() => decodeBytes(latin('Caf\xe9'))).toThrow(ParseError);
  });
  it('decodes windows-1252, including its C1 range', () => {
    expect(decodeBytes(latin('Caf\xe9 \x80'), 'windows-1252')).toBe('Café €');
  });
  it('rejects UTF-8 under windows-1252, which would decode as mojibake', () => {
    expect(() => decodeBytes(utf8('Café'), 'windows-1252')).toThrow(/looks like UTF-8/);
    expect(() => decodeBytes(bytes(0xef, 0xbb, 0xbf, 0x61), 'windows-1252')).toThrow(ParseError);
    expect(decodeBytes(utf8('plain ascii'), 'windows-1252')).toBe('plain ascii');
  });
  it('decodes UTF-16 with or without a BOM', () => {
    expect(decodeBytes(bytes(0xff, 0xfe, 0x61, 0x00, 0xe9, 0x00), 'utf-16le')).toBe('aé');
    expect(decodeBytes(bytes(0x00, 0x61, 0x00, 0xe9), 'utf-16be')).toBe('aé');
  });
});

describe('skipLines', () => {
  it('skips a preamble and a trailer by physical line', () => {
    const text = 'Account: "1234\nas of today\nDate,Amt\n1,2\nTotal,2\n\n\n';
    expect(skipLines(text, 2, 1)).toEqual({ text: 'Date,Amt\n1,2', firstLine: 3 });
  });
  it('keeps line breaks inside the kept text as they are', () => {
    expect(skipLines('x\r\na,"1\r\n2"\r\nend', 1, 1).text).toBe('a,"1\r\n2"');
  });
  it('returns nothing when the skips overlap', () => {
    expect(skipLines('a\nb', 1, 5).text).toBe('');
    expect(skipLines('a\nb', 0, 0).text).toBe('a\nb');
  });
});

describe('parseDate', () => {
  it.each([
    ['09/14/2026', 'MM/DD/YYYY', '2026-09-14'],
    ['9/4/2026', 'M/D/YYYY', '2026-09-04'],
    ['09/14/2026', 'M/D/YYYY', '2026-09-14'],
    ['14.09.26', 'DD.MM.YY', '2026-09-14'],
    ['20260914', 'YYYYMMDD', '2026-09-14'],
    [' 2026-09-14 ', 'YYYY-MM-DD', '2026-09-14'],
  ])('%s with %s', (cell, format, iso) => {
    expect(parseDate(cell, format)).toBe(iso);
  });
  it.each([
    ['2026-02-30', 'YYYY-MM-DD'],
    ['9/4/2026', 'MM/DD/YYYY'],
    ['2026-09-14 13:02', 'YYYY-MM-DD'],
    ['2026/09/14', 'YYYY-MM-DD'],
    ['', 'YYYY-MM-DD'],
  ])('rejects %j with %s', (cell, format) => {
    expect(() => parseDate(cell, format)).toThrow(ParseError);
  });
});

const base: Profile = {
  delimiter: ',',
  skip_rows: 0,
  header: true,
  date: { column: 'Date', format: 'YYYY-MM-DD' },
  amount: { column: 'Amount', negate: false },
  description: { column: 'Description' },
  exp: 2,
};
const map = (text: string, p: Partial<Profile> = {}) => mapRows(parseCsv(text, ','), { ...base, ...p });

describe('mapRows', () => {
  it('maps columns by trimmed header name and keeps text cells raw', () => {
    const r = map(' Date ,Description,Amount\n2026-09-14,  BLUE BOTTLE ,-5.00');
    expect(r.rows).toEqual([
      { line: 2, date: '2026-09-14', amount: { amount: -500n, exp: 2 }, description: '  BLUE BOTTLE ' },
    ]);
  });
  it('maps columns by index without a header', () => {
    const p: Partial<Profile> = {
      header: false,
      date: { column: 0, format: 'YYYY-MM-DD' },
      amount: { column: 2, negate: true },
      description: { column: 1 },
      memo: { column: 3 },
    };
    expect(map('2026-09-14,ACME,12.5,ref 7', p).rows[0]).toMatchObject({
      amount: { amount: -1250n, exp: 2 },
      memo: 'ref 7',
    });
  });
  it('fails on a missing or repeated header name, or a short row', () => {
    expect(() => map('Date,Amount\n2026-09-14,1')).toThrow(/not in the header/);
    expect(() => map('Date,Description,Amount,Description\n')).toThrow(/appears twice/);
    expect(() => map('Date,Description,Amount\n2026-09-14,x')).toThrow(/line 2/);
    expect(() => map('')).toThrow(/no header/);
  });
  it('fails the import on a bad date or amount, with the line', () => {
    expect(() => map('Date,Description,Amount\n09/14/2026,x,1')).toThrow(/line 2: date/);
    expect(() => map('Date,Description,Amount\n2026-09-14,x,1.234')).toThrow(/line 2: amount/);
  });
  it('skips blank, zero, and pending rows, and reports them', () => {
    const r = map('Date,Description,Amount,Status\n2026-09-14,a, ,\n2026-09-14,b,0.00,\n2026-09-14,c,-1,Pending\n2026-09-14,d,-1,', {
      pending: { column: 'Status', value: 'Pending' },
    });
    expect(r.skipped).toEqual([
      { line: 2, reason: 'no-amount' },
      { line: 3, reason: 'zero-amount' },
      { line: 4, reason: 'pending' },
    ]);
    expect(r.rows.map((x) => x.description)).toEqual(['d']);
  });
  it('combines debit and credit columns', () => {
    const p: Partial<Profile> = { amount: { debit: 'Debit', credit: 'Credit' } };
    const text = [
      'Date,Description,Debit,Credit',
      '2026-09-14,charge,5.00,',
      '2026-09-14,refund,,2.50',
      '2026-09-14,zero-filled,0.00,7',
      '2026-09-14,signed debit,-5.00,',
      '2026-09-14,both empty,,',
      '2026-09-14,both zero,0,0.00',
    ].join('\n');
    const r = map(text, p);
    expect(r.rows.map((x) => x.amount.amount)).toEqual([-500n, 250n, 700n, -500n]);
    expect(r.skipped).toEqual([
      { line: 6, reason: 'no-amount' },
      { line: 7, reason: 'zero-amount' },
    ]);
    expect(() => map('Date,Description,Debit,Credit\n2026-09-14,x,1,2', p)).toThrow(/both debit and credit/);
  });
  it('flags rows with a blank fitid, and fails on a repeated one', () => {
    const p: Partial<Profile> = { fitid: { column: 'Id' } };
    const r = map('Date,Description,Amount,Id\n2026-09-14,a,-1, AB1 \n2026-09-14,b,-2,  ', p);
    expect(r.rows).toMatchObject([{ description: 'a', fitid: 'AB1' }]);
    expect(r.flagged).toEqual([
      { line: 3, date: '2026-09-14', amount: { amount: -200n, exp: 2 }, description: 'b' },
    ]);
    expect(() => map('Date,Description,Amount,Id\n2026-09-14,a,-1,X\n2026-09-15,b,-1,X', p)).toThrow(/appears twice/);
  });
  it('reads the decimal comma', () => {
    const r = mapRows(parseCsv('Date;Description;Amount\n2026-09-14;x;-1.234,5', ';'), { ...base, delimiter: ';', decimal: ',' });
    expect(r.rows[0].amount).toEqual({ amount: -123450n, exp: 2 });
  });
});

describe('readStatement', () => {
  it('decodes, skips the preamble and trailer, and reports file lines', () => {
    const file = latin('Bank of Example\r\nDate,Description,Amount\r\n2026-09-14,Caf\xe9 Rouge,-4.50\r\nTotal,,-4.50\r\n');
    const r = readStatement(file, { ...base, encoding: 'windows-1252', skip_rows: 1, skip_end_rows: 1 });
    expect(r.rows).toEqual([
      { line: 3, date: '2026-09-14', amount: { amount: -450n, exp: 2 }, description: 'Café Rouge' },
    ]);
  });
  it('fails without skip_end_rows when a trailer is present', () => {
    const file = utf8('Date,Description,Amount\n2026-09-14,x,-1\nTotal,,-1\n');
    expect(() => readStatement(file, base)).toThrow(/line 3: date/);
  });
});
