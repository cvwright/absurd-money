# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Design document [design/ACCOUNTING.md](design/ACCOUNTING.md),
  describing the data model on reeeductio Spaces.
- `ledger.edit`: recategorization and annotation as Matrix-style overlay
  events in the journal, replacing per-transaction `ledger/txmeta`
  State.
- One logical ledger for all time, stored physically as yearly
  `journal-YYYY` topics, so a single tax year can be shared by handing
  over that topic's key.
- Opening-balances entry, period close, and the positional lock rule.
- Import consumption derived from journal `import_id` labels; dismissal
  via `ledger.dismiss`.
- Payees get random IDs in one State document; import rules map raw
  merchant strings to payees.
- Client-side CSV import with local review; `import-staging` reserved
  for a possible future bank-sync tool account.
- Message `type` fields stay cleartext; the leakage is documented and
  accepted.
- [design/SCHEMAS.md](design/SCHEMAS.md): field-by-field `v: 1` schemas
  for every message type and State document, with post-time and
  fold-time validation rules (0001).
- [design/AMOUNTS.md](design/AMOUNTS.md): the amount codec. Strict
  decoding, exact arithmetic with no rounding, a text parser that never
  rounds, the canonical decimal form hashed into `import/v1` labels, the
  projection encoding, and test vectors (0002).
- `decimal` field on import profiles, for exports that use a decimal
  comma (0002).
- [design/ROUNDING.md](design/ROUNDING.md): the rounding policy. Basis
  released by a partial disposal is floored at the lot cost's exponent,
  the lot keeps the remainder, and the depleting draw takes the rest. It
  pins the order in which a lot's draws are checked, defines
  largest-remainder allocation and exact valuation, and includes test
  vectors (0003).
- [design/NORMALIZATION.md](design/NORMALIZATION.md): the `import/v1`
  description normalization (well-formed, NFKC, locale-free lowercase, a
  pinned whitespace set collapsed and trimmed, punctuation kept),
  `fitid` trimming, the exact label input for both import ID schemes,
  and test vectors (0004).
- [design/LABELS.md](design/LABELS.md): the label PRF. HKDF-SHA256 from
  the space's `symmetric_root` to a `label_key` and one key per
  namespace, HMAC-SHA256 truncated to 15 bytes, base64url. It pins the
  namespace registry and each namespace's input, rejects ill-formed
  strings, and includes test vectors checked against Python and the
  SDK's `@noble/hashes` (0005).
- Project scaffold: Lit 3, Vite, and vite-plugin-pwa, linked to the
  local reeeductio TypeScript SDK, with strict TypeScript, ESLint, and
  vitest. ESLint keeps `src/core` pure: it may import only other core
  modules and cannot touch DOM or network globals (0006).
- `src/core/`: the pure-TypeScript core, with vitest tests that pass
  every vector in AMOUNTS.md, ROUNDING.md, NORMALIZATION.md, and
  LABELS.md. It contains the amount codec and text parser, rounding, the
  `import/v1` normalization, the label PRF, and a strict JSON reader
  that rejects duplicate keys. It decodes and encodes every message type
  and State document, rejecting unknown fields and stopping on an
  unknown `v` or type. It has the chart rules, fold-time and post-time
  validators, and folds for: journal segments (edits, the positional
  lock, freezing), balances, reversal anomalies, import consumption,
  lots with the basis check, and the budget (envelope available, To Be
  Budgeted). Recon and checkpoint verification are left to 0018 and 0028
  (0007).
- Space creation and the chart of accounts. A new device can create a
  set of books (a fresh key pair and symmetric root, with the space
  created on first authentication) and is shown a recovery key once, or
  connect to existing books with the space ID and recovery key.
  Credentials are kept in localStorage. The chart of accounts at
  `ledger/accounts` is loaded with one point read and rewritten whole,
  with the post-time rules checked before every write. Writes are
  compare-and-swap on the state chain's head, so an edit that loses a
  race is re-applied to the winner's chart rather than overwriting it. A
  first UI lists accounts by type and parent, and adds, renames, closes,
  and reopens them (0008).
