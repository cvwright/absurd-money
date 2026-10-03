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
