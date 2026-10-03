# 0012: Local projection in SQLite-WASM / OPFS

## Context

The client replays the journal segments, `budget`, `recon`, `checkpoints`, and the State
log into a local SQLite database. All reports run against that database. The projection is
a disposable cache: it can always be rebuilt from the log. See "Design A" in
[design/ACCOUNTING.md](../design/ACCOUNTING.md).

## Open questions (resolve before building)

1. **Which storage mode for SQLite in the browser.** The official `@sqlite.org/sqlite-wasm`
   build offers two ways to store the database in OPFS:
   - `opfs`: needs `SharedArrayBuffer`, which requires cross-origin isolation headers
     (COOP/COEP) on every page. Those are set in `firebase.json`. COEP can break
     cross-origin resources that don't opt in. Check that the reeeductio API, blob
     storage, and anything else we load still work.
   - `opfs-sahpool`: needs no special headers, and is faster. But it holds an
     **exclusive lock**, so only one tab can have the database open.

   Also evaluate wa-sqlite, whose OPFS modes include some that support more than one
   connection at a time.
2. **Several open tabs.** With an exclusive lock, a second tab can't open the database.
   The options:
   - (a) One tab owns the database. Other tabs send queries to it with
     `BroadcastChannel` or a `SharedWorker`, and take over ownership if it closes.
   - (b) A second tab shows "already open in another tab".
   - (c) Use a storage mode that allows several connections at once.

   For a single user, (b) is acceptable for v1, and (a) is the eventual answer.
3. **Storing messages twice.** The SDK already caches raw messages in IndexedDB (its
   `local_store_idb`). Should we keep that cache *and* SQLite, or turn off the SDK cache
   and store raw ciphertext in SQLite too? Keeping both means two caches that can
   disagree. On the other hand, keeping the raw messages means a schema change only
   needs a local replay, not a full download again.
4. **Where SQLite runs.** In a dedicated Worker either way, so the UI thread never blocks.
   Lit components query through an async API.

## Design rules (already decided)

- **Amounts are stored as `TEXT`** (decimal strings) or as integers on a coarser scale,
  never as an `INTEGER` holding a large-exponent value. SQLite integers are 64-bit, so
  wei overflows above roughly 9.2 ETH. Sums of amounts run in TypeScript with `BigInt`,
  or in SQL only for currencies known to fit. An optional `approx REAL` column may back
  sorting and range filters, as display data only. See "Projection" in
  [design/AMOUNTS.md](../design/AMOUNTS.md#projection).
- **There is a projection schema version.** If the version on disk doesn't match the
  code's, drop the database and replay. Never migrate a projection.
- **Watermarks:** one high-water mark per topic (chain head hash plus `server_timestamp`).
  They are stored in the projection itself, so they are always consistent with it.
- **Register order:** entry `date` first, then chain position within a segment. Across
  segments, use `server_timestamp`.
- **Live updates:** the WebSocket at `/spaces/{id}/stream`. On reconnect, catch up from
  the watermarks before applying live messages.

## Acceptance criteria

- A cold start replays a test space with 10k entries into the projection, and the time is
  measured on desktop and on a phone.
- Reopening the app with an existing projection starts from the watermarks, not from
  genesis.
- A projection schema change triggers a clean rebuild.
- An entry posted on one device shows up in another device's register through the
  WebSocket.
- The behavior with two open tabs is defined and tested.
