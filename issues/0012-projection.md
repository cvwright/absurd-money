# 0012: Local projection in SQLite-WASM / OPFS

## Context

The client replays the journal segments, `budget`, `recon`,
`checkpoints`, and the State log into a local SQLite database. All
reports run against that database. The projection is a disposable cache:
it can always be rebuilt from the log. See "Design A" in
[design/ACCOUNTING.md](../design/ACCOUNTING.md).

## Open questions (resolve before building)

1. **Which storage mode for SQLite in the browser.** The official
   `@sqlite.org/sqlite-wasm` build offers two ways to store the database
   in OPFS:
   - `opfs`: needs `SharedArrayBuffer`, which requires cross-origin
     isolation headers (COOP/COEP) on every page. Those are set in
     `firebase.json`. COEP can break cross-origin resources that don't
     opt in. Check that the reeeductio API, blob storage, and anything
     else we load still work.
   - `opfs-sahpool`: needs no special headers, and is faster. But it
     holds an **exclusive lock**, so only one tab can have the database
     open.

   Also evaluate wa-sqlite, whose OPFS modes include some that support
   more than one connection at a time.

2. **Several open tabs.** With an exclusive lock, a second tab can't
   open the database. The options:
   - (a) One tab owns the database. Other tabs send queries to it with
     `BroadcastChannel` or a `SharedWorker`, and take over ownership if
     it closes.
   - (b) A second tab shows "already open in another tab".
   - (c) Use a storage mode that allows several connections at once.

   For a single user, (b) is acceptable for v1, and (a) is the eventual
   answer.

3. **Storing messages twice.** The SDK already caches raw messages in
   IndexedDB (its `local_store_idb`). Should we keep that cache *and*
   SQLite, or turn off the SDK cache and store raw ciphertext in SQLite
   too? Keeping both means two caches that can disagree. On the other
   hand, keeping the raw messages means a schema change only needs a
   local replay, not a full download again.
4. **Where SQLite runs.** In a dedicated Worker either way, so the UI
   thread never blocks. Lit components query through an async API.

## Design rules (already decided)

- **Amounts are stored as `TEXT`** (decimal strings) or as integers on a
  coarser scale, never as an `INTEGER` holding a large-exponent value.
  SQLite integers are 64-bit, so wei overflows above roughly 9.2 ETH.
  Sums of amounts run in TypeScript with `BigInt`, or in SQL only for
  currencies known to fit. An optional `approx REAL` column may back
  sorting and range filters, as display data only. See "Projection" in
  [design/AMOUNTS.md](../design/AMOUNTS.md#projection).
- **There is a projection schema version.** If the version on disk
  doesn't match the code's, drop the database and replay. Never migrate
  a projection.
- **Watermarks:** one high-water mark per topic (chain head hash plus
  `server_timestamp`). They are stored in the projection itself, so they
  are always consistent with it.
- **Register order:** entry `date` first, then chain position within a
  segment. Across segments, use `server_timestamp`.
- **Live updates:** the WebSocket at `/spaces/{id}/stream`. On
  reconnect, catch up from the watermarks before applying live messages.

## Acceptance criteria

- A cold start replays a test space with 10k entries into the
  projection, and the time is measured on desktop and on a phone.
- Reopening the app with an existing projection starts from the
  watermarks, not from genesis.
- A projection schema change triggers a clean rebuild.
- An entry posted on one device shows up in another device's register
  through the WebSocket.
- The behavior with two open tabs is defined and tested.

## Resolution

2026-10-04. Built in `src/projection/`, `src/services/sync.ts`,
`stream.ts`, and `live-projection.ts`.

The open questions:

1. **Storage mode: `opfs-sahpool`**, from the official
   `@sqlite.org/sqlite-wasm`. It needs no COOP/COEP headers, so nothing
   cross-origin can break, and it is the faster mode. The only header
   change is `'wasm-unsafe-eval'` in `script-src`, which lets the worker
   compile SQLite. wa-sqlite's multi-connection modes were not adopted:
   the exclusive lock is handled by (2), and supporting several tabs is
   better done with (a) than with more VFS machinery.
2. **Several tabs: (b), with takeover.** The worker takes a Web Lock
   before opening the database. A second tab says the books are open
   elsewhere and waits on the lock, then opens when the first tab
   closes. The worker holds the lock, so it is released together with
   the storage's file handles. Tested in `tab-lock.test.ts` against
   Node's Web Locks. Option (a) is 0040.
3. **Storing messages twice: no.** `LedgerSpace` never configured the
   SDK's IndexedDB cache, and still doesn't. The log lives in SQLite
   with the folds, as decrypted payload text plus the server envelope.
   The log and the folds are versioned separately, so a projection
   schema change refolds locally (`PROJECTION_VERSION`) and only a log
   schema change downloads again (`LOG_VERSION`). State messages outside
   the ledger's documents are logged without their payloads, only to
   keep the state chain whole.
4. **Where SQLite runs: a dedicated module worker.** Views call it
   through `ProjectionClient`, and values cross by structured clone,
   which keeps `bigint` and `Map`. Decryption still runs on the UI
   thread, in the sync (0041).

Other choices:

- A topic is always refolded whole with the core folds, in the same
  transaction as the append and the watermark. When messages are
  appended to a segment and nothing else changed, only the rows of the
  transactions they add, edit, or reverse are rewritten. Chart and
  checkpoint changes refold every segment.
- Checkpoint heads feed the segment folds' lock and freeze rules as they
  are. Who may sign a checkpoint is still open (0028).
- `register(account)` is the query for 0013. The chart of accounts shows
  balances, so a post on one device updating another device's balance
  shows the WebSocket path working.
- The projection holds decrypted books in OPFS. Signing out deletes it.
  Protecting it at rest belongs with the keys (0033).

Acceptance criteria:

- 10k entries: about 0.5 s to replay and 0.1 s for one more live entry,
  measured in Node (`projection.test.ts`). This excludes the network and
  decryption. Desktop and phone measurements against a real space
  are 0039.
- Reopening starts from the watermarks: tested in `projection.test.ts`
  and `sync.test.ts`.
- A schema change rebuilds cleanly: tested for both versions.
- Live updates: the catch-up, gap, and ordering logic is tested against
  a fake server. Not yet tried across two devices on a real server.
- Two tabs: defined above, and tested.

A headless Chrome run against the Vite dev server confirmed that the
worker, the WASM, the OPFS SAH pool, persistence across opens, and the
second-tab wait and takeover all work.
