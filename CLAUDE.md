# Absurd Money

Double-entry personal finance PWA on the end-to-end encrypted reeeductio Spaces API.
The design is in `design/ACCOUNTING.md`. Read it before changing anything about the data
model.

## Stack

- TypeScript (strict), Lit 3.x, Vite. Follows the conventions of `../music`.
- reeeductio TypeScript SDK as a local dependency (`../../reeeductio/typescript-sdk`)
- SQLite-WASM in OPFS for the local projection

## Commands

- `npm run dev`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`
- Path alias: `@/` is `src/`.

## Architecture

- **Core** (`src/core/`): pure TypeScript with no DOM or network. Codec, label PRF,
  validators, and folds. Covered by vitest unit tests (`*.test.ts`, run in Node).
  ESLint enforces that core imports only other core modules and `@noble/hashes`.
- **Services** (`src/services/`): the SDK boundary. Credentials, `LedgerSpace`, and the
  State document store, whose CAS logic is tested against a fake backend.
- **Sync** (`src/services/sync.ts`): SDK messages are decrypted and appended to the
  projection's log, caught up from watermarks, then live over the WebSocket.
- **Projection** (`src/projection/`): events go into SQLite (in a worker, OPFS
  `opfs-sahpool`). The projection is a disposable cache that can always be rebuilt from
  the log. Bump `PROJECTION_VERSION` when the fold tables change; never migrate them.
  Tests run against in-memory SQLite in Node.
- **UI**: Lit components that read from the projection.

## Invariants

- **No floats in ledger facts.** Amounts are `BigInt` in memory, decimal strings on the
  wire, and `TEXT` in SQLite, with an explicit exponent per split. Floats are for display
  only.
- Every `ledger.entry` sums to exactly zero **per commodity**.
- The journal is append-only. Fixes are reversals, `ledger.edit`, or new entries.
- **Nothing whose write volume scales with transaction count goes in State.**
- No user-derived string or raw `message_hash` appears in a path. Use the keyed PRF labels.
- Account IDs are random, never derived from names.
- Entries route to `journal-YYYY` by their date's year. Edits route to their target's
  segment.
- Everything needed to read a year lives in its segment or in State. See the topic-key
  rules in the design doc's open questions.
- Every message type carries a `v` field. Message schemas are permanent once posted.

## Git

- Do not commit. Leave changes in the working tree; the user reviews and commits them.

## Docs

- Link to reeeductio code with GitHub URLs under
  `https://github.com/reeeductio/reeeductio/blob/main/`, never with relative paths.

## Tracking work

Issues live in the repo; the full workflow is in `issues/README.md`. Key rules:

- `TODO.md` is the only place status lives. An issue is open if and only if it is listed
  there.
- IDs (`0007`) are stable and never reused; take the next one from `Next ID` in `TODO.md`.
- Detail goes in an optional `issues/NNNN-slug.md`, kept forever.
- To close an issue in the same change that implements it: remove its `TODO.md` line, add a
  `CHANGELOG.md` entry citing the ID, and append `## Resolution` to its file if it has one.
- When working on an issue, read `TODO.md` and that issue's file, not the whole folder.
