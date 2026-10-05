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
