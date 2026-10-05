/**
 * Reading a CSV statement with an account's import profile: decoding the bytes, skipping
 * lines, and mapping records to rows. Spec: "Reading a file" under `ledger/import-profiles`
 * in design/SCHEMAS.md (0020). Decoding and the CSV grammar feed `import/v1` labels and
 * are pinned; the label itself is computed in normalize.ts (0023).
 */

import { isZero, neg, parseDecimal, type Decimal } from './amount.js';
import { parseCsv, type CsvRecord } from './csv.js';
import { ParseError } from './errors.js';
import { isIsoDate, type IsoDate } from './ids.js';
import { DATE_FORMAT_TOKEN, type Column, type Profile, type ProfileEncoding } from './messages.js';
import { normalizeFitid, trimWhitespace } from './normalize.js';

/** A row ready for review. Text cells are raw; normalization happens in the label input. */
export interface ImportRow {
  /** The 1-based line of the file the row starts on. */
  readonly line: number;
  readonly date: IsoDate;
  /** Signed as posted to the account: positive is a debit. */
  readonly amount: Decimal;
  readonly description: string;
  readonly memo?: string;
  /** Normalized (`normalizeFitid`), present only in a `fitid` profile. */
  readonly fitid?: string;
}

export type SkipReason = 'no-amount' | 'zero-amount' | 'pending';

export interface SkippedRow {
  readonly line: number;
  readonly reason: SkipReason;
}

export interface MappedRows {
  readonly rows: ImportRow[];
  readonly skipped: SkippedRow[];
  /** Rows with a blank `fitid` in a `fitid` profile, for manual entry. Never imported. */
  readonly flagged: Omit<ImportRow, 'fitid'>[];
}

// --- Decoding -------------------------------------------------------------------------

/**
 * Decodes a file's bytes with the profile's encoding. Never guesses. A file that isn't
 * valid in the encoding throws, and so does valid, non-ASCII UTF-8 under `windows-1252`,
 * which would otherwise decode silently as mojibake. A leading BOM is removed only when it
 * matches the encoding.
 */
export function decodeBytes(bytes: Uint8Array, encoding: ProfileEncoding = 'utf-8'): string {
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new ParseError(`the file is not valid ${encoding}; check the profile's encoding`);
  }
  if (encoding === 'windows-1252' && bytes.some((b) => b >= 0x80) && isUtf8(bytes)) {
    throw new ParseError('the file looks like UTF-8, but the profile says windows-1252');
  }
  return text;
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// --- Lines ----------------------------------------------------------------------------

/**
 * Removes `skipStart` physical lines from the start and `skipEnd` from the end, before CSV
 * parsing, so a preamble or trailer needn't be valid CSV. Trailing empty lines aren't
 * counted. Slices rather than splits, so line breaks inside quoted cells are kept as is.
 */
export function skipLines(
  text: string,
  skipStart: number,
  skipEnd: number,
): { text: string; firstLine: number } {
  const lines: { start: number; end: number }[] = [];
  const re = /\r\n|\r|\n/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    lines.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  if (start < text.length) lines.push({ start, end: text.length });
  while (lines.length && lines[lines.length - 1].start === lines[lines.length - 1].end) lines.pop();

  const kept = lines.slice(skipStart, Math.max(skipStart, lines.length - skipEnd));
  if (!kept.length) return { text: '', firstLine: skipStart + 1 };
  return { text: text.slice(kept[0].start, kept[kept.length - 1].end), firstLine: skipStart + 1 };
}

// --- Dates ----------------------------------------------------------------------------

const TOKEN_PATTERN: Record<string, string> = {
  YYYY: '([0-9]{4})',
  YY: '([0-9]{2})',
  MM: '([0-9]{2})',
  DD: '([0-9]{2})',
  M: '([0-9]{1,2})',
  D: '([0-9]{1,2})',
};

