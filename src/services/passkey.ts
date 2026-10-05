/**
 * Passkeys as a key source, through the WebAuthn PRF extension (0033).
 *
 * A passkey here is never used to sign in to a server. Its only job is to return a stable
 * 32-byte secret for a given salt (the PRF output), which key-wrap.ts turns into the KEK.
 * So the challenge is random and never verified, and there is no relying-party server.
 *
 * PRF support varies by browser and by authenticator (iCloud Keychain, Google Password
 * Manager, 1Password, hardware keys). Feature detection decides whether a passkey is
 * offered, and a password is always the other way in. An authenticator that turns out not
 * to support PRF is reported as `PasskeyUnsupportedError`.
 */

import { base64url } from '@/core/ids.js';
import { newPrfSalt } from './key-wrap.js';

/** This browser or authenticator can't produce a PRF output. */
export class PasskeyUnsupportedError extends Error {
  constructor() {
    super("This passkey can't protect your keys. Use a password instead, or a different passkey provider.");
    this.name = 'PasskeyUnsupportedError';
  }
}

/** A passkey's PRF output, and the credential and salt that produced it. */
export interface PrfResult {
  readonly credentialId: Uint8Array;
  readonly salt: Uint8Array;
  readonly prf: Uint8Array;
}

/**
 * Whether to offer a passkey. Browsers that report their capabilities are taken at their
 * word; others are offered one if they have WebAuthn at all, since the authenticator may
 * still support PRF, and creating the passkey finds out.
 */
export async function passkeysSupported(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined' || !window.isSecureContext) return false;
  if (typeof PublicKeyCredential.getClientCapabilities !== 'function') return true;
  try {
    const caps = await PublicKeyCredential.getClientCapabilities();
    return caps['extension:prf'] !== false;
  } catch {
    return true;
  }
}

/**
 * Creates a passkey for the books `spaceId`, unless the authenticator already holds one
 * of their `existing` credential IDs, and evaluates its PRF. Call it straight from
 * a click: Safari refuses WebAuthn without a recent user gesture. Some authenticators
 * return the PRF output at creation; for the rest it takes a second prompt.
 */
export async function createPasskey(spaceId: string, existing: readonly Uint8Array[] = []): Promise<PrfResult> {
  const salt = newPrfSalt();
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Absurd Money' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: `Books ${spaceId.slice(1, 9)}`,
        displayName: 'Absurd Money books',
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -8 }, // EdDSA
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      // An authenticator that already holds one of these refuses, rather than adding a twin.
      excludeCredentials: existing.map((id) => ({ type: 'public-key', id: buffer(id) })),
      extensions: { prf: { eval: { first: buffer(salt) } } },
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was created.');
  const credentialId = new Uint8Array(cred.rawId);
  const ext = cred.getClientExtensionResults().prf;
  if (!ext?.enabled) throw new PasskeyUnsupportedError();
  const first = ext.results?.first;
  if (first) return { credentialId, salt, prf: bytes(first) };
  return evaluatePasskey([{ credentialId, salt }]);
}

/**
 * Asks for any one of `passkeys` and returns its PRF output. Call it from a click, as
 * for `createPasskey`.
 */
export async function evaluatePasskey(
  passkeys: readonly { credentialId: Uint8Array; salt: Uint8Array }[],
): Promise<PrfResult> {
  const byId = new Map(passkeys.map((p) => [base64url(p.credentialId), p]));
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: passkeys.map((p) => ({ type: 'public-key', id: buffer(p.credentialId) })),
      userVerification: 'required',
      extensions: {
        prf: {
          evalByCredential: Object.fromEntries(
            [...byId].map(([id, p]) => [id, { first: buffer(p.salt) }]),
          ),
        },
      },
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was used.');
  const used = byId.get(base64url(new Uint8Array(cred.rawId)));
  if (!used) throw new Error('That passkey is not one of these books’ passkeys.');
  const first = cred.getClientExtensionResults().prf?.results?.first;
  if (!first) throw new PasskeyUnsupportedError();
  return { credentialId: used.credentialId, salt: used.salt, prf: bytes(first) };
}

function bytes(source: BufferSource): Uint8Array {
  return source instanceof ArrayBuffer
    ? new Uint8Array(source.slice(0))
    : new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
}

/** A copy backed by a plain `ArrayBuffer`, as WebAuthn's types require. */
function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}
