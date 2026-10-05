/**
 * Space credentials: creating a new space's keys, the recovery key that moves them to
 * another device, and keeping them on this device wrapped at rest (0033).
 *
 * A space is an Ed25519 key pair plus a 32-byte symmetric root, and its ID is the public
 * key. Whoever holds the private key and the root can read and write the whole book, so
 * neither is ever stored in the clear. This device keeps, in IndexedDB, only the space ID,
 * the server, whether a password is set, and one wrapped copy of the keys per passkey
 * (key-wrap.ts). The books open with:
 *
 * - a passkey, whose PRF output unwraps that passkey's copy, offline;
 * - the password, by OPAQUE against the server, which holds the keys wrapped under the
 *   password's export key and can't guess the password without its OPRF key;
 * - the recovery key, shown once at creation and never sent anywhere.
 *
 * Before 0033 the keys sat in localStorage in the clear. `loadLegacyCredentials` reads
 * them so they can be protected, and `clearLegacyCredentials` deletes them once they are.
 */

import {
  AuthenticationError,
  extractPublicKey,
  generateKeyPair,
  getIdentifierType,
  IdType,
  OpaqueError,
  OpaqueNotEnabledError,
  OpaqueRateLimitError,
  performOpaqueLogin,
  decodeBase64,
  decodeUrlSafeBase64,
  signData,
  toSpaceId,
  verifySignature,
  type KeyPair,
} from 'reeeductio';
import { evaluatePasskey, type PrfResult } from './passkey.js';
import { parseWrappedKeys, unwrapKeys, wrapKeys, type WrappedKeys } from './key-wrap.js';

export interface SpaceCredentials {
  readonly spaceId: string;
  readonly keyPair: KeyPair;
  readonly symmetricRoot: Uint8Array;
  readonly baseUrl: string;
}

/**
 * The OPAQUE username of the books' owner. A literal, never user input, since it appears
 * in the path `opaque/users/{username}`. Other members (0031) will get their own.
 */
export const OWNER_USERNAME = 'owner';

/** What this device remembers about its books. Nothing here opens them. */
export interface SavedBooks {
  readonly v: 1;
  readonly spaceId: string;
  readonly baseUrl: string;
  /** The owner has an OPAQUE password on the server. */
  readonly password: boolean;
  /** One wrapped copy of the keys per passkey registered on this device. */
  readonly passkeys: readonly WrappedKeys[];
}

/**
 * Fresh keys for a new space. The server creates the space on first authentication
 * (with `auto_create_spaces`); otherwise an admin must register it first.
 */
export async function generateCredentials(baseUrl: string): Promise<SpaceCredentials> {
  const keyPair = await generateKeyPair();
  const symmetricRoot = crypto.getRandomValues(new Uint8Array(32));
  return { spaceId: toSpaceId(keyPair.publicKey), keyPair, symmetricRoot, baseUrl };
}

/** The private key then the symmetric root, as 128 hex digits. Same format as the music app. */
export function recoveryKey(creds: SpaceCredentials): string {
  return toHex(creds.keyPair.privateKey) + toHex(creds.symmetricRoot);
}

/** A trimmed space ID, or throws if `spaceId` isn't one. */
export function checkSpaceId(spaceId: string): string {
  spaceId = spaceId.trim();
  let isSpace = false;
  try {
    isSpace = getIdentifierType(spaceId) === IdType.SPACE;
  } catch {
    // Not a typed ID at all; reported below.
  }
  if (!isSpace) throw new Error('That is not a space ID.');
  return spaceId;
}

/**
 * Credentials for the space's creator, from its ID and recovery key. The creator's public
 * key is the space ID's. Other members (0031) will need their own user ID here.
 */
export function credentialsFromRecoveryKey(
  spaceId: string,
  key: string,
  baseUrl: string,
): SpaceCredentials {
  spaceId = checkSpaceId(spaceId);
  key = key.trim();
  if (!/^[0-9a-fA-F]{128}$/.test(key)) {
    throw new Error('A recovery key is 128 hexadecimal digits.');
  }
  return {
    spaceId,
    keyPair: { privateKey: fromHex(key.slice(0, 64)), publicKey: extractPublicKey(spaceId) },
    symmetricRoot: fromHex(key.slice(64)),
    baseUrl,
  };
}

/** Opens the books with the recovery key, after checking it is these books' key. */
export async function unlockWithRecoveryKey(
  spaceId: string,
  key: string,
  baseUrl: string,
): Promise<SpaceCredentials> {
  const creds = credentialsFromRecoveryKey(spaceId, key, baseUrl);
  try {
    return await withSecrets(creds.spaceId, baseUrl, creds.keyPair.privateKey, creds.symmetricRoot);
  } catch (err) {
    throw new Error('That recovery key is not for these books.', { cause: err });
  }
}

/** Opens the books with one of their passkeys on this device. Call it from a click. */
export async function unlockWithPasskey(books: SavedBooks): Promise<SpaceCredentials> {
  const used = await evaluatePasskey(
    books.passkeys.map((w) => ({
      credentialId: decodeUrlSafeBase64(w.credentialId),
      salt: decodeUrlSafeBase64(w.salt),
    })),
  );
  const wrapped = books.passkeys.find((w) => sameBytes(decodeUrlSafeBase64(w.credentialId), used.credentialId))!;
  let secrets;
  try {
    secrets = await unwrapKeys(used.prf, wrapped, books.spaceId);
  } finally {
    used.prf.fill(0);
  }
  return withSecrets(books.spaceId, books.baseUrl, secrets.privateKey, secrets.symmetricRoot);
}

