/**
 * Primitive wire types other than amounts, from "Primitive types" in design/SCHEMAS.md:
 * dates, months, message and blob IDs, random IDs, labels, and blob references.
 */

import { CodecError } from './errors.js';

export type IsoDate = string & { readonly __brand: 'IsoDate' };
export type Month = string & { readonly __brand: 'Month' };
export type MsgId = string & { readonly __brand: 'MsgId' };
export type LotId = string & { readonly __brand: 'LotId' };
export type AccountId = string & { readonly __brand: 'AccountId' };
export type PayeeId = string & { readonly __brand: 'PayeeId' };
export type RuleId = string & { readonly __brand: 'RuleId' };
export type EnvelopeId = string & { readonly __brand: 'EnvelopeId' };
export type Label = string & { readonly __brand: 'Label' };
export type BlobId = string & { readonly __brand: 'BlobId' };

export interface BlobRef {
  readonly blob: BlobId;
  readonly dek: string;
}

const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MONTH_RE = /^([0-9]{4})-([0-9]{2})$/;
const MSG_ID_RE = /^M[A-Za-z0-9_-]{43}$/;
const LOT_ID_RE = /^(M[A-Za-z0-9_-]{43})#(0|[1-9][0-9]*)$/;
const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9_-]{20}$/;
const PAYEE_ID_RE = /^payee_[A-Za-z0-9_-]{20}$/;
const RULE_ID_RE = /^rule_[A-Za-z0-9_-]{20}$/;
const ENVELOPE_ID_RE = /^env_[A-Za-z0-9_-]{20}$/;
const LABEL_RE = /^[A-Za-z0-9_-]{20}$/;
const BLOB_ID_RE = /^B[A-Za-z0-9_-]{43}$/;
const DEK_RE = /^[A-Za-z0-9_-]{43}$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isIsoDate(s: unknown): s is IsoDate {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(Number(m[1]), month);
}

export function isMonth(s: unknown): s is Month {
  if (typeof s !== 'string') return false;
  const m = MONTH_RE.exec(s);
  return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

export const isMsgId = (s: unknown): s is MsgId => typeof s === 'string' && MSG_ID_RE.test(s);
export const isLotId = (s: unknown): s is LotId => typeof s === 'string' && LOT_ID_RE.test(s);
export const isAccountId = (s: unknown): s is AccountId =>
  typeof s === 'string' && ACCOUNT_ID_RE.test(s);
export const isPayeeId = (s: unknown): s is PayeeId => typeof s === 'string' && PAYEE_ID_RE.test(s);
export const isRuleId = (s: unknown): s is RuleId => typeof s === 'string' && RULE_ID_RE.test(s);
export const isEnvelopeId = (s: unknown): s is EnvelopeId =>
  typeof s === 'string' && ENVELOPE_ID_RE.test(s);
export const isLabel = (s: unknown): s is Label => typeof s === 'string' && LABEL_RE.test(s);
export const isBlobId = (s: unknown): s is BlobId => typeof s === 'string' && BLOB_ID_RE.test(s);
export const isDek = (s: unknown): s is string => typeof s === 'string' && DEK_RE.test(s);

/** The year of a `Date`. */
export function yearOf(date: IsoDate): number {
  return Number(date.slice(0, 4));
}

/** The `Month` a `Date` falls in. */
export function monthOf(date: IsoDate): Month {
  return date.slice(0, 7) as Month;
}

/** The lot created by split `index` of the entry `msg`. */
export function lotId(msg: MsgId, index: number): LotId {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('lotId: bad split index');
  return `${msg}#${index}` as LotId;
}

export function parseLotId(lot: LotId): { msg: MsgId; index: number } {
  const m = LOT_ID_RE.exec(lot);
  if (!m) throw new CodecError('expected a LotId');
  return { msg: m[1] as MsgId, index: Number(m[2]) };
}

// --- Random IDs -----------------------------------------------------------------------

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url (RFC 4648 §5) with no padding. */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

/** The 20 characters of a random or PRF identifier, from exactly 15 bytes. */
export function id20(bytes: Uint8Array): string {
  if (bytes.length !== 15) throw new RangeError('identifiers are exactly 15 bytes');
  return base64url(bytes);
}

/**
 * New random IDs. The caller supplies 15 bytes from a CSPRNG
 * (`crypto.getRandomValues(new Uint8Array(15))`), so the core stays deterministic.
 * Account IDs are random, never derived from names.
 */
export const newAccountId = (random15: Uint8Array) => `acct_${id20(random15)}` as AccountId;
export const newPayeeId = (random15: Uint8Array) => `payee_${id20(random15)}` as PayeeId;
export const newRuleId = (random15: Uint8Array) => `rule_${id20(random15)}` as RuleId;
export const newEnvelopeId = (random15: Uint8Array) => `env_${id20(random15)}` as EnvelopeId;

// --- Segments -------------------------------------------------------------------------

const SEGMENT_RE = /^journal-([0-9]{4})$/;

/** The `journal-YYYY` topic an entry with this date routes to. */
export function segmentFor(date: IsoDate): string {
  return `journal-${date.slice(0, 4)}`;
}

/** The year of a `journal-YYYY` topic, or `undefined` if the topic isn't a segment. */
export function segmentYear(topic: string): number | undefined {
  const m = SEGMENT_RE.exec(topic);
  return m ? Number(m[1]) : undefined;
}
