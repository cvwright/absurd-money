/**
 * The `import/v1` normalization and label inputs. Spec and test vectors:
 * design/NORMALIZATION.md (0004). Pinned under `import/v1`: changing any step mints new
 * labels for rows already imported.
 */

import { canonical, type Decimal } from './amount.js';
import type { AccountId, IsoDate } from './ids.js';

// Built from a string: a literal U+2028 in a regex literal is a line terminator.
const WS_CLASS =
  '\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const WS_RUN = new RegExp(`[${WS_CLASS}]+`, 'g');
const WS_EDGES = new RegExp(`^[${WS_CLASS}]+|[${WS_CLASS}]+$`, 'g');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, 'g');

/** `String.prototype.isWellFormed`: no lone UTF-16 surrogates. */
export function isWellFormed(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

/** `String.prototype.toWellFormed`: each lone surrogate becomes U+FFFD. */
export function toWellFormed(s: string): string {
  return s.replace(LONE_SURROGATES, '\uFFFD');
}

/** Well-formed, NFKC, locale-free lowercase, whitespace collapsed and trimmed. */
export function normalizeDescription(s: string): string {
  return toWellFormed(s).normalize('NFKC').toLowerCase().replace(WS_RUN, ' ').replace(/^ | $/g, '');
}

/** Removes leading and trailing Unicode `White_Space`, the set above. */
export function trimWhitespace(s: string): string {
  return s.replace(WS_EDGES, '');
}

/** Well-formed and trimmed only. A `fitid` is an opaque token, so case is kept. */
export function normalizeFitid(s: string): string {
  return trimWhitespace(toWellFormed(s));
}

/** The row scheme: `{account}|{date}|{amount}|{description}|#{n}`. */
export function importInputRow(row: {
  account: AccountId;
  date: IsoDate;
  amount: Decimal;
  /** The raw cell; normalized here. */
  description: string;
  n: number;
}): string {
  if (!Number.isInteger(row.n) || row.n < 0) throw new RangeError('importInputRow: bad n');
  const desc = normalizeDescription(row.description);
  return `${row.account}|${row.date}|${canonical(row.amount)}|${desc}|#${row.n}`;
}

/** The `fitid` scheme: `{account}|fitid|{fitid}`. */
export function importInputFitid(account: AccountId, fitid: string): string {
  return `${account}|fitid|${normalizeFitid(fitid)}`;
}
