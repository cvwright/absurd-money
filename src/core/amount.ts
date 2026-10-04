/**
 * The amount codec: representation, strict decoding, exact arithmetic, text parsing, and
 * the canonical decimal form. Spec and test vectors: design/AMOUNTS.md (0002).
 *
 * Nothing here rounds. Every operation is exact or throws. Rounding lives in rounding.ts.
 */

import { CodecError, ParseError } from './errors.js';

export type Commodity = string & { readonly __brand: 'Commodity' };

/** An integer at a decimal exponent, with no commodity: `amount × 10^-exp`. */
export interface Decimal {
  readonly amount: bigint;
  readonly exp: number;
}

export interface Amount extends Decimal {
  readonly cur: Commodity;
}

export interface WireAmount {
  amount: string;
  exp: number;
  cur: string;
}

export const MAX_EXP = 30;

const INT_RE = /^-?(0|[1-9][0-9]*)$/;
const COMMODITY_RE = /^[A-Z0-9][A-Z0-9._-]{0,15}$/;

// --- Decoding -------------------------------------------------------------------------

export function decodeInt(s: unknown, path = ''): bigint {
  if (typeof s !== 'string' || !INT_RE.test(s) || s === '-0') {
    throw new CodecError('expected an Int string', path);
  }
  return BigInt(s);
}

export function decodePosInt(s: unknown, path = ''): bigint {
  const n = decodeInt(s, path);
  if (n <= 0n) throw new CodecError('expected a positive Int string', path);
  return n;
}

export function decodeExp(n: unknown, path = ''): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_EXP) {
    throw new CodecError(`expected an integer exponent from 0 to ${MAX_EXP}`, path);
  }
  return n;
}

export function isCommodity(s: unknown): s is Commodity {
  return typeof s === 'string' && COMMODITY_RE.test(s);
}

export function decodeCommodity(s: unknown, path = ''): Commodity {
  if (!isCommodity(s)) throw new CodecError('expected a Commodity', path);
  return s;
}

/** Validates a commodity code written in source, such as a test or a default. */
export function commodity(s: string): Commodity {
  return decodeCommodity(s);
}

/** Decodes an `Amount` object with exactly the fields `amount`, `exp`, and `cur`. */
export function decodeAmount(w: unknown, path = ''): Amount {
  if (typeof w !== 'object' || w === null || Array.isArray(w)) {
    throw new CodecError('expected an Amount object', path);
  }
  const keys = Object.keys(w);
  for (const k of keys) {
    if (k !== 'amount' && k !== 'exp' && k !== 'cur') {
      throw new CodecError(`unknown field "${k}"`, path);
    }
  }
  const o = w as Record<string, unknown>;
  const at = (k: string) => (path ? `${path}.${k}` : k);
  return {
    amount: decodeInt(o.amount, at('amount')),
    exp: decodeExp(o.exp, at('exp')),
    cur: decodeCommodity(o.cur, at('cur')),
  };
}

export function encodeAmount(a: Amount): WireAmount {
  return { amount: a.amount.toString(), exp: a.exp, cur: a.cur };
}

// --- Arithmetic -----------------------------------------------------------------------

const POW10: bigint[] = [];
for (let i = 0, p = 1n; i <= 2 * MAX_EXP + 1; i++, p *= 10n) POW10.push(p);

/** `10n ** n`, cached for the exponents amounts use. */
export function pow10(n: number): bigint {
  return POW10[n] ?? 10n ** BigInt(n);
}

/** The integer of `a` at the larger exponent `exp`. Exact, since it only scales up. */
function scaledInt(a: Decimal, exp: number): bigint {
  return a.amount * pow10(exp - a.exp);
}

function sameCur(a: Amount, b: Amount, op: string): void {
  if (a.cur !== b.cur) throw new TypeError(`${op}: ${a.cur} and ${b.cur} are different commodities`);
}

export function neg<T extends Decimal>(a: T): T {
  return { ...a, amount: -a.amount };
}

export function add(a: Amount, b: Amount): Amount {
  sameCur(a, b, 'add');
  const exp = Math.max(a.exp, b.exp);
  return { amount: scaledInt(a, exp) + scaledInt(b, exp), exp, cur: a.cur };
}

export function sub(a: Amount, b: Amount): Amount {
  return add(a, neg(b));
}

