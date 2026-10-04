/**
 * The keyed PRF behind every derived identifier. Spec and test vectors: design/LABELS.md
 * (0005). Pinned for the life of a space.
 *
 * The keys are derived once per session and held in memory only. Callers get one function
 * per namespace, which builds the input from typed fields, never `label(ns, s)` with a
 * free-form string.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { isCommodity } from './amount.js';
import { base64url, isAccountId, isMonth, type AccountId, type Label, type Month } from './ids.js';
import { isWellFormed } from './normalize.js';

/** The registered namespaces. Each one's input is pinned in LABELS.md. */
export const NAMESPACES = ['import/v1', 'allocation/v1', 'recon-session/v1', 'price/v1'] as const;
export type Namespace = (typeof NAMESPACES)[number];

declare const labelKeysBrand: unique symbol;

/** The per-namespace keys. Opaque, so a caller can't hash under a key by hand. */
export interface LabelKeys {
  readonly [labelKeysBrand]: true;
}

interface LabelKeysImpl {
  readonly ns: ReadonlyMap<Namespace, Uint8Array>;
}

const SPACE_ID_RE = /^S[A-Za-z0-9_-]{43}$/;
const utf8 = new TextEncoder();

/** `label_key` and every `ns_key`, derived once from the space's root. */
export function deriveLabelKeys(symmetricRoot: Uint8Array, spaceId: string): LabelKeys {
  if (symmetricRoot.length !== 32) throw new RangeError('symmetric_root must be 32 bytes');
  if (!SPACE_ID_RE.test(spaceId)) throw new RangeError('bad space ID');
  const labelKey = hkdf(sha256, symmetricRoot, undefined, `label key | ${spaceId}`, 32);
  const ns = new Map<Namespace, Uint8Array>();
  for (const name of NAMESPACES) ns.set(name, hkdf(sha256, labelKey, undefined, `label key | ${name}`, 32));
  const impl: LabelKeysImpl = { ns };
  return impl as unknown as LabelKeys;
}

/** `label(ns, s)`. `s` is hashed as UTF-8 with no normalization, and must be well-formed. */
function label(keys: LabelKeys, ns: Namespace, s: string): Label {
  if (!isWellFormed(s)) throw new RangeError('label input contains a lone surrogate');
  const key = (keys as unknown as LabelKeysImpl).ns.get(ns);
  if (!key) throw new RangeError(`unregistered namespace ${ns}`);
  return base64url(hmac(sha256, key, utf8.encode(s)).subarray(0, 15)) as Label;
}

/** `import/v1`. `input` comes from `importInputRow` or `importInputFitid`. */
export function importLabel(keys: LabelKeys, input: string): Label {
  return label(keys, 'import/v1', input);
}

/** `allocation/v1`: `{envelope}|{month}`, the `idem` of a materialized allocation. */
export function allocationLabel(keys: LabelKeys, envelope: AccountId, month: Month): Label {
  if (!isAccountId(envelope) || !isMonth(month)) throw new RangeError('allocationLabel: bad input');
  return label(keys, 'allocation/v1', `${envelope}|${month}`);
}

/** `recon-session/v1`: `{account}`. */
export function reconSessionLabel(keys: LabelKeys, account: AccountId): Label {
  if (!isAccountId(account)) throw new RangeError('reconSessionLabel: bad input');
  return label(keys, 'recon-session/v1', account);
}

/** `price/v1`: `{commodity}|{year}`. */
export function priceLabel(keys: LabelKeys, commodity: string, year: number): Label {
  if (!isCommodity(commodity) || !Number.isInteger(year) || year < 0 || year > 9999) {
    throw new RangeError('priceLabel: bad input');
  }
  return label(keys, 'price/v1', `${commodity}|${String(year).padStart(4, '0')}`);
}

/** Test hook: the raw `label(ns, s)`, for checking the vectors in LABELS.md. */
export const rawLabelForTests = label;

/** Test hook: an `ns_key`, for checking the vectors in LABELS.md. */
export function nsKeyForTests(keys: LabelKeys, ns: Namespace): Uint8Array {
  return (keys as unknown as LabelKeysImpl).ns.get(ns)!;
}