/** Parses a date cell with a profile's date format. `YY` is 20YY. */
export function parseDate(cell: string, format: string): IsoDate {
  const tokens = format.match(DATE_FORMAT_TOKEN) ?? [];
  const fields: string[] = [];
  const pattern = tokens
    .map((t) => {
      if (t in TOKEN_PATTERN) {
        fields.push(t);
        return TOKEN_PATTERN[t];
      }
      return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  const m = new RegExp(`^${pattern}$`).exec(trimWhitespace(cell));
  if (!m) throw new ParseError(`date "${cell}" doesn't match the format ${format}`);
  let y = '';
  let mo = '';
  let d = '';
  fields.forEach((f, i) => {
    const v = m[i + 1];
    if (f === 'YYYY') y = v;
    else if (f === 'YY') y = `20${v}`;
    else if (f[0] === 'M') mo = v.padStart(2, '0');
    else d = v.padStart(2, '0');
  });
  const iso = `${y}-${mo}-${d}`;
  if (!isIsoDate(iso)) throw new ParseError(`date "${cell}" is not a calendar date`);
  return iso;
}

// --- Mapping --------------------------------------------------------------------------

/**
 * Maps parsed records to rows with an account's profile. `firstLine` is the file line the
 * records' text starts on, after `skip_rows`. Throws a `ParseError` for anything that
 * fails the import: a missing column, a bad date or amount, both debit and credit filled,
 * or a repeated `fitid`.
 */
export function mapRows(records: readonly CsvRecord[], profile: Profile, firstLine = 1): MappedRows {
  const fileLine = (r: CsvRecord) => r.line + firstLine - 1;
  let data = records;
  let index: (c: Column) => number = (c) => c as number;

  if (profile.header) {
    if (!records.length) throw new ParseError('no header row');
    const names = records[0].cells.map(trimWhitespace);
    index = (c) => {
      const i = names.indexOf(c as string);
      if (i < 0) throw new ParseError(`column "${c}" is not in the header`);
      if (names.indexOf(c as string, i + 1) >= 0) throw new ParseError(`column "${c}" appears twice in the header`);
      return i;
    };
    data = records.slice(1);
  }

  const amount = profile.amount;
  const col = {
    date: index(profile.date.column),
    description: index(profile.description.column),
    memo: profile.memo && index(profile.memo.column),
    fitid: profile.fitid && index(profile.fitid.column),
    pending: profile.pending && index(profile.pending.column),
    amount: 'column' in amount ? index(amount.column) : undefined,
    debit: 'debit' in amount ? index(amount.debit) : undefined,
    credit: 'credit' in amount ? index(amount.credit) : undefined,
  };
  const width = Math.max(...Object.values(col).filter((i) => i !== undefined)) + 1;
  const opts = { decimal: profile.decimal ?? '.', exp: profile.exp } as const;

  const out: MappedRows = { rows: [], skipped: [], flagged: [] };
  const fitids = new Set<string>();
  for (const r of data) {
    const line = fileLine(r);
    const fail = (msg: string): never => {
      throw new ParseError(`line ${line}: ${msg}`);
    };
    const at = <T>(msg: string, f: () => T): T => {
      try {
        return f();
      } catch (e) {
        if (e instanceof ParseError) return fail(`${msg}: ${e.message}`);
        throw e;
      }
    };
    if (r.cells.length < width) fail(`expected at least ${width} cells, got ${r.cells.length}`);
    const cell = (i: number) => r.cells[i];

    if (col.pending !== undefined && trimWhitespace(cell(col.pending)) === profile.pending!.value) {
      out.skipped.push({ line, reason: 'pending' });
      continue;
    }

    let value: Decimal | undefined;
    if (col.amount !== undefined) {
      const text = cell(col.amount);
      if (trimWhitespace(text) !== '') {
        value = at('amount', () => parseDecimal(text, opts));
        if ('negate' in amount && amount.negate) value = neg(value);
      }
    } else {
      // A blank or zero cell is empty. The sign in either cell is ignored: debit lowers the
      // posted amount, credit raises it.
      const read = (i: number, name: string) => {
        const text = cell(i);
        if (trimWhitespace(text) === '') return undefined;
        const v = at(name, () => parseDecimal(text, opts));
        return isZero(v) ? 'zero' : { ...v, amount: v.amount < 0n ? -v.amount : v.amount };
      };
      const debit = read(col.debit!, 'debit');
      const credit = read(col.credit!, 'credit');
      if (typeof debit === 'object' && typeof credit === 'object') fail('both debit and credit are filled');
      if (typeof debit === 'object') value = neg(debit);
      else if (typeof credit === 'object') value = credit;
      else if (debit === 'zero' || credit === 'zero') value = { amount: 0n, exp: profile.exp };
    }
    if (value === undefined) {
      out.skipped.push({ line, reason: 'no-amount' });
      continue;
    }
    if (isZero(value)) {
      out.skipped.push({ line, reason: 'zero-amount' });
      continue;
    }

    const row = {
      line,
      date: at('date', () => parseDate(cell(col.date), profile.date.format)),
      amount: value,
      description: cell(col.description),
      ...(col.memo !== undefined && { memo: cell(col.memo) }),
    };
    if (col.fitid === undefined) {
      out.rows.push(row);
      continue;
    }
    const fitid = normalizeFitid(cell(col.fitid));
    if (fitid === '') {
      out.flagged.push(row);
      continue;
    }
    if (fitids.has(fitid)) fail(`fitid "${fitid}" appears twice in the file`);
    fitids.add(fitid);
    out.rows.push({ ...row, fitid });
  }
  return out;
}

/** Decodes, skips lines, parses, and maps a statement file with an account's profile. */
export function readStatement(bytes: Uint8Array, profile: Profile): MappedRows {
  const { text, firstLine } = skipLines(
    decodeBytes(bytes, profile.encoding),
    profile.skip_rows,
    profile.skip_end_rows ?? 0,
  );
  return mapRows(parseCsv(text, profile.delimiter), profile, firstLine);
}