- The opening-balances entry. A new Opening balances page takes each
  open asset and liability account's balance on the opening date (what a
  liability owes, as a positive number), or an investment account's lots
  with their real acquisition dates and total cost. It posts them as one
  `ledger.entry` to that date's `journal-YYYY` segment, against an
  equity account named "Opening Balances" in each commodity, added to
  the chart first if missing. Accounts are listed by their full path
  ("Vanguard › VTI"), so positions with the same name in different
  brokerages can be told apart. `LedgerSpace.postEntry` checks any entry
  against the post-time rules before posting it (0009).
- Manual entry. A New entry page takes a date, an optional memo, and any
  number of lines, each an account with a debit or a credit, and posts
  them as one `ledger.entry` to that date's `journal-YYYY` segment. One
  line per commodity may leave its amount blank and takes the remainder,
  as in ledger-cli. What each commodity is out of balance by is shown
  while typing, and the entry is checked in full, then confirmed, before
  it posts. Closed accounts are not offered. Lots and payees are left to
  0027 and 0036 (0010).
- Journal segment discovery and reads. The server can't list topics, so
  a new State document, `ledger/journal`, lists the years that have a
  `journal-YYYY` segment. A client adds a year there before its first
  post to that segment, and years are never removed.
  `LedgerSpace.loadJournalYears` reads the list, and
  `LedgerSpace.readSegment` fetches every message of a year's segment
  (paged by timestamp), checks that they form one unbroken hash chain,
  and returns them in chain order, decrypted and ready for
  `foldSegment`. A payload that can't be decrypted or parsed is folded
  as malformed. Routing for reversals, edits, and dismissals arrives
  with those message types (0014, 0015, 0023) (0011).
- The local projection (`src/projection/`). A SQLite database in OPFS,
  run in a worker, holds every replayed message of `state`,
  `checkpoints`, `budget`, `recon`, and each `journal-YYYY` segment,
  with payloads decrypted, plus the folds of them: transactions and
  postings with edits applied, per-segment balances, envelope
  allocations, checkpoint heads, anomalies, and halts. The log and the
  folds are versioned separately: a new projection version refolds from
  the local log, and a new log version downloads again. Amounts are
  `TEXT`, and sums run in `bigint`. Each topic has a watermark (head
  hash and `server_timestamp`), so reopening catches up from there. Live
  updates come over the WebSocket stream; a message that doesn't
  continue its chain makes that topic catch up, and live messages wait
  for any catch-up in progress. Only one tab opens the database; a
  second tab says so and takes over when the first closes. The chart of
  accounts shows each account's balance, and the header shows sync
  status. Signing out deletes the database. Replaying 10k entries takes
  about 0.5 s in Node, and one more entry about 0.1 s (0012).
- Per-account register: every split posted to an account, sorted by
  entry date and then chain position, with the running balance (summed
  in `bigint`), the effective payee and memo, and the transaction's
  other accounts. Reached from the nav or by clicking an account in the
  chart, and refreshed as the projection changes. Reversed entries and
  reversals are marked but not yet collapsed into their net (0014)
  (0013).
- Reversals: a "Reverse" action on any unreversed entry in the register
  posts a `ledger.reversal` with the inverse of the entry's effective
  splits (after edits), dated the entry's own date unless it is locked
  or its segment is frozen, and then today. It is checked against the
  post-time rules first: the target is a known, unreversed entry, the
  splits are its inverse, and the reversal's segment is open. The
  register shows an entry and its same-day reversal as one line with
  their net, in the reversal's place, and drops a pair that nets to zero
  once a replacement entry (`replaces`) names it; the replacement is
  marked "Corrected". A reversal on a later date stays its own line.
  "Show reversals" lists every line as posted. The projection now links
  reversals to their targets across segments and reports
  `reversed-twice` and `reversal-mismatch` anomalies across them too
  (0014).
