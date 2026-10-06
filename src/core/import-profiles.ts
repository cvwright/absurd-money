/**
 * CSV mapping profiles (`ledger/import-profiles` in design/SCHEMAS.md): the post-time
 * rules for rewriting the document, and the draft the profile editor works on (0022).
 *
 * A profile decides each row's `import/v1` label, so changing one can make rows already
 * imported look new. The scheme can never change once a profile exists; the editor warns
 * about the other changes that move labels.
 */

import type { Chart } from './chart.js';
import { decodeBytes, parseDate } from './csv-import.js';
import { parseCsv, type CsvRecord } from './csv.js';
import { ParseError } from './errors.js';
import type { AccountId } from './ids.js';
import { decodeProfile, type Column, type ImportProfilesDoc, type Profile, type ProfileEncoding } from './messages.js';
import { trimWhitespace } from './normalize.js';

/** The document before its first write. Its `rev` is 0; it is never written itself. */
export const EMPTY_PROFILES: ImportProfilesDoc = { v: 1, rev: 0, profiles: {} };

export function profileOf(doc: ImportProfilesDoc | undefined, account: AccountId): Profile | undefined {
  return doc && Object.hasOwn(doc.profiles, account) ? doc.profiles[account] : undefined;
}

/** Whether rows imported with `p` are labeled by their `fitid`. */
export const usesFitid = (p: Profile) => p.fitid !== undefined;

/** `doc` with `account`'s profile set to `profile`. */
export function withProfile(doc: ImportProfilesDoc, account: AccountId, profile: Profile): ImportProfilesDoc {
  return { ...doc, profiles: { ...doc.profiles, [account]: profile } };
}

/** Why `account` can't have a profile, or `undefined` if it can. */
function accountProblem(chart: Chart, account: AccountId): string | undefined {
  const a = chart.get(account);
  if (!a) return 'unknown account';
  if (a.closed_at !== undefined) return 'account is closed';
  if (a.type !== 'asset' && a.type !== 'liability') return 'not an asset or liability account';
  return undefined;
}

const sameProfile = (a: Profile, b: Profile) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Post-time rules for replacing `prev` with `next`: `rev` goes up by one; no profile is
 * removed; a profile never changes scheme (`fitid` or row), since one account's labels
 * must never mix them (0023); and every new or changed profile is for an open asset or
 * liability account. An unchanged profile isn't checked again, so closing its account
 * doesn't block other writes.
 */
export function profilesUpdateProblems(prev: ImportProfilesDoc, next: ImportProfilesDoc, chart: Chart): string[] {
  const problems: string[] = [];
  if (next.rev !== prev.rev + 1) problems.push(`rev must be ${prev.rev + 1}`);
  for (const [account, old] of Object.entries(prev.profiles) as [AccountId, Profile][]) {
    const p = profileOf(next, account);
    if (!p) problems.push(`${account}: profiles are never removed`);
    else if (usesFitid(p) !== usesFitid(old)) problems.push(`${account}: a profile never changes its import ID scheme`);
  }
  for (const [account, p] of Object.entries(next.profiles) as [AccountId, Profile][]) {
    const old = profileOf(prev, account);
    if (old && sameProfile(old, p)) continue;
    const problem = accountProblem(chart, account);
    if (problem) problems.push(`${account}: ${problem}`);
  }
  return problems;
}

/**
 * What a change to a profile does to rows already imported with it, for the editor to
 * warn about. Empty if nothing that feeds a label changed.
 */
export function relabelWarnings(old: Profile, next: Profile): string[] {
  const out: string[] = [];
  const col = (c: { column: Column } | undefined) => c?.column;
  if (usesFitid(old)) {
    if (col(old.fitid) !== col(next.fitid)) out.push('the ID column changed');
  } else {
    if (col(old.description) !== col(next.description)) out.push('the description column changed');
    if (JSON.stringify(old.amount) !== JSON.stringify(next.amount)) out.push('the amount columns or sign changed');
    if (col(old.date) !== col(next.date)) out.push('the date column changed');
  }
  if ((old.encoding ?? 'utf-8') !== (next.encoding ?? 'utf-8')) out.push('the encoding changed');
  return out;
}

// --- The editor's draft ---------------------------------------------------------------

/**
 * A profile as the editor holds it: every field present, columns as text. With a header,
 * a column is its name; without, its 0-based index written in decimal. Blank optional
 * columns are left out of the profile.
 */
export interface ProfileDraft {
  encoding: ProfileEncoding;
  delimiter: string;
  decimal: '.' | ',';
  skipRows: number;
  skipEndRows: number;
  header: boolean;
  date: string;
  dateFormat: string;
  amountMode: 'signed' | 'split';
  amount: string;
  negate: boolean;
  debit: string;
  credit: string;
  description: string;
  memo: string;
  fitid: string;
  pending: string;
  pendingValue: string;
  exp: number;
}

