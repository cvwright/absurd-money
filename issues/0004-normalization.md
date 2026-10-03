# 0004: Normalization for import identifiers

## Context

Derived labels let the same thing be recognized again without an index, so two clients
must normalize identically. Changing the normalization silently mints new labels for old
things. That makes normalization part of the security boundary, and it must be pinned and
versioned. See "Opaque identifiers" in [design/ACCOUNTING.md](../design/ACCOUNTING.md).

This issue started as payee normalization. That part is gone (see Resolved below). What is
left is normalizing the description field of CSV rows that have no `fitid`, as input to
the derived import ID in 0023.

## Acceptance criteria

- `import/v1` description normalization specified in `design/` (in SCHEMAS.md or a short
  NORMALIZATION.md):
  1. Unicode NFKC
  2. Case folding. `toLowerCase()` after NFKC is *not* the same as full case folding for
     all scripts; pick one and document it.
  3. Collapse runs of whitespace to one space; trim.
  4. Punctuation: probably leave it alone. Unlike payee names, the goal is only that the
     *same bank* exporting the *same row* twice gives the same string, so normalization
     should be minimal. Over-normalizing risks merging distinct rows.
- Test vectors that pin the output byte for byte, shared by any future client.

## Resolved

- **Payees get random IDs (decided).** Bank merchant strings are noisy and keep changing
  (`SQ *BLUE BOTTLE 0412`, `SQ *BLUE BOTTLE COFFEE 88`). No fixed normalization collapses
  them correctly, and any heuristic that improves would change every derived label. So
  payees get random `payee_` IDs in one State document at `ledger/payees`, and **import
  rules** in `ledger/rules` map raw merchant strings to payees. The fuzzy matching lives in
  editable data; the IDs never move. Random was chosen over a PRF of the canonical name
  because it is simpler and survives renames. Design doc updated.