- Reverse and re-enter: the reverse dialog's "Reverse and re-enter", or
  "Re-enter" on a reversed entry that has no replacement yet, opens the
  entry form as a copy of the entry with its effective accounts and
  memo, dated like its reversal. It posts with `replaces`, and only if
  the replaced entry is known, reversed, and not already replaced
  (0042).
- Editing entries: an "Edit" action on any entry in the register changes
  its memo, payee, and receipts, and moves its income and expense splits
  to other open income and expense accounts in the same currency, posted
  as a `ledger.edit` to the entry's segment with only the fields that
  changed. Categories are fixed on locked and reversed entries; the rest
  can still change. Receipts (PDF or images) are encrypted under a fresh
  key, uploaded as blobs on save, and opened by type sniffed from their
  bytes, never as HTML or SVG. Each edit is checked against the
  post-time rules first, which share the fold's per-edit rule and add
  that the new account is open, the payee exists, and the segment is
  open. `LedgerSpace.postEdits` packs larger batches into several
  messages, each under the server's size limit. Choosing a payee needs
  payees in `ledger/payees` (0036) (0015).
- Payees: the entry form and the edit dialog take a payee by name,
  suggesting the payees in `ledger/payees`. Names match regardless of
  case and spacing (the `import/v1` normalization), and a merged payee's
  name picks the payee it was merged into. A name that matches none is
  marked new and added with a random `payee_` ID just before the entry
  or edit posts, and nothing is written if it already exists. Posting
  checks the payee against the payee list freshly read from State.
  Re-entering a reversed entry keeps its payee (0036).
- Period close: a Close page closes a month, quarter, or year by posting
  a bare `ledger.checkpoint` that cites the current head of that year's
  segment, locking every entry posted there so far against category
  changes. A final close of a whole year also freezes the segment.
  Because the lock is positional, the form says how many entries dated
  after the period are already posted and will be locked too. The
  post-time rules (`closePostProblems`) refuse a frozen or unlisted
  segment, a segment after the period, a budget head, balances, and
  `final` on anything but a whole-year close. The page lists every
  close, marking any whose cited head hasn't synced yet. The projection
  keeps each close's period and message; `PROJECTION_VERSION` is 3
  (0016).
- Posts retry on a chain conflict. When another device posts to the same
  topic between reading its head and posting, the server's 409 is
  retried against the new head, up to five attempts, after which
  `TopicConflictError` says so. This covers every `LedgerSpace` post:
  entries, reversals, edits, and closes. A close is rebuilt on each
  attempt, so it cites its segment's newest head. The retry logic
  (`appendMessage`) sits behind a `TopicBackend` seam and is tested
  against a fake, like `updateDoc` (0017).
- Keys wrapped at rest. The private key and symmetric root are no longer
  stored in the clear. This device keeps, in IndexedDB, only the space
  ID, the server, whether a password is set, and one copy of the keys
  per passkey, wrapped under a key derived from that passkey's WebAuthn
  PRF output (AES-256-GCM, bound to the space and credential, with a `v`
  for the format). The password is OPAQUE: the server holds the keys
  wrapped under the export key. The app starts locked and unlocks with a
  passkey, the password, or the recovery key. It locks after 15 minutes
  without input, or from the Lock button, which drops the keys, the
  `LedgerSpace`, and the projection from memory. New books show the
  recovery key, then ask for a passkey (when the browser offers PRF)
  and/or a password, at least one. A new device connects with the space
  ID and either the password or the recovery key, and can then add its
  own passkey. Keys left in localStorage by older versions are protected
  on first open and then deleted (0033).
