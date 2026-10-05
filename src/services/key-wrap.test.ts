import { describe, expect, it } from 'vitest';
import { decodeUrlSafeBase64 } from 'reeeductio';
import { base64url } from '@/core/ids.js';
import { newPrfSalt, parseWrappedKeys, unwrapKeys, UnwrapError, wrapKeys, type WrappedKeys } from './key-wrap.js';

const SPACE = 'C' + 'A'.repeat(43);
const OTHER_SPACE = 'C' + 'B'.repeat(43);

function bytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

const secrets = { privateKey: bytes(32, 1), symmetricRoot: bytes(32, 2) };
const prf = bytes(32, 7);
const credentialId = bytes(16, 9);

function wrap(over: { prf?: Uint8Array; space?: string } = {}): Promise<WrappedKeys> {
  return wrapKeys(over.prf ?? prf, secrets, over.space ?? SPACE, credentialId, newPrfSalt());
}

/** `s` with one bit of byte `i` flipped. */
function flip(s: string, i = 0): string {
  const b = decodeUrlSafeBase64(s);
  b[i] ^= 1;
  return base64url(b);
}

describe('wrapKeys and unwrapKeys', () => {
  it('round-trips', async () => {
    const w = await wrap();
    expect(w.v).toBe(1);
    expect(w.credentialId).toBe(base64url(credentialId));
    const out = await unwrapKeys(prf, w, SPACE);
    expect(out.privateKey).toEqual(secrets.privateKey);
    expect(out.symmetricRoot).toEqual(secrets.symmetricRoot);
  });

  it('never stores the keys in the clear', async () => {
    const w = await wrap();
    const ct = decodeUrlSafeBase64(w.ct);
    expect(ct.length).toBe(64 + 16);
    expect(ct.slice(0, 32)).not.toEqual(secrets.privateKey);
  });

  it('uses a fresh IV every time', async () => {
    const [a, b] = await Promise.all([wrap(), wrap()]);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('rejects the wrong KEK', async () => {
    const w = await wrap();
    await expect(unwrapKeys(bytes(32, 8), w, SPACE)).rejects.toThrow(UnwrapError);
  });

  it('rejects a PRF output of the wrong length', async () => {
    const w = await wrap();
    await expect(unwrapKeys(bytes(31, 7), w, SPACE)).rejects.toThrow(UnwrapError);
  });

  it('rejects a tampered ciphertext, IV, or tag', async () => {
    const w = await wrap();
    const ctLen = decodeUrlSafeBase64(w.ct).length;
    await expect(unwrapKeys(prf, { ...w, ct: flip(w.ct, 0) }, SPACE)).rejects.toThrow(UnwrapError);
    await expect(unwrapKeys(prf, { ...w, ct: flip(w.ct, ctLen - 1) }, SPACE)).rejects.toThrow(UnwrapError);
    await expect(unwrapKeys(prf, { ...w, iv: flip(w.iv) }, SPACE)).rejects.toThrow(UnwrapError);
  });

  it('rejects a truncated ciphertext', async () => {
    const w = await wrap();
    const ct = base64url(decodeUrlSafeBase64(w.ct).slice(0, 40));
    await expect(unwrapKeys(prf, { ...w, ct }, SPACE)).rejects.toThrow(UnwrapError);
  });

  it('binds a copy to its space', async () => {
    const w = await wrap();
    await expect(unwrapKeys(prf, w, OTHER_SPACE)).rejects.toThrow(UnwrapError);
  });

  it('binds a copy to its credential and salt', async () => {
    const w = await wrap();
    await expect(unwrapKeys(prf, { ...w, credentialId: flip(w.credentialId) }, SPACE)).rejects.toThrow(UnwrapError);
    await expect(unwrapKeys(prf, { ...w, salt: flip(w.salt) }, SPACE)).rejects.toThrow(UnwrapError);
  });

  it('rejects an unknown version', async () => {
    const w = await wrap();
    const v2 = { ...w, v: 2 } as unknown as WrappedKeys;
    await expect(unwrapKeys(prf, v2, SPACE)).rejects.toThrow(/v2/);
  });

  it('refuses keys of the wrong length', async () => {
    await expect(
      wrapKeys(prf, { ...secrets, privateKey: bytes(31, 1) }, SPACE, credentialId, newPrfSalt()),
    ).rejects.toThrow(/32 bytes/);
  });
});

describe('parseWrappedKeys', () => {
  it('accepts what wrapKeys makes, after a JSON round trip', async () => {
    const w = await wrap();
    expect(parseWrappedKeys(JSON.parse(JSON.stringify(w)))).toEqual(w);
  });

  it('rejects an unknown version, a missing field, and a non-base64url field', async () => {
    const w = await wrap();
    expect(() => parseWrappedKeys({ ...w, v: 2 })).toThrow(/v2/);
    expect(() => parseWrappedKeys({ ...w, ct: undefined })).toThrow(/ct/);
    expect(() => parseWrappedKeys({ ...w, iv: 'a+b/' })).toThrow(/iv/);
    expect(() => parseWrappedKeys(null)).toThrow();
  });
});
