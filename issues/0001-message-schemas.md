# 0001: Message schemas

## Context

Every message posted to a topic is permanent, so its schema is too. The design decisions
that constrain the schemas are spread across [design/ACCOUNTING.md](../design/ACCOUNTING.md).
This issue collects them in one place so that `design/SCHEMAS.md`, the deliverable, misses
none of them.

## Acceptance criteria

- `design/SCHEMAS.md` exists and specifies every message type and State document below,
  field by field, with types and invariants.
- Each item in the checklist is either reflected in the spec or explicitly rejected, with
  the reason recorded here.

## Checklist: cross-cutting

- [x] **Message types stay cleartext (decided: risk accepted).** The reeeductio message
  `type` field sits outside the encrypted `data`
  ([types.ts](https://github.com/reeeductio/reeeductio/blob/main/typescript-sdk/src/types.ts)),
  so the server sees how often you post entries, edits, reversals, and dismissals. Hiding
  it isn't worth it: a PRF over a handful of type names still leaks the categories through
  their frequencies, and ciphertext size and timing leak most of the rest. Recorded under
  "Residual leakage" in the design doc.
- [x] `v` on every message type and every State document.
- [x] Amounts are decimal **strings**, never JSON numbers. The schema sketch in the design
  doc still shows numbers (`"amount": -8423`) and must be corrected. Every amount carries
  `exp` and `cur`.
- [x] Referencing other messages:
  - An entry is referenced by its `message_hash`. A split is `{message_hash}#{index}`.
  - References may cross yearly segments. A reference carries the hash only, never the
    segment.
- [x] Payees are random `payee_` IDs, like accounts. Import references are opaque labels
  (0023). Neither is ever a raw string.
- [x] No padding to size buckets (decided). Ciphertext length reveals roughly the number
  of splits; accepted with the rest of the metadata leakage.

## Checklist: journal segment messages (`journal-YYYY`)

- [x] **`ledger.entry`**
  - Fields: `date`, `payee`, `memo`, `splits[]`, `receipts[]`, `import_id`.
  - Each split: `account`, `amount`, `exp`, `cur`.
  - Optional on a split: `cost` and `acquired`, on lot-creating splits.
  - Optional on a split: `from_lots: [{lot, qty, acquired}]`, on disposals.
  - Each receipt: `{blob, dek}`.
  - Invariant: the splits sum to zero per commodity.
- [x] **`ledger.reversal`**
  - Cites an entry hash and posts the inverse splits of the **effective** accounts, i.e.
    after any edits.
  - Routed to the original entry's segment if that segment is open. Otherwise it goes in
    the current year.
  - Open question: date the reversal like the original, or with today's date?
- [x] **`ledger.replacement`**: Is it a distinct type, or just a `ledger.entry` with a
  `replaces` reference? Prefer the latter.
- [x] **`ledger.edit`**: `edits: [{target, memo?, payee?, receipts?, splits?: {index:
  account}}]`.
  - Every target lives in the same segment as the edit.
  - An edit to a split account is valid only between income/expense accounts, and only on
    unlocked entries.
  - What does an edit to `receipts` do: replace the list, or add to it? Prefer replace,
    since the latest edit wins.
- [x] **`ledger.dismiss`**: cites an import label. It is routed to the segment of the
  staging item's date.
- [x] **`ledger.lotadjust`**: for stock splits. Exempt from sum-to-zero. Carries the lot,
  the old and new quantity, and leaves basis and acquisition date unchanged.

## Checklist: other topics

- [x] **`budget` → `ledger.allocation`**
  - Fields: `date`, `envelope`, `amount`, `exp`, `cur`.
  - Optional `idem` label, `label("allocation", "{envelope}|{period}")`, on materialized
    allocations.
  - Exempt from sum-to-zero.
- [x] **`recon`**
  - Fields: `account`, `statement_date`, `closing_balance`, `cleared: [hash]`.
  - The cleared hashes may span two segments.
  - Optional `statement` blob reference with its DEK.
- [x] **`checkpoints` → close and checkpoint, one type**
  - `period` label.
  - `heads`: one `{segment, hash}` per journal segment, plus the `budget` head.
  - `final: bool`, which freezes a segment.
  - Optional, for full checkpoints: the balance vector, envelope balances, open lots with
    remaining quantity and basis, and the prices used.
  - `rounding: "v1"`.
  - Open question: does a close cite a position in *every* open segment, or one segment?

## Checklist: State documents

- [x] `ledger/accounts`: `{v, rev, accounts: {id: {name, type, cur, parent, closed_at?}}}`.
  Is `budgetable` a flag on asset accounts? Does an envelope point at its paired expense
  account, or the other way around?
- [x] `ledger/budget-schedule`: `{v, rev, envelopes: {id: [{from, monthly}]}}`.
- [x] `ledger/payees`: one document, `{v, rev, payees: {payee_id: {name, …}}}`. Random IDs,
  decided in 0004.
- [x] `ledger/rules`: one document, since rules are read in bulk and there is no prefix
  listing. Each rule matches a raw merchant string and assigns a payee and optionally an
  account.
- [x] `ledger/import-profiles`: one document of CSV mapping profiles keyed by account ID
  (0023).

## Notes

- Lot IDs depend on the final `message_hash`, which changes when a post is retried after a
  chain conflict. The schema must never require a lot ID to be known before the post
  succeeds.
- Related: 0002 (amount codec), 0003 (rounding policy), 0004 (import normalization),
  0005 (label derivation), 0023 (import IDs).

## Resolution

2026-10-03. [design/SCHEMAS.md](../design/SCHEMAS.md) specifies every message type and
State document. The schema sketches in ACCOUNTING.md now use string amounts and carry `v`.
Decisions made along the way, including answers to the open questions above:

- **Strict versioning.** Unknown fields make a message invalid, and an unknown `v` stops
  the fold instead of skipping the message, because a skipped ledger fact means wrong
  balances.
- **Post-time vs fold-time validation.** Fold-time rules depend only on messages and on
  State facts that never change. That is why an account's `type` and `cur` are now
  immutable. Messages that fail a fold-time rule are ignored and surfaced, never repaired.
- **One commodity per account.** A split's `cur` must equal its account's `cur`. This
  matches the brokerage examples, which already use one account per position. Relaxing it
  later would mean accepting more, not less.
- **Reversals carry explicit splits** rather than deriving them, so a reversal of a
  frozen-year entry is readable from the current segment. The check against the target's
  effective splits is an anomaly check, not a validity rule. Reversing a lot-creating
  entry voids its lots, and reversing a disposal voids its draws.
- **Reversal date (open question):** the reversal is routed by its own `date`. The client
  defaults it to the original's date when the original is unlocked and its segment is
  open, and to today otherwise. This generalizes the routing rule in ACCOUNTING.md, which
  was updated.
- **`ledger.replacement` rejected** as a type. It is a `ledger.entry` with `replaces`.
- **Edits:** `receipts` replaces the list; `memo: null` and `payee: null` clear. Semantic
  rules apply per edit, so one stale item doesn't void a bulk recategorization. Account
  edits on a reversed entry are invalid, so the reversal stays the inverse of the effective
  splits.
- **`import_id` moved from the entry to the split.** A row comes from one account's file
  and confirms only that side, so a transfer carries one label per side. A split with no
  label is unconfirmed, which turns dedupe into one query: an unconfirmed split in the
  same account with the same amount and a nearby date. A match is recorded by a
  `ledger.edit` that sets the label (set-once), routed to the target's segment, which is
  open until its final close; only a frozen target falls back to `ledger.dismiss`, which
  takes a list of labels. Entries gained an optional `source` blob for
  the imported file (0023).
- **Disposals copy `basis` per lot** next to `acquired`, so a segment alone supports
  Form 8949 per lot.
- **`ledger.lotadjust`** carries the account and covers many lots in one message. Disposals
  are in pre- or post-split units according to their date relative to the adjustment's,
  since chain order is undefined across segments. The trading account keeps its pre-split
  quantity, which is accepted.
- **Close scope (open question):** a close cites only the segments it locks, and `final`
  is per head. A full checkpoint cites every journal segment plus `budget`. `rounding` is
  required on every checkpoint, including a bare close.
- **`ledger.recon`** gained an optional `supersedes`, so a mistaken reconciliation can be
  replaced without a per-transaction flag.
- **Envelope pairing (open question):** the expense account points at its envelope
  (`envelope_account`), so each expense has at most one envelope by construction.
  Envelopes are equity accounts with `envelope: true`.
- **`budgetable` (open question):** a flag on asset **and liability** accounts. Without
  liabilities, card spending would raise To Be Budgeted. ACCOUNTING.md was updated.
- **Payees** gained `merged_into` for duplicates, since IDs never move.
- **Duplicate `idem` allocations:** the first one in the `budget` chain counts.

Still open elsewhere: amount parsing (0002), the rounding policy that `"v1"` names (0003),
normalization for rule patterns and import IDs (0004), label derivation (0005), and the
checkpoint trust model (ACCOUNTING.md open questions).