- The opening-balances view warns before opening an account twice. An
  entry counts as an opening if it posts to an "Opening Balances" equity
  account (any commodity, open or closed) and hasn't been reversed; the
  projection's `openings` query lists the accounts it opens. Each such
  account is marked with its opening date, and posting one again needs a
  second confirmation that names it and suggests a reversal instead
  (0035).
- Statement reconciliation (0018). The Reconcile page takes a
  statement's date and closing balance, offers each entry and reversal
  on an asset or liability account that isn't yet cleared, and when the
  cleared balance equals the closing balance posts the statement as one
  `ledger.recon` to the `recon` topic. The latest reconciliation can be
  redone, which posts a recon that `supersedes` it. The projection folds
  `recon` (its fold-time rules are now in SCHEMAS.md) and derives
  cleared status per account and transaction, never storing it on the
  transaction; the register marks reconciled lines, and the reversal
  dialog warns before reversing one. Two standing recons that clear the
  same transaction are reported as `cleared-twice`. `PROJECTION_VERSION`
  is 4.
- The reconciliation in progress is kept per account in this device's
  local storage, never in the space (0019). The ticked list, statement
  date, closing balance, and any redo survive leaving the page or
  reloading, and the Reconcile page reopens on the account last worked
  on. Finishing, cancelling a redo, or clearing everything drops the
  account's session; signing out deletes them all. Like the projection,
  it sits on the device in the clear (0043), and anything unreadable is
  dropped rather than reported.
- The projection staying decrypted in OPFS is documented and accepted,
  not fixed. The device's disk encryption is assumed; see "Design A" in
  the design doc (0043).
- CSV parsing and column mapping in the core (0020). Import profiles
  gained `encoding` (never guessed; decoded with `fatal: true`, and
  UTF-8 under `windows-1252` is refused), `skip_end_rows` for trailers,
  an optional `memo` column kept out of the label, and the `YY` date
  token. The CSV grammar is pinned under `import/v1` with test vectors
  in NORMALIZATION.md, implemented with `csv-parse` pinned at 7.0.3.
  SCHEMAS.md defines every row's outcome: pending, blank, and zero rows
  are skipped and reported, a blank `fitid` is flagged for manual entry,
  and a bad date or amount fails the import.
- Import rules in `ledger/rules` (0021). A rule may compare the memo
  column instead of the description (`field`) and match only money in
  or out (`sign`). The payee and the category are each taken from the
  first matching rule that sets a usable one, passing over a closed or
  unknown account, one in another commodity, or an unknown payee.
  `src/core/rules.ts` matches, chooses, and edits rules and checks a
  rewrite. `LedgerSpace` loads and rewrites the document, checking new
  or changed rules against the chart and payees.
- Import idempotency (0023). Each statement row gets an `import/v1`
  label, either from its `fitid` or from its date, amount, normalized
  description, and occurrence count within that date. Rows already
  consumed, by a split's `import_id` or a `ledger.dismiss`, are dropped
  before review. The projection tracks consumed labels across segments
  and reports a label used twice. `LedgerSpace` labels rows, posts
  dismissals, and refuses an entry or a match that would reuse a
  consumed label.
- CSV import page (0022). A new account gets a mapping profile from a
  guess at the file's layout, checked against a live preview. Review
  drops rows already imported, matches the rest against unconfirmed
  splits (the other side of a transfer, or an entry made by hand), and
  suggests which rows replace a pending charge imported earlier. Each
  row is added with the rules' category and payee, matched, replaced,
  or dismissed. Approving posts entries carrying the row's label and
  the uploaded file as `source`. A rule can be made from a row.
  `ledger/import-profiles` has post-time rules: profiles are never
  removed and never change their import ID scheme.
- Budget page (0024). Add, rename, close, and reopen envelopes in
  `ledger/budget`, choose the envelope each expense account is spent
  from, and allocate money to an envelope as a `ledger.allocation` on
  the `budget` topic. Each envelope shows what it has available, from
  the projection's new `available` query. `LedgerSpace.postAllocation`
  refuses an allocation to a closed envelope. Pairing is timeless:
  re-pairing an expense account moves all of its spending, past and
  future, and the page says how much before it does.
