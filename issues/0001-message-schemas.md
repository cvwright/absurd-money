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
- [ ] `v` on every message type and every State document.
- [ ] Amounts are decimal **strings**, never JSON numbers. The schema sketch in the design
  doc still shows numbers (`"amount": -8423`) and must be corrected. Every amount carries
  `exp` and `cur`.
- [ ] Referencing other messages:
  - An entry is referenced by its `message_hash`. A split is `{message_hash}#{index}`.
  - References may cross yearly segments. A reference carries the hash only, never the
    segment.
- [ ] Payees are random `payee_` IDs, like accounts. Import references are opaque labels
  (0023). Neither is ever a raw string.
- [x] No padding to size buckets (decided). Ciphertext length reveals roughly the number
  of splits; accepted with the rest of the metadata leakage.

## Checklist: journal segment messages (`journal-YYYY`)

- [ ] **`ledger.entry`**
  - Fields: `date`, `payee`, `memo`, `splits[]`, `receipts[]`, `import_id`.
  - Each split: `account`, `amount`, `exp`, `cur`.
  - Optional on a split: `cost` and `acquired`, on lot-creating splits.
  - Optional on a split: `from_lots: [{lot, qty, acquired}]`, on disposals.
  - Each receipt: `{blob, dek}`.
  - Invariant: the splits sum to zero per commodity.
- [ ] **`ledger.reversal`**
  - Cites an entry hash and posts the inverse splits of the **effective** accounts, i.e.
    after any edits.
  - Routed to the original entry's segment if that segment is open. Otherwise it goes in
    the current year.
  - Open question: date the reversal like the original, or with today's date?
- [ ] **`ledger.replacement`**: Is it a distinct type, or just a `ledger.entry` with a
  `replaces` reference? Prefer the latter.
- [ ] **`ledger.edit`**: `edits: [{target, memo?, payee?, receipts?, splits?: {index:
  account}}]`.
  - Every target lives in the same segment as the edit.
  - An edit to a split account is valid only between income/expense accounts, and only on
    unlocked entries.
  - What does an edit to `receipts` do: replace the list, or add to it? Prefer replace,
    since the latest edit wins.
- [ ] **`ledger.dismiss`**: cites an import label. It is routed to the segment of the
  staging item's date.
- [ ] **`ledger.lotadjust`**: for stock splits. Exempt from sum-to-zero. Carries the lot,
  the old and new quantity, and leaves basis and acquisition date unchanged.

## Checklist: other topics

- [ ] **`budget` → `ledger.allocation`**
  - Fields: `date`, `envelope`, `amount`, `exp`, `cur`.
  - Optional `idem` label, `label("allocation", "{envelope}|{period}")`, on materialized
    allocations.
  - Exempt from sum-to-zero.
- [ ] **`recon`**
  - Fields: `account`, `statement_date`, `closing_balance`, `cleared: [hash]`.
  - The cleared hashes may span two segments.
  - Optional `statement` blob reference with its DEK.
- [ ] **`checkpoints` → close and checkpoint, one type**
  - `period` label.
  - `heads`: one `{segment, hash}` per journal segment, plus the `budget` head.
  - `final: bool`, which freezes a segment.
  - Optional, for full checkpoints: the balance vector, envelope balances, open lots with
    remaining quantity and basis, and the prices used.
  - `rounding: "v1"`.
  - Open question: does a close cite a position in *every* open segment, or one segment?

## Checklist: State documents

- [ ] `ledger/accounts`: `{v, rev, accounts: {id: {name, type, cur, parent, closed_at?}}}`.
  Is `budgetable` a flag on asset accounts? Does an envelope point at its paired expense
  account, or the other way around?
- [ ] `ledger/budget-schedule`: `{v, rev, envelopes: {id: [{from, monthly}]}}`.
- [ ] `ledger/payees`: one document, `{v, rev, payees: {payee_id: {name, …}}}`. Random IDs,
  decided in 0004.
- [ ] `ledger/rules`: one document, since rules are read in bulk and there is no prefix
  listing. Each rule matches a raw merchant string and assigns a payee and optionally an
  account.
- [ ] `ledger/import-profiles`: one document of CSV mapping profiles keyed by account ID
  (0023).

## Notes

- Lot IDs depend on the final `message_hash`, which changes when a post is retried after a
  chain conflict. The schema must never require a lot ID to be known before the post
  succeeds.
- Related: 0002 (amount codec), 0003 (rounding policy), 0004 (import normalization),
  0005 (label derivation), 0023 (import IDs).