/** The profile a draft describes. Throws a `CodecError` naming the first bad field. */
export function draftProfile(d: ProfileDraft): Profile {
  const col = (s: string): Column => (d.header ? s.trim() : /^[0-9]+$/.test(s.trim()) ? Number(s.trim()) : s);
  const opt = (s: string) => (s.trim() === '' ? undefined : { column: col(s) });
  const memo = opt(d.memo);
  const fitid = opt(d.fitid);
  const pending = opt(d.pending);
  const candidate = {
    delimiter: d.delimiter,
    ...(d.decimal !== '.' && { decimal: d.decimal }),
    ...(d.encoding !== 'utf-8' && { encoding: d.encoding }),
    skip_rows: d.skipRows,
    ...(d.skipEndRows > 0 && { skip_end_rows: d.skipEndRows }),
    header: d.header,
    date: { column: col(d.date), format: d.dateFormat.trim() },
    amount: d.amountMode === 'signed'
      ? { column: col(d.amount), negate: d.negate }
      : { debit: col(d.debit), credit: col(d.credit) },
    description: { column: col(d.description) },
    ...(memo && { memo }),
    ...(fitid && { fitid }),
    ...(pending && { pending: { ...pending, value: d.pendingValue.trim() } }),
    exp: d.exp,
  };
  return decodeProfile(candidate, 'profile');
}

/** The draft for an existing profile. */
export function profileDraft(p: Profile): ProfileDraft {
  const s = (c: Column | undefined) => (c === undefined ? '' : String(c));
  return {
    encoding: p.encoding ?? 'utf-8',
    delimiter: p.delimiter,
    decimal: p.decimal ?? '.',
    skipRows: p.skip_rows,
    skipEndRows: p.skip_end_rows ?? 0,
    header: p.header,
    date: s(p.date.column),
    dateFormat: p.date.format,
    amountMode: 'column' in p.amount ? 'signed' : 'split',
    amount: 'column' in p.amount ? s(p.amount.column) : '',
    negate: 'column' in p.amount ? p.amount.negate : false,
    debit: 'debit' in p.amount ? s(p.amount.debit) : '',
    credit: 'credit' in p.amount ? s(p.amount.credit) : '',
    description: s(p.description.column),
    memo: s(p.memo?.column),
    fitid: s(p.fitid?.column),
    pending: s(p.pending?.column),
    pendingValue: p.pending?.value ?? '',
    exp: p.exp,
  };
}

/**
 * The encoding to suggest for a new profile: UTF-8 if the bytes are valid UTF-8, else
 * Windows-1252. Only ever a suggestion; it is stored in the profile and never guessed at
 * import time.
 */
export function guessEncoding(bytes: Uint8Array): ProfileEncoding {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  try {
    decodeBytes(bytes, 'utf-8');
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

const DELIMITERS = [',', ';', '\t', '|'];
const DATE_FORMATS = ['YYYY-MM-DD', 'MM/DD/YYYY', 'M/D/YYYY', 'DD/MM/YYYY', 'D/M/YYYY', 'DD.MM.YYYY', 'MM/DD/YY', 'M/D/YY', 'YYYYMMDD'];

const findName = (names: readonly string[], ...patterns: RegExp[]) => {
  for (const re of patterns) {
    const hit = names.find((n) => re.test(n));
    if (hit !== undefined) return hit;
  }
  return '';
};

/**
 * A first draft for a file, from its text: the delimiter that splits the first lines most
 * evenly, a header row, columns chosen by their names, and the first date format that
 * reads every date cell. Everything is for the user to check.
 */
export function guessDraft(bytes: Uint8Array, exp: number): ProfileDraft {
  const encoding = guessEncoding(bytes);
  const draft: ProfileDraft = {
    encoding, delimiter: ',', decimal: '.', skipRows: 0, skipEndRows: 0, header: true,
    date: '', dateFormat: 'YYYY-MM-DD', amountMode: 'signed', amount: '', negate: false, debit: '', credit: '',
    description: '', memo: '', fitid: '', pending: '', pendingValue: '', exp,
  };
  let text: string;
  try {
    text = decodeBytes(bytes, encoding);
  } catch {
    return draft;
  }
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '').slice(0, 20);
  const score = (d: string) => {
    const counts = lines.map((l) => l.split(d).length - 1);
    return counts.length && Math.min(...counts) > 0 ? Math.min(...counts) : 0;
  };
  draft.delimiter = DELIMITERS.reduce((best, d) => (score(d) > score(best) ? d : best), ',');

  let records: CsvRecord[];
  try {
    records = parseCsv(text, draft.delimiter);
  } catch {
    return draft;
  }
  if (!records.length) return draft;
  const names = records[0].cells.map(trimWhitespace);
  draft.date = findName(names, /^(posted|posting|transaction|trans\.?)? ?date$/i, /date/i);
  draft.description = findName(names, /^description$/i, /^(payee|merchant|name)$/i, /desc|payee|merchant|narrative/i);
  draft.memo = findName(names.filter((n) => n !== draft.description), /^(memo|details|notes?)$/i);
  draft.fitid = findName(names, /^(fitid|transaction id|reference|ref)$/i);
  draft.amount = findName(names, /^amount$/i, /amount/i);
  draft.debit = findName(names, /^(debit|withdrawals?|money out|charges?)/i);
  draft.credit = findName(names, /^(credit|deposits?|money in|payments?)/i);
  if (draft.amount === '' && draft.debit !== '' && draft.credit !== '') draft.amountMode = 'split';

  const col = names.indexOf(draft.date);
  if (col >= 0) {
    const cells = records.slice(1, 21).map((r) => r.cells[col] ?? '');
    const reads = (f: string) => cells.length > 0 && cells.every((c) => {
      try {
        parseDate(c, f);
        return true;
      } catch (e) {
        if (e instanceof ParseError) return false;
        throw e;
      }
    });
    draft.dateFormat = DATE_FORMATS.find(reads) ?? draft.dateFormat;
  }
  return draft;
}
