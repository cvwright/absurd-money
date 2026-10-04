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
- [design/LABELS.md](design/LABELS.md): the label PRF. HKDF-SHA256 from the space's
  `symmetric_root` to a `label_key` and one key per namespace, HMAC-SHA256 truncated to
  15 bytes, base64url. It pins the namespace registry and each namespace's input, rejects
  ill-formed strings, and includes test vectors checked against Python and the SDK's
  `@noble/hashes` (0005).
- Project scaffold: Lit 3, Vite, and vite-plugin-pwa, linked to the local reeeductio
  TypeScript SDK, with strict TypeScript, ESLint, and vitest. ESLint keeps `src/core`
  pure: it may import only other core modules and cannot touch DOM or network globals
  (0006).
- `src/core/`: the pure-TypeScript core, with vitest tests that pass every vector in
  AMOUNTS.md, ROUNDING.md, NORMALIZATION.md, and LABELS.md. It contains the amount codec
  and text parser, rounding, the `import/v1` normalization, the label PRF, and a strict
  JSON reader that rejects duplicate keys. It decodes and encodes every message type and
  State document, rejecting unknown fields and stopping on an unknown `v` or type. It has
  the chart rules, fold-time and post-time validators, and folds for: journal segments
  (edits, the positional lock, freezing), balances, reversal anomalies, import
  consumption, lots with the basis check, and the budget (envelope available, To Be
  Budgeted). Recon and checkpoint verification are left to 0018 and 0028 (0007).

### Changed

- `@noble/hashes` is a direct dependency, and the only non-core import that `src/core`
  may use, for the label PRF's HKDF and HMAC (0007).
- Amounts are compared by value, not spelling, everywhere a schema rule says "equals" or
  "is zero" (0002).
- A checkpoint's `rounding` field names ROUNDING.md. No `v: 1` checkpoint figure depends
  on rounding, since released basis is posted, so the design doc no longer claims that
  checkpoint reproducibility does (0003).
- `label(ns, s)` does no normalization of its own. Each namespace normalizes only the
  user-derived fields of its input, so account IDs and `fitid`s keep their case (0004).
- Every label namespace carries a version, like every message type: `allocation/v1`,
  `recon-session/v1`, and `price/v1` (0005).

- Amounts in the design doc's schema sketches are decimal strings, and every sketch
  carries `v` (0001).
- `budgetable` may be set on liability accounts, so credit-card spending leaves To Be
  Budgeted unchanged (0001).
- A reversal is routed by its own date, defaulting to the original's date when the
  original is unlocked and its segment is open (0001).
- `ledger.replacement` is not a separate type; a replacement is a `ledger.entry` with
  `replaces` (0001).