/** Compares two decimals by value, ignoring any commodity. */
export function cmpDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const exp = Math.max(a.exp, b.exp);
  const x = scaledInt(a, exp);
  const y = scaledInt(b, exp);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function cmp(a: Amount, b: Amount): -1 | 0 | 1 {
  sameCur(a, b, 'cmp');
  return cmpDecimal(a, b);
}

/** Value equality. Amounts in different commodities are never equal. */
export function eq(a: Amount, b: Amount): boolean {
  return a.cur === b.cur && cmpDecimal(a, b) === 0;
}

export function isZero(a: Decimal): boolean {
  return a.amount === 0n;
}

/** Rescales exactly. Throws if `exp` is out of range or scaling down would lose digits. */
export function rescale<T extends Decimal>(a: T, exp: number): T {
  if (!Number.isInteger(exp) || exp < 0 || exp > MAX_EXP) {
    throw new RangeError(`rescale: exponent ${exp} is out of range`);
  }
  if (exp >= a.exp) return { ...a, amount: scaledInt(a, exp), exp };
  const d = pow10(a.exp - exp);
  if (a.amount % d !== 0n) throw new RangeError('rescale: inexact');
  return { ...a, amount: a.amount / d, exp };
}

/** Sums per commodity. A commodity that never appears is absent, not zero. */
export function sumByCommodity(xs: Iterable<Amount>): Map<Commodity, Amount> {
  const out = new Map<Commodity, Amount>();
  for (const x of xs) {
    const prev = out.get(x.cur);
    out.set(x.cur, prev ? add(prev, x) : { amount: x.amount, exp: x.exp, cur: x.cur });
  }
  return out;
}

export function sumsToZero(xs: Iterable<Amount>): boolean {
  for (const s of sumByCommodity(xs).values()) if (!isZero(s)) return false;
  return true;
}

/** The number of fractional digits a value needs once trailing zeros are dropped. */
export function digitsNeeded(a: Decimal): number {
  if (a.amount === 0n) return 0;
  let n = a.amount < 0n ? -a.amount : a.amount;
  let exp = a.exp;
  while (exp > 0 && n % 10n === 0n) {
    n /= 10n;
    exp--;
  }
  return exp;
}

/** Rescales to the writer's convention: `max(minExp, digits needed)`. Never loses digits. */
export function writerExp<T extends Decimal>(a: T, minExp: number): T {
  return rescale(a, Math.max(minExp, digitsNeeded(a)));
}

// --- Canonical decimal form -----------------------------------------------------------

/**
 * The shortest exact decimal spelling of a value, independent of its exponent. Pinned
 * under `import/v1`: it is hashed into import labels.
 */
export function canonical(a: Decimal): string {
  if (a.amount === 0n) return '0';
  const negative = a.amount < 0n;
  const digits = (negative ? -a.amount : a.amount).toString().padStart(a.exp + 1, '0');
  const intPart = digits.slice(0, digits.length - a.exp);
  const frac = digits.slice(digits.length - a.exp).replace(/0+$/, '');
  return (negative ? '-' : '') + intPart + (frac ? `.${frac}` : '');
}

// --- Parsing text ---------------------------------------------------------------------

export type ParseOptions = { decimal: '.' | ',' } & ({ exp: number } | { minExp: number });

// Unicode White_Space, the same set as design/NORMALIZATION.md.
const WS_CLASS =
  '\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const TRIM_RE = new RegExp(`^[${WS_CLASS}]+|[${WS_CLASS}]+$`, 'g');
const CUR_START_RE = /^\p{Sc}/u;
const CUR_END_RE = /\p{Sc}$/u;
const DIGITS_RE = /^[0-9]*$/;
const GROUP_SEPS = ["'", ' ', '\u00A0', '\u202F'];

function trimWs(s: string): string {
  return s.replace(TRIM_RE, '');
}

/**
 * Parses an amount typed by the user or read from a CSV cell. Never rounds: the result is
 * exact or this throws a `ParseError`. Not pinned; see "Parsing text" in AMOUNTS.md.
 */
