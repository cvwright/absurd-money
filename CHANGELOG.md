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

### Changed

- Amounts in the design doc's schema sketches are decimal strings, and every sketch
  carries `v` (0001).
- `budgetable` may be set on liability accounts, so credit-card spending leaves To Be
  Budgeted unchanged (0001).
- A reversal is routed by its own date, defaulting to the original's date when the
  original is unlocked and its segment is open (0001).
- `ledger.replacement` is not a separate type; a replacement is a `ledger.entry` with
  `replaces` (0001).
