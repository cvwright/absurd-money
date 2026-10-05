# 0020: CSV parsing and column mapping

## Context

A CSV import parses the file locally and maps its columns to fields
using the account's profile in `ledger/import-profiles` (see
[design/SCHEMAS.md](../design/SCHEMAS.md)). Amount cells go through
`parseDecimal` in [design/AMOUNTS.md](../design/AMOUNTS.md). The
description cell feeds the `import/v1` label, as specified in
[design/NORMALIZATION.md](../design/NORMALIZATION.md). The idempotency
scheme is in 0023.

**Every Profile field must be settled before the first profile is
written.** State decoders reject unknown fields, so a field added later
makes older clients fail to decode the whole `ledger/import-profiles`
document, losing every profile, not just the new one.

## Decisions

### Profile schema additions

- **`encoding`** (optional, default `"utf-8"`): the canonical name of a
  WHATWG Encoding Standard encoding, passed to `TextDecoder`. Only
  canonical names are valid, not aliases (`"latin1"` and `"ascii"` both
  decode as `"windows-1252"`), so one encoding has one spelling. Allowed
  for now: `utf-8`, `utf-16le`, `utf-16be`, `windows-1252`.
- **`YY` date token**: a two-digit year, read as 20YY.
- **`memo`** (optional, `{column}`): a second text column, for exports
  that split the text into "Description" + "Memo" or similar. The memo
  is **not** part of the `import/v1` label input. It is shown in review
  and is available to import rules. Memo text is less stable than the
  description (banks rewrite it between pending and posted), and leaving
  it out means no join rule to pin. The occurrence counter already keeps
  apart rows that differ only in memo. When a bank puts generic text in
  its description column ("POS PURCHASE") and the merchant in the memo
  column, the profile maps `description` to the memo column instead.

Not added: month-name tokens (`MMM`), which bring locale questions, and
date cells with a time of day, which are an error.

### Decoding the bytes

NORMALIZATION.md starts from the decoded string, so decoding is part of
the label input. If two clients decode the same Windows-1252 export
differently, they get different labels, and the next import of an
overlapping statement posts every non-ASCII row again.

- Decode with the profile's `encoding` and `fatal: true`, so a file that
  is not valid UTF-8 fails loudly instead of minting labels from U+FFFD.
- `fatal` never fires for `windows-1252`, which maps all 256 bytes. If
  the profile names a single-byte encoding and the bytes are valid UTF-8
  that contains non-ASCII, refuse the import and point to the profile.
- Remove a leading BOM only if it matches the encoding (the
  `TextDecoder` default). A UTF-8 BOM in a file decoded as
  `windows-1252` is valid UTF-8, so the check above rejects the file.
- Never guess the encoding at import time. A guess the UI makes when the
  profile is created is fine, as long as the result is stored in the
  profile.

### CSV grammar (pinned under `import/v1`)

The parsed description cell is the label input, so the grammar is pinned
along with normalization, and specified with test vectors in
NORMALIZATION.md. The vectors are the spec, not any library's behavior.

**Parser: [`csv-parse`](https://csv.js.org/parse/), the same one
Actual Budget uses.** Libraries disagree on malformed
input: PapaParse silently merges cells after a bad quote, and `d3-dsv`
reports no errors at all. `csv-parse` is strict by default, with
specific error codes. It is wrapped by one `parseCsv` module in
`src/core/`, which gets the only ESLint exception to the core import
rule. Its version is pinned exactly, with no `^`. An upgrade is treated
like a schema change: it must pass every vector, and a major version
needs a review. If it can't be made to meet the spec, we write our own
parser against the same vectors.

Options: `delimiter` from the profile, `quote: '"'`, `relax_quotes:
true`, `relax_column_count: true`, `skip_empty_lines: true`, `bom:
false`, `trim: false`.

- RFC 4180 quoting: the quote is `"`, escaped as `""`. Quoted fields may
  contain the delimiter and line breaks.
- A `"` that doesn't open a field is a literal: `5" PIZZA` is
  `5" PIZZA`, and `"abc"def` is `"abc"def` (`relax_quotes`). Bank
  exports really do contain the first. An unterminated quote is an
  error.
- CRLF, LF, and a lone CR each end a record. Empty lines are ignored.
- The BOM is left to the decoder (`bom: false`), so a mismatched one
  still fails the header match.
- `skip_rows` counts physical lines, before CSV parsing, because
  preambles are often not valid CSV.
- Cell whitespace is kept. The description is normalized later, and the
  amount and date parsers trim.
- Header names match exactly after trimming. A header name the profile
  uses that appears twice is an error, and so is a row too short to
  contain a column the profile uses.

### Amounts and row outcomes

- Combine debit/credit columns and apply `negate` before computing the
  amount for the label (AMOUNTS.md, "Canonical decimal form").
- `debit` is the column that lowers the amount posted to the account.
  The amount is credit − debit, ignoring any sign written in either
  cell. A cell that is blank or parses to zero counts as empty. Both
  non-empty fails the import. Both blank is a blank amount, and a zero
  in either with nothing else is a zero amount.
- A row with a blank amount is skipped and reported in review ("3 rows
  skipped: no amount"). These are balance rows or memo continuations,
  never transactions.
- A row whose amount is zero is skipped and reported. A zero split is
  invalid.
- A row with a blank `fitid` in a `fitid` profile is skipped and flagged
  for manual entry. It can't fall back to the row scheme, since 0023
  forbids mixing schemes for one account.
- Rows matching `pending` are skipped. The trimmed cell must equal
  `value` exactly.

## Acceptance criteria

- `encoding`, `YY`, and `memo` are in the Profile schema
  (SCHEMAS.md and the decoder) before any profile is written.
- The CSV grammar is specified with test vectors in NORMALIZATION.md.
- `csv-parse` is an exact-pinned dependency, imported only by the core
  `parseCsv` wrapper, with a matching ESLint exception. The vectors run
  against it in `npm test`.
- The row outcomes above are in SCHEMAS.md.
- `src/core/` has `decodeBytes(bytes, profile)`, `parseCsv(text,
  delimiter)`, and `mapRows(records, profile)`, which returns the mapped
  rows plus the skipped and flagged ones with reasons. All are covered
  by vitest.

## Resolution

2026-10-04. Done as specified, plus `skip_end_rows` (optional, default
0) for trailers such as a totals line, which would otherwise fail every
import from that bank. The Profile codec in `messages.ts` gained
`encoding`, `skip_end_rows`, `memo`, and the `YY` token, and rejects a
quote or line break as the delimiter. SCHEMAS.md has the new fields and
"Reading a file", with the row outcomes. NORMALIZATION.md has "CSV
grammar" and its vectors.

`csv-parse` is pinned at 7.0.3 (published 2026-09-25, no dependencies).
`src/core/csv.ts` imports its browser build,
`csv-parse/browser/esm/sync`, because the default ESM build uses Node's
global `Buffer`. The browser build bundles a polyfill, so vitest runs
the same code the app ships. It also reports record line numbers from
`raw`, since csv-parse's own count treats a quoted CRLF as two lines.

`src/core/csv-import.ts` has `decodeBytes`, `skipLines`, `parseDate`,
`mapRows` (rows, skipped rows with reasons, and flagged blank-`fitid`
rows), and `readStatement`, which chains them. Computing `n` and the
labels is 0023's.
