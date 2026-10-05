# 0046: Richer patterns in import rules

## Context

Import rules (`ledger/rules` in
[design/SCHEMAS.md](../design/SCHEMAS.md), 0021) match with `contains`,
`prefix`, or `equals` against the description or memo after `import/v1`
normalization ([design/NORMALIZATION.md](../design/NORMALIZATION.md)).
Regular expressions were left out of `v: 1`. `op` is an enum, so a new
value is a schema change like a new field: the decoder rejects the
whole document, and adding one means `ledger/rules` `v: 2`.

Do this only if real statements show a need. Ordered literal rules
cover most cases:

| Case | Without regex |
|---|---|
| Store numbers that vary (`SQ *BLUE BOTTLE 0412`) | `contains "blue bottle"` |
| Alternation (`starbucks\|peet's`) | Two rules with the same target |
| Varying tail (`AMZN MKTP US*2K4…`) | `prefix "amzn mktp"` |
| Wildcard in the middle (`check #\d+ to landlord`) | **Not covered.** `contains` matches one fixed run of text. |

## Problems with full regular expressions

- **Normalization.** Patterns are stored normalized, and the decoder
  checks it. Lowercasing changes what a regex means: `\S` becomes `\s`,
  `\D`, `\W`, and `\B` invert, and `\p{Lu}` becomes invalid. Regex
  patterns would need an exemption: stored as written, matched against
  the normalized text, and rejected if they contain uppercase. The
  author has to know the text is already lowercased and its whitespace
  collapsed.
- **Dialect.** Every client must choose the same payee and category.
  JavaScript, Python `re`, ICU, and Swift differ on `\d` and `\w`
  outside ASCII, lookbehind, and `u`/`v` mode. A pinned portable subset
  is needed, likely I-Regexp
  ([RFC 9485](https://www.rfc-editor.org/rfc/rfc9485)): no
  backreferences or lookaround, and matching is of the whole string, so
  "contains" is `.*x.*`. It must be validated at decode time, by our
  own validator or a pinned library, under the same rules as
  `csv-parse` in 0020. A disagreement is milder than in labels, since
  rules only suggest, but it still breaks the "choose the same way"
  rule.
- **ReDoS.** I-Regexp still allows `(a+)+$`, and JavaScript backtracks,
  so one pattern can hang review for a whole statement. Once sharing
  (0031) lets another member write State, one member could freeze
  another's import. It needs some combination of a length cap,
  rejecting nested quantifiers, and matching in a worker with a timeout.

## Options

1. **Fragments in order.** A new `op` whose pattern is several literal
   fragments that must appear in order, which covers the middle
   wildcard. Every engine agrees on it, it can't backtrack badly, and
   fragments are plain text, so normalization still works. Bank
   descriptions are full of `*` and other punctuation, so the separator
   needs an escape rule, or the pattern becomes an array of strings.
2. **`op: "regex"`** limited to I-Regexp, with the exemption, cap, and
   timeout above.

Option 1 is preferred unless the need is broader than the middle
wildcard.

## Acceptance criteria

- Evidence from real exports that the literal ops fall short.
- `ledger/rules` `v: 2` in SCHEMAS.md and the decoder, which keeps
  reading `v: 1`, with the new op's grammar and test vectors.
- Matching in `src/core/rules.ts`, covered by vitest, including
  patterns that would backtrack badly, if regex is chosen.
