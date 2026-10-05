/**
 * The CSV grammar pinned under `import/v1`: design/NORMALIZATION.md, "CSV grammar" (0020).
 * A parsed description cell is a label input, so the test vectors there are the spec, not
 * csv-parse's behavior. csv-parse is pinned to an exact version; an upgrade must pass every
 * vector. This is the only core module allowed to import it. It imports the browser build,
 * which bundles a `Buffer` polyfill, so tests run the same code the app ships.
 */

import { parse } from 'csv-parse/browser/esm/sync';
import { ParseError } from './errors.js';

export interface CsvRecord {
  readonly cells: readonly string[];
  /** The 1-based line of `text` the record starts on. */
  readonly line: number;
}

const LINE_BREAK = /\r\n|\r|\n/g;
const LEADING_BREAKS = /^(?:\r\n|\r|\n)*/;

function countBreaks(s: string): number {
  return s.match(LINE_BREAK)?.length ?? 0;
}

/** Parses decoded CSV text into records. Throws a `ParseError` on an unterminated quote. */
export function parseCsv(text: string, delimiter: string): CsvRecord[] {
  let rows: { record: string[]; raw: string }[];
  try {
    rows = parse(text, {
      delimiter,
      quote: '"',
      escape: '"',
      record_delimiter: ['\r\n', '\n', '\r'],
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true,
      bom: false,
      trim: false,
      raw: true,
    }) as unknown as { record: string[]; raw: string }[]; // the types don't model `raw`
  } catch (e) {
    throw new ParseError(`CSV: ${e instanceof Error ? e.message : String(e)}`);
  }
  // csv-parse's own line count treats a quoted CRLF as two lines, so count from `raw`, which
  // includes any empty lines skipped before the record.
  const out: CsvRecord[] = [];
  let line = 1;
  for (const { record, raw } of rows) {
    const lead = LEADING_BREAKS.exec(raw)?.[0] ?? '';
    line += countBreaks(lead);
    out.push({ cells: record, line });
    line += countBreaks(raw.slice(lead.length));
  }
  return out;
}
