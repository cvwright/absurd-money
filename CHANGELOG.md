# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Design document [design/ACCOUNTING.md](design/ACCOUNTING.md), describing the data model
  on reeeductio Spaces.
- `ledger.edit`: recategorization and annotation as Matrix-style overlay events in the
  journal, replacing per-transaction `ledger/txmeta` State.
- One logical ledger for all time, stored physically as yearly `journal-YYYY` topics, so
  a single tax year can be shared by handing over that topic's key.
- Opening-balances entry, period close, and the positional lock rule.
- Import consumption derived from journal `import_id` labels; dismissal via
  `ledger.dismiss`.
- Payees get random IDs in one State document; import rules map raw merchant strings to
  payees.
- Client-side CSV import with local review; `import-staging` reserved for a possible
  future bank-sync tool account.
- Message `type` fields stay cleartext; the leakage is documented and accepted.
- [design/SCHEMAS.md](design/SCHEMAS.md): field-by-field `v: 1` schemas for every message
  type and State document, with post-time and fold-time validation rules (0001).
- [design/AMOUNTS.md](design/AMOUNTS.md): the amount codec. Strict decoding, exact
  arithmetic with no rounding, a text parser that never rounds, the canonical decimal form
  hashed into `import/v1` labels, the projection encoding, and test vectors (0002).
- `decimal` field on import profiles, for exports that use a decimal comma (0002).
- [design/ROUNDING.md](design/ROUNDING.md): the rounding policy. Basis released by a
  partial disposal is floored at the lot cost's exponent, the lot keeps the remainder, and
  the depleting draw takes the rest. It pins the order in which a lot's draws are checked,
  defines largest-remainder allocation and exact valuation, and includes test vectors
  (0003).
- [design/NORMALIZATION.md](design/NORMALIZATION.md): the `import/v1` description
  normalization (well-formed, NFKC, locale-free lowercase, a pinned whitespace set
  collapsed and trimmed, punctuation kept), `fitid` trimming, the exact label input for
  both import ID schemes, and test vectors (0004).

### Changed

- Amounts are compared by value, not spelling, everywhere a schema rule says "equals" or
  "is zero" (0002).
- A checkpoint's `rounding` field names ROUNDING.md. No `v: 1` checkpoint figure depends
  on rounding, since released basis is posted, so the design doc no longer claims that
  checkpoint reproducibility does (0003).
- `label(ns, s)` does no normalization of its own. Each namespace normalizes only the
  user-derived fields of its input, so account IDs and `fitid`s keep their case (0004).

- Amounts in the design doc's schema sketches are decimal strings, and every sketch
  carries `v` (0001).
- `budgetable` may be set on liability accounts, so credit-card spending leaves To Be
  Budgeted unchanged (0001).
- A reversal is routed by its own date, defaulting to the original's date when the
  original is unlocked and its segment is open (0001).
- `ledger.replacement` is not a separate type; a replacement is a `ledger.entry` with
  `replaces` (0001).
