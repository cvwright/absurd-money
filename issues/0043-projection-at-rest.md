# 0043: The projection encrypted at rest, or gone when locked

## Context

0033 wraps the keys at rest, so the keys on disk are useless without the passkey, the
password, or the recovery key. But the projection (0012) is SQLite in OPFS, and it holds
the books decrypted: every entry, memo, payee, and balance, and the log of decrypted
messages it is folded from. Someone with the browser profile (a stolen laptop, a disk or
profile backup, a synced profile, malware) can't write to the books or decrypt anything
new, but can read everything synced so far. Locking drops the projection from memory, not
from disk.

## Options

- **Encrypt the database pages.** A custom SQLite VFS over `opfs-sahpool` that encrypts
  each page with AES-GCM under a key derived from `symmetric_root` (or a random key
  wrapped next to the passkey copies). Strongest, and keeps cold start fast. Costs: a VFS
  of our own in the worker, a per-page nonce and tag (so a page-size change), and a
  crypto call on every page read. The official SQLite WASM build has no SEE or SQLCipher.
- **Encrypt the log rows, keep the fold tables plain.** Smaller change, but the fold
  tables are where the readable data is, so this protects little.
- **Delete the projection on lock and rebuild on unlock.** Simple and complete, but
  every unlock pays the cold start that 0039 measures and 0028 exists to shorten. Maybe
  acceptable as an option ("Don't keep a copy on this device") rather than the default.

## Acceptance criteria

- With the app locked, nothing in OPFS, IndexedDB, or localStorage reveals an amount, a
  memo, a payee, or an account name.
- The projection key is dropped on lock along with the space keys.
- `PROJECTION_VERSION` is bumped if the on-disk format changes; old projections are
  deleted, not migrated.

## Notes

- Measure the per-page cost against the 10k-entry space from 0039 before choosing.
- The key must be available inside the projection worker, which today never sees the
  space keys. 0041 (decrypting in the worker) moves the same way.

## Resolution

2026-10-04. Accepted as a risk, not fixed. Nothing in the code changed; the decision is
recorded under "Design A" in `design/ACCOUNTING.md`.

- **Out of reach anyway.** Malware on the host can read memory while the app is unlocked,
  or capture the password or the passkey prompt at the next unlock. No at-rest scheme
  changes that.
- **Covered by the OS.** A stolen or discarded device is protected by full-disk
  encryption (FileVault, BitLocker, and phones by default), which is assumed. As far as
  we know, browser profile sync doesn't carry OPFS.
- **Residual exposure.** Unencrypted disks, and unencrypted backups of the profile (for
  example Time Machine without encryption), hold the books in plaintext. 0033 still holds
  there: whoever has the files can't write to the books or decrypt anything new.
- **Deleting on lock was rejected as a half-measure.** Locking only runs in a live page.
  Closing the tab or the browser, or a crash, leaves the projection on disk, which is the
  case this issue was about.

If this is revisited, the preferred design is an encrypted log with in-memory folds:

- Each log row's `body` is encrypted with AES-GCM before it's written. The key is
  HKDF-derived from `symmetric_root` (info `absurd-money/projection/v1`) and
  non-extractable. It's posted to the worker as a `CryptoKey`, so the worker still never
  sees the space keys.
- The fold tables live in an `ATTACH ':memory:'` schema and are refolded from the log on
  every unlock, with no network.
- Nothing readable reaches disk, so lock, close, and crash are all safe without a wipe
  step. Hash, prev, type, sender, timestamp, and topic stay readable, which the server
  sees anyway.
- The cost is decrypting the log plus a full refold on every unlock, to be measured with
  0039.
- A page-encrypting VFS was ruled out. SQLite's VFS calls are synchronous, so it can't
  use WebCrypto and would need raw key bytes in memory (against 0034).
