/**
 * Space credentials: creating a new space's keys, the recovery key that moves them to
 * another device, and persistence in localStorage.
 *
 * A space is an Ed25519 key pair plus a 32-byte symmetric root, and its ID is the public
 * key. Whoever holds the private key and the root can read and write the whole book, so
 * the recovery key is shown once at creation and never sent anywhere.
 */

import {
  decodeBase64,
  encodeBase64,
  extractPublicKey,
  generateKeyPair,
  getIdentifierType,
  IdType,
  toSpaceId,
  type KeyPair,
} from 'reeeductio';

export interface SpaceCredentials {
  readonly spaceId: string;
  readonly keyPair: KeyPair;
  readonly symmetricRoot: Uint8Array;
  readonly baseUrl: string;
}

const STORAGE_KEY = 'absurd-money-credentials';

interface StoredCredentials {
  spaceId: string;
  publicKey: string; // base64
  privateKey: string; // base64
  symmetricRoot: string; // base64
  baseUrl: string;
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

/**
 * Credentials for the space's creator, from its ID and recovery key. The creator's public
 * key is the space ID's. Other members (0031) will need their own user ID here.
 */
export function credentialsFromRecoveryKey(
  spaceId: string,
  key: string,
  baseUrl: string,
): SpaceCredentials {
  spaceId = spaceId.trim();
  key = key.trim();
  let isSpace = false;
  try {
    isSpace = getIdentifierType(spaceId) === IdType.SPACE;
  } catch {
    // Not a typed ID at all; reported below.
  }
  if (!isSpace) throw new Error('That is not a space ID.');
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

export function saveCredentials(creds: SpaceCredentials): void {
  const stored: StoredCredentials = {
    spaceId: creds.spaceId,
    publicKey: encodeBase64(creds.keyPair.publicKey),
    privateKey: encodeBase64(creds.keyPair.privateKey),
    symmetricRoot: encodeBase64(creds.symmetricRoot),
    baseUrl: creds.baseUrl,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

/** The saved credentials, or null if there are none or they can't be read. */
export function loadCredentials(): SpaceCredentials | null {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  try {
    const s = JSON.parse(stored) as StoredCredentials;
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

export function clearCredentials(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}
