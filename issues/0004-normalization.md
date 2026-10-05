# 0004: Normalization for import identifiers

## Context

Derived labels let the same thing be recognized again without an index,
so two clients must normalize identically. Changing the normalization
silently mints new labels for old things. That makes normalization part
of the security boundary, and it must be pinned and versioned. See
"Opaque identifiers" in [design/ACCOUNTING.md](../design/ACCOUNTING.md).

This issue started as payee normalization. That part is gone (see
Resolved below). What is left is normalizing the description field of
CSV rows that have no `fitid`, as input to the derived import ID
in 0023.

## Acceptance criteria

- `import/v1` description normalization specified in `design/` (in
  SCHEMAS.md or a short NORMALIZATION.md):
  1. Unicode NFKC
  2. Case folding. `toLowerCase()` after NFKC is *not* the same as full
     case folding for all scripts; pick one and document it.
  3. Collapse runs of whitespace to one space; trim.
  4. Punctuation: probably leave it alone. Unlike payee names, the goal
     is only that the *same bank* exporting the *same row* twice gives
     the same string, so normalization should be minimal.
     Over-normalizing risks merging distinct rows.
- Test vectors that pin the output byte for byte, shared by any future
  client.

## Resolved

- **Payees get random IDs (decided).** Bank merchant strings are noisy
  and keep changing (`SQ *BLUE BOTTLE 0412`,
  `SQ *BLUE BOTTLE COFFEE 88`). No fixed normalization collapses them
  correctly, and any heuristic that improves would change every derived
  label. So payees get random `payee_` IDs in one State document at
  `ledger/payees`, and **import rules** in `ledger/rules` map raw
  merchant strings to payees. The fuzzy matching lives in editable data;
  the IDs never move. Random was chosen over a PRF of the canonical name
  because it is simpler and survives renames. Design doc updated.

## Resolution

2026-10-03. Pinned in
[design/NORMALIZATION.md](../design/NORMALIZATION.md), with test
vectors.

- Steps: well-formed (lone surrogates to U+FFFD), NFKC, `toLowerCase()`
  without a locale, then collapse and trim an explicit 25-code-point
  whitespace set. Punctuation, control and format characters, and
  accents are left alone.
- Case: `toLowerCase()` rather than full case folding. They differ only
  where the spelling changes (`ß` against `SS`, final sigma), which a
  re-export doesn't do. Lowercase is native everywhere, so no folding
  table has to ship.
- Whitespace is an explicit list, not `\s` or `trim()`, which differ
  across engines and languages.
- Checked that the function is idempotent, so rule patterns can be
  stored normalized. Node (Unicode 17) and Python (Unicode 16) agree on
  every code point except 29 new in Unicode 17; the accepted risk is
  documented.
- Also pinned: the full label input for both 0023 schemes, and `fitid`
  normalization (trim only, case kept). ACCOUNTING.md's `label` formula
  no longer normalizes the whole input, which would have case-folded
  account IDs.
- Deferred to [0020](0020-csv-parsing.md): pinning how the CSV's bytes
  are decoded into text (a profile `encoding` field), since the
  normalization starts from decoded text.
