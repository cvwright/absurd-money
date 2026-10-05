# 0020: CSV parsing and column mapping

## Context

A CSV import parses the file locally and maps its columns to fields
using the account's profile in `ledger/import-profiles` (see
[design/SCHEMAS.md](../design/SCHEMAS.md)). Amount cells go through
`parseDecimal` in [design/AMOUNTS.md](../design/AMOUNTS.md). The
description cell feeds the `import/v1` label, as specified in
[design/NORMALIZATION.md](../design/NORMALIZATION.md). The idempotency
scheme is in 0023.

## Acceptance criteria

- **Pin how the file's bytes are decoded.** NORMALIZATION.md starts from
  the decoded string, so decoding is part of the label input. If two
  clients decode the same Windows-1252 export differently (one as UTF-8
  with U+FFFD replacements, one as Windows-1252), they get different
  descriptions and different labels, and the next import of an
  overlapping statement posts every non-ASCII row again. The `Profile`
  schema has no field for this yet. Probably:
  - Add an optional `encoding` to `Profile`, a WHATWG Encoding Standard
    label (`"utf-8"`, `"windows-1252"`, …) passed to `TextDecoder`, with
    `"utf-8"` as the default. The Encoding Standard pins the mapping
    tables, so every browser decodes the same way.
  - Decode with `fatal: true`, so a file in the wrong encoding fails
    loudly instead of minting labels from U+FFFD.
  - Remove a leading BOM (the `TextDecoder` default).
  - Never guess the encoding at import time. A guess the UI makes when
    the profile is created is fine, as long as the result is stored in
    the profile.
- Combine debit/credit columns and apply `negate` before computing the
  amount for the label (AMOUNTS.md, "Canonical decimal form").
- Blank amount cells, and blank `fitid` cells in a `fitid` profile, have
  a defined outcome: either the row is skipped or the import fails, not
  left undefined.

## Notes

The schema change has to land before the first `ledger/import-profiles`
document is written, since schemas are permanent once posted.