export function parseDecimal(text: string, opts: ParseOptions): Decimal {
  let s = trimWs(text);
  let negative = false;
  let signs = 0;
  let symbols = 0;

  // Peel the sign and the currency symbol off, outside in, in either order.
  for (;;) {
    if (symbols === 0 && CUR_START_RE.test(s)) {
      s = trimWs(s.slice(1));
      symbols++;
    } else if (symbols === 0 && CUR_END_RE.test(s)) {
      s = trimWs(s.slice(0, -1));
      symbols++;
    } else if (signs === 0 && (s[0] === '-' || s[0] === '\u2212' || s[0] === '+')) {
      negative = s[0] !== '+';
      s = s.slice(1);
      signs++;
    } else if (signs === 0 && s.length > 1 && s.endsWith('-')) {
      negative = true;
      s = s.slice(0, -1);
      signs++;
    } else if (signs === 0 && s.length > 1 && s.startsWith('(') && s.endsWith(')')) {
      negative = true;
      s = s.slice(1, -1);
      signs++;
    } else {
      break;
    }
  }

  const parts = s.split(opts.decimal);
  if (parts.length > 2) throw new ParseError('more than one decimal separator');
  const intText = parts[0];
  const fracText = parts[1];
  if (fracText !== undefined && (fracText === '' || !DIGITS_RE.test(fracText))) {
    throw new ParseError('the decimal separator must be followed by digits');
  }
  const intDigits = parseIntegerPart(intText, opts.decimal === '.' ? ',' : '.');
  let frac = fracText ?? '';
  if (intDigits === '' && frac === '') throw new ParseError('no digits');

  let exp: number;
  if ('exp' in opts) {
    exp = opts.exp;
    if (!Number.isInteger(exp) || exp < 0 || exp > MAX_EXP) {
      throw new RangeError(`parseDecimal: exponent ${exp} is out of range`);
    }
    if (frac.length > exp) {
      if (!/^0*$/.test(frac.slice(exp))) throw new ParseError('more precision than allowed');
      frac = frac.slice(0, exp);
    }
  } else {
    frac = frac.replace(/0+$/, '');
    exp = Math.max(opts.minExp, frac.length);
    if (exp > MAX_EXP) throw new ParseError(`more than ${MAX_EXP} fractional digits`);
  }
  frac = frac.padEnd(exp, '0');

  const n = BigInt((intDigits || '0') + frac);
  return { amount: negative ? -n : n, exp };
}

/** Returns the digits of the integer part, after checking its grouping. */
function parseIntegerPart(s: string, otherSep: string): string {
  if (DIGITS_RE.test(s)) return s;
  const seps = [otherSep, ...GROUP_SEPS];
  const used = new Set<string>();
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') continue;
    if (!seps.includes(ch)) throw new ParseError(`unexpected character "${ch}"`);
    used.add(ch);
  }
  if (used.size > 1) throw new ParseError('more than one kind of grouping separator');
  const [sep] = used;
  const groups = s.split(sep);
  const ok = groups.every((g, i) => {
    if (!/^[0-9]+$/.test(g)) return false;
    if (i === 0) return g.length <= 3;
    if (i === groups.length - 1) return g.length === 3;
    return g.length === 2 || g.length === 3;
  });
  if (!ok) throw new ParseError('bad digit grouping');
  return groups.join('');
}

// --- Minor units ----------------------------------------------------------------------

// ISO 4217 minor units. Only sets defaults and display, never validity, so updating it is
// always safe. Codes not listed, and anything that isn't a currency, are 0.
const MINOR_2 =
  'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BOV BRL BSD BTN ' +
  'BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUC CUP CVE CZK DKK DOP DZD EGP ERN ' +
  'ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IRR JMD ' +
  'KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR ' +
  'MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB ' +
  'SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY ' +
  'TTD TWD TZS UAH USD USN UZS VED VES WST XCD XCG YER ZAR ZMW ZWG';
const MINOR_3 = 'BHD IQD JOD KWD LYD OMR TND';
const MINOR_4 = 'CLF UYW';

const MINOR = new Map<string, number>();
for (const [codes, n] of [[MINOR_2, 2], [MINOR_3, 3], [MINOR_4, 4]] as const) {
  for (const c of codes.split(' ')) MINOR.set(c, n);
}

/** The ISO 4217 minor unit of a currency, or 0 for anything else. */
export function minor(cur: Commodity): number {
  return MINOR.get(cur) ?? 0;
}
