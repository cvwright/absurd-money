/**
 * Wrapping the space's keys at rest (0033).
 *
 * The private key and the symmetric root are encrypted under a key-encryption key (KEK)
 * derived from a passkey's WebAuthn PRF output. Each passkey gets its own wrapped copy,
 * named by its credential ID and carrying the PRF salt to evaluate it with. The KEK never
 * touches disk, and the PRF output can't be guessed, so nothing stored here can be
 * brute-forced.
 *
 * Version 1:
 *
 *     kek = HKDF-SHA256(ikm = prf_output, salt = empty, info = "absurd-money/kek/v1")
 *     aad = "absurd-money/keys/v1" \n space_id \n credential_id \n salt
 *     ct  = AES-256-GCM(kek, iv, private_key || symmetric_root, aad)
 *
 * The associated data binds a copy to its space and its passkey, so a copy can't be
 * swapped under another space's or another credential's entry. A later version may change
 * the derivation; `v` says which one a copy used.
 */

import { decodeUrlSafeBase64 } from 'reeeductio';
import { base64url } from '@/core/ids.js';

/** What opens the books, besides the space ID. */
export interface SpaceSecrets {
  readonly privateKey: Uint8Array;
  readonly symmetricRoot: Uint8Array;
}

/** One passkey's wrapped copy of the keys. Every byte string is unpadded base64url. */
export interface WrappedKeys {
  readonly v: 1;
  readonly credentialId: string;
  /** The PRF input this credential is evaluated with. */
  readonly salt: string;
  readonly iv: string;
  readonly ct: string;
}

/** The KEK did not open the copy: the wrong passkey, or a damaged or altered copy. */
export class UnwrapError extends Error {
  constructor(message = 'These keys could not be unlocked.') {
    super(message);
    this.name = 'UnwrapError';
  }
}

const KEK_INFO = 'absurd-money/kek/v1';
const AAD_PREFIX = 'absurd-money/keys/v1';
const KEY_BYTES = 32;

/** A fresh PRF input for a new passkey. */
export function newPrfSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Wraps `secrets` for the passkey `credentialId`, whose PRF output for `salt` is `prf`. */
export async function wrapKeys(
  prf: Uint8Array,
  secrets: SpaceSecrets,
  spaceId: string,
  credentialId: Uint8Array,
  salt: Uint8Array,
): Promise<WrappedKeys> {
  if (secrets.privateKey.length !== KEY_BYTES || secrets.symmetricRoot.length !== KEY_BYTES) {
    throw new Error('A private key and a symmetric root are 32 bytes each.');
  }
  const wrapped = {
    v: 1 as const,
    credentialId: base64url(credentialId),
    salt: base64url(salt),
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new Uint8Array(2 * KEY_BYTES);
  plain.set(secrets.privateKey);
  plain.set(secrets.symmetricRoot, KEY_BYTES);
  try {
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(spaceId, wrapped) },
      await kek(prf),
      plain,
    );
    return { ...wrapped, iv: base64url(iv), ct: base64url(new Uint8Array(ct)) };
  } finally {
    plain.fill(0);
  }
}

/** Unwraps a copy made by `wrapKeys` for `spaceId`. Throws `UnwrapError` if it doesn't open. */
export async function unwrapKeys(
  prf: Uint8Array,
  wrapped: WrappedKeys,
  spaceId: string,
): Promise<SpaceSecrets> {
  if (wrapped.v !== 1) throw new UnwrapError(`Unknown key format v${String(wrapped.v)}.`);
  let plain: Uint8Array;
  try {
    const out = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buffer(decodeUrlSafeBase64(wrapped.iv)), additionalData: aad(spaceId, wrapped) },
      await kek(prf),
      buffer(decodeUrlSafeBase64(wrapped.ct)),
    );
    plain = new Uint8Array(out);
  } catch {
    throw new UnwrapError();
  }
  if (plain.length !== 2 * KEY_BYTES) throw new UnwrapError();
  return { privateKey: plain.slice(0, KEY_BYTES), symmetricRoot: plain.slice(KEY_BYTES) };
}

/** A stored copy, checked field by field. Throws on anything else. */
export function parseWrappedKeys(value: unknown): WrappedKeys {
  const w = value as Partial<WrappedKeys> | null;
  if (typeof w !== 'object' || w === null) throw new Error('Wrapped keys must be an object.');
  if (w.v !== 1) throw new Error(`Unknown key format v${String(w.v)}.`);
  for (const field of ['credentialId', 'salt', 'iv', 'ct'] as const) {
    if (typeof w[field] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(w[field])) {
      throw new Error(`Wrapped keys have a bad ${field}.`);
    }
  }
  return { v: 1, credentialId: w.credentialId!, salt: w.salt!, iv: w.iv!, ct: w.ct! };
}

/** The AES-GCM key for a PRF output. Non-extractable, and used for nothing else. */
async function kek(prf: Uint8Array): Promise<CryptoKey> {
  if (prf.length !== KEY_BYTES) throw new UnwrapError('A PRF output is 32 bytes.');
  const raw = buffer(prf);
  const ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  raw.fill(0);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(KEK_INFO) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function aad(spaceId: string, w: Pick<WrappedKeys, 'credentialId' | 'salt'>): Uint8Array<ArrayBuffer> {
  return utf8([AAD_PREFIX, spaceId, w.credentialId, w.salt].join('\n'));
}

function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}

/** A copy backed by a plain `ArrayBuffer`, as WebCrypto's types require. */
function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}