- `ledger.reallocation` (0037): a move between envelopes as one
  message on the `budget` topic, so it is never left half done. The
  codec checks two or more legs on distinct envelopes with non-zero
  amounts. The fold ignores a reallocation whole unless every leg names
  an envelope in its `cur` and the legs sum to zero; otherwise each leg
  adds to its envelope, and To Be Budgeted is unchanged.
  `LedgerSpace.postReallocation` also refuses a leg naming a closed
  envelope.
- Budget schedule (0025). The Budget page sets and removes an
  envelope's monthly steps in `ledger/budget`.
  `LedgerSpace.materializeSchedule` posts the allocations the schedule
  calls for through the current month that the `budget` topic doesn't
  hold yet, each dated the first of its month with its `allocation/v1`
  `idem`. It reads the whole topic and posts on the head it read, so a
  rival post makes it read again rather than post a month twice. It runs
  when the books open and after each schedule edit, and stops if the
  topic holds a message this version can't read.

### Changed

- `LedgerSpace.postEntry` takes whether the entry's segment is open,
  from the projection, so an entry can't be posted to a frozen year
  (0016).

- `updateDoc` writes nothing when the edit returns the document
  unchanged (0036).
- `@noble/hashes` is a direct dependency, and the only non-core import
  that `src/core` may use, for the label PRF's HKDF and HMAC (0007).
- Amounts are compared by value, not spelling, everywhere a schema rule
  says "equals" or "is zero" (0002).
- A checkpoint's `rounding` field names ROUNDING.md. No `v: 1`
  checkpoint figure depends on rounding, since released basis is posted,
  so the design doc no longer claims that checkpoint reproducibility
  does (0003).
- `label(ns, s)` does no normalization of its own. Each namespace
  normalizes only the user-derived fields of its input, so account IDs
  and `fitid`s keep their case (0004).
- Every label namespace carries a version, like every message type:
  `allocation/v1`, `recon-session/v1`, and `price/v1` (0005).
- Envelopes are no longer accounts in the chart. They live with their
  own `env_` IDs in a new State document, `ledger/budget`, together with
  which envelope each expense account is spent from (one envelope may
  fund several expense accounts, but an expense account is spent from at
  most one), the budgetable accounts, and the monthly schedule. It
  replaces `ledger/budget-schedule`. Since no journal split can name an
  `env_` ID, nothing can post to an envelope. `ledger/accounts` v1 drops
  `budgetable`, `envelope`, and `envelope_account`, and `LedgerSpace`
  loads and rewrites `ledger/budget`, checking its references against
  the chart. Allocations, checkpoint envelope balances, and the
  `allocation/v1` label take an `EnvelopeId`, with a new test vector in
  LABELS.md (0038).

- Amounts in the design doc's schema sketches are decimal strings, and
  every sketch carries `v` (0001).
- `budgetable` may be set on liability accounts, so credit-card spending
  leaves To Be Budgeted unchanged (0001).
- A reversal is routed by its own date, defaulting to the original's
  date when the original is unlocked and its segment is open (0001).
- `ledger.replacement` is not a separate type; a replacement is a
  `ledger.entry` with `replaces` (0001).

### Fixed

- Connecting a device with the recovery key now asks the server whether
  the books have a password, instead of assuming they don't and
  offering to set one (which failed with 409) (0053).
- Enter in the password and recovery key fields (lock screen, setup,
  and setting a password) submits even with the Apple Passwords
  extension, which kept the browser from submitting the form (0054).

- Appending a `ledger.edit` that names an entry in another segment no
  longer deletes that entry's rows from the projection until the next
  full refold. Such an edit is ignored, and a refold now only rewrites
  rows in its own segment. `PROJECTION_VERSION` is 2 (0014).