/** Opens the books with the owner's password, by OPAQUE. Needs the server. */
export async function unlockWithPassword(
  spaceId: string,
  baseUrl: string,
  password: string,
): Promise<SpaceCredentials> {
  spaceId = checkSpaceId(spaceId);
  let recovered;
  try {
    recovered = await performOpaqueLogin({
      fetchFn: fetch.bind(window),
      baseUrl,
      spaceId,
      username: OWNER_USERNAME,
      password,
    });
  } catch (err) {
    if (err instanceof OpaqueRateLimitError) {
      throw new Error('Too many wrong passwords. Wait a while and try again.', { cause: err });
    }
    if (err instanceof OpaqueNotEnabledError) {
      throw new Error('These books have no password. Use the recovery key.', { cause: err });
    }
    if (err instanceof OpaqueError || err instanceof AuthenticationError) {
      throw new Error('That password is not right.', { cause: err });
    }
    throw err;
  }
  return withSecrets(spaceId, baseUrl, recovered.privateKey, recovered.symmetricRoot);
}

/** A copy of `creds`' keys wrapped for the passkey that produced `prf`. */
export function wrapForPasskey(creds: SpaceCredentials, prf: PrfResult): Promise<WrappedKeys> {
  return wrapKeys(
    prf.prf,
    { privateKey: creds.keyPair.privateKey, symmetricRoot: creds.symmetricRoot },
    creds.spaceId,
    prf.credentialId,
    prf.salt,
  );
}

/**
 * Overwrites the keys in memory. Best effort: the SDK and WebCrypto may hold derived keys
 * of their own until they are collected (0034).
 */
export function forgetKeys(creds: SpaceCredentials): void {
  creds.keyPair.privateKey.fill(0);
  creds.symmetricRoot.fill(0);
}

/**
 * Credentials from recovered secrets, after checking the private key really is the space's.
 * A wrapped copy is authenticated, but this also catches keys for some other identity.
 */
async function withSecrets(
  spaceId: string,
  baseUrl: string,
  privateKey: Uint8Array,
  symmetricRoot: Uint8Array,
): Promise<SpaceCredentials> {
  const publicKey = extractPublicKey(spaceId);
  const probe = new TextEncoder().encode('absurd-money/key-check');
  if (!(await verifySignature(probe, await signData(probe, privateKey), publicKey))) {
    throw new Error('These keys do not belong to these books.');
  }
  return { spaceId, keyPair: { privateKey, publicKey }, symmetricRoot, baseUrl };
}

// ---------------------------------------------------------------------------------------
// This device's record, in IndexedDB

const DB_NAME = 'absurd-money';
const STORE = 'books';
const RECORD = 'current';

/** This device's books, or null if it has none. Throws if the record is unreadable. */
export async function loadBooks(): Promise<SavedBooks | null> {
  const value = await idb<unknown>('readonly', (s) => s.get(RECORD));
  if (value === undefined) return null;
  return parseBooks(value);
}

export async function saveBooks(books: SavedBooks): Promise<void> {
  await idb('readwrite', (s) => s.put(books, RECORD));
}

export async function clearBooks(): Promise<void> {
  await idb('readwrite', (s) => s.delete(RECORD));
}

function parseBooks(value: unknown): SavedBooks {
  const b = value as Partial<SavedBooks> | null;
  if (typeof b !== 'object' || b === null || b.v !== 1) {
    throw new Error('The saved books are in a format this version does not know.');
  }
  if (typeof b.baseUrl !== 'string' || typeof b.password !== 'boolean' || !Array.isArray(b.passkeys)) {
    throw new Error('The saved books are damaged.');
  }
  return {
    v: 1,
    spaceId: checkSpaceId(String(b.spaceId)),
    baseUrl: b.baseUrl,
    password: b.password,
    passkeys: b.passkeys.map(parseWrappedKeys),
  };
}

function idb<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error ?? new Error('Could not open IndexedDB.'));
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(req.result as T);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error('IndexedDB transaction failed.'));
      };
    };
  });
}

// ---------------------------------------------------------------------------------------
// Plaintext credentials from before 0033

const LEGACY_KEY = 'absurd-money-credentials';

interface LegacyCredentials {
  spaceId: string;
  publicKey: string; // base64
  privateKey: string; // base64
  symmetricRoot: string; // base64
  baseUrl: string;
}

/** Credentials left in localStorage in the clear by an older version, or null. */
export function loadLegacyCredentials(): SpaceCredentials | null {
  const stored = localStorage.getItem(LEGACY_KEY);
  if (!stored) return null;
  try {
    const s = JSON.parse(stored) as LegacyCredentials;
    return {
      spaceId: s.spaceId,
      keyPair: { publicKey: decodeBase64(s.publicKey), privateKey: decodeBase64(s.privateKey) },
      symmetricRoot: decodeBase64(s.symmetricRoot),
      baseUrl: s.baseUrl,
    };
  } catch {
    return null;
  }
}

export function clearLegacyCredentials(): void {
  localStorage.removeItem(LEGACY_KEY);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}
