# 0033: Keys wrapped at rest, unlocked by passkey or password

## Context

Since 0008, the space's private key and `symmetric_root` sit in localStorage as plaintext
base64 (`src/services/credentials.ts`). Anyone who can read the browser profile can read
and write the whole set of books: a stolen laptop, a disk or profile backup, a synced
profile, or malware on the machine. No storage location in the browser protects against
code running in our own origin (XSS, a compromised dependency); that is 0034's concern,
plus the CSP. This issue is about the at-rest case: the keys on disk must be useless
without the user present.

The fix is to encrypt both secrets under a key-encryption key (KEK) that only the user
can produce, and store the wrapped bundle in IndexedDB. Two sources for the KEK:

- **Passkey with the WebAuthn PRF extension.** The authenticator returns a stable 32-byte
  secret for a given salt, which becomes the KEK via HKDF. Unlocking is a biometric
  prompt. The secret is hardware-bound, phishing-resistant, and not guessable, so nothing
  stored on the device can be brute-forced.
- **Password via OPAQUE.** reeeductio already implements it (`performOpaqueLogin`,
  `opaqueRegister`, `enableOpaque`; design in the music app's `LOGIN-AND-SSO.md`). The
  server stores the encrypted credentials and can't run an offline guessing attack without
  its OPRF key. It also replaces the 128-digit recovery key for signing in on a new device.

## Acceptance criteria

- Nothing in localStorage, IndexedDB, or anywhere else on disk lets someone open the books
  without the passkey, the password, or the recovery key. Existing plaintext credentials
  from 0008 are migrated on first unlock and then deleted.
- Setting up new books offers a passkey (when the browser and authenticator support PRF)
  and an OPAQUE password. At least one is required. The recovery key is still shown once.
- Opening the app unlocks with the passkey, or falls back to the password.
- Connecting a new device works with the password (OPAQUE), or with the space ID and
  recovery key as today. A new device can then add its own passkey.
- The app locks after a period of inactivity and on an explicit "Lock" action. Locking
  drops the unwrapped keys and the `LedgerSpace` from memory.
- The wrapped bundle format carries a version, so the KEK derivation can change later.
- Unit tests for wrapping and unwrapping, including a wrong KEK and a tampered bundle.

## Notes

- Check PRF support across the browsers we care about, and on the authenticators people
  actually use (iCloud Keychain, Google Password Manager, 1Password, hardware keys). Feature
  detection decides whether the passkey option is offered; it is never the only way in.
- OPAQUE needs `enableOpaque()` run once by the space's creator, the way the music app does
  it as root setup.
- Several passkeys per space (one per device) means several wrapped copies of the bundle,
  one per credential ID.
- The unwrapped keys are still raw bytes in memory here, because the SDK needs them that
  way. 0034 removes that.
- Defense in depth for the in-origin case is the CSP (`script-src 'self'`). Don't loosen it.
