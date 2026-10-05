# 0034: Non-extractable WebCrypto keys in memory

## Context

Even with keys wrapped at rest (0033), the unlocked keys are raw
`Uint8Array`s in memory, because the reeeductio SDK takes raw bytes and
does all its crypto with `@noble` (Ed25519 signing, HKDF, AES-GCM), and
our core's label PRF (design/LABELS.md) runs HKDF and HMAC on the raw
`symmetric_root`. So code running in our origin, through XSS or a
compromised dependency, can copy the keys and use them forever, from
anywhere.

WebCrypto can hold keys as non-extractable `CryptoKey` objects. The page
can use them but never read their bytes back, so an attacker in the page
can only act while the page is compromised and open. Everything we need
is available in WebCrypto: Ed25519 signing, HKDF from a non-extractable
base key, AES-GCM, and HMAC.

This matters more once books are shared (0031), since more people's
devices hold keys to the same space.

## Acceptance criteria

- After unlock, the private key and `symmetric_root` exist only as
  non-extractable `CryptoKey`s. No raw copy is kept in the app, the SDK,
  or core.
- Derived keys (message, state, data, and topic keys; `label_key` and
  the per-namespace label keys) are derived inside WebCrypto as
  non-extractable keys too.
- Every existing test vector still passes: the label PRF vectors in
  design/LABELS.md, and the SDK's key derivation and signature vectors.
- 0033's unwrap step imports straight to non-extractable keys
  (`unwrapKey`, or `importKey` with `extractable: false`), so raw bytes
  exist only briefly during import.

## Notes

- **This is mostly an SDK change.** `Space` would need to accept key
  handles, or a narrow signer/decryptor interface, instead of
  `keyPair.privateKey` and `symmetricRoot` as bytes. Raise it upstream
  in reeeductio first; the TypeScript and Python SDKs should agree on
  the derivation even though only TypeScript needs handles.
- WebCrypto is async and our core is synchronous and pure. The label PRF
  either becomes async, or core keeps a pure byte-based implementation
  for tests and the app supplies a WebCrypto-backed one. Decide which
  before starting. ESLint currently keeps `crypto.subtle` out of core
  only implicitly; whichever way this goes, make the rule explicit.
- Ed25519 in WebCrypto is recent. Check Chrome, Safari, and Firefox
  versions, and decide what happens on a browser without it (refuse, or
  fall back to raw keys with a warning).
- Recovery key import (0008) and OPAQUE login (0033) both produce raw
  bytes. Import them immediately and drop the buffers. JavaScript can't
  guarantee zeroing, so keep the window short.
