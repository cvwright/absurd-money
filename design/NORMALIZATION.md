# Normalization

This is the `import/v1` normalization: how a CSV row's description is turned into the
exact string hashed into its derived import ID, and how that whole input string is
assembled. Why derived labels need a pinned normalization is in "Opaque identifiers" in
[ACCOUNTING.md](ACCOUNTING.md). The idempotency scheme that uses it, including the
occurrence counter and the pending-row problem, is issue
[0023](../issues/0023-import-idempotency.md). Issue 0004.

**All of this is pinned under `import/v1`.** A derived label only recognizes a row again if
every client builds the same bytes for it. Changing any step mints new labels for rows
already imported, so the next import of an overlapping statement would post them again.
A change needs a new namespace, `import/v2`.

Payees don't depend on any of this. They have random IDs, and import rules map merchant
strings to them (see "Derive or randomize?" in ACCOUNTING.md).

## The goal is narrow

The only job is that the **same bank** exporting the **same row** twice gives the same
string. It is not to recognize that two differently spelled merchant strings are the same
merchant. That is fuzzy, it keeps improving, and it lives in editable rules.

So normalization is minimal, because over-normalizing is the worse failure:

- Within one file, two distinct rows that normalize to the same string stay apart. They
  get different occurrence counts (`#0`, `#1`).
- Across files, they don't. If a row in one export normalizes to the same string as a
  different row in a later export (same account, date, and amount), the later row is
  taken as already imported and **silently dropped**.
- Under-normalizing only fails the other way: a re-exported row isn't recognized, so it
  shows up again in review, where the user sees it and dismisses it.

Each step below removes a difference that a re-export can plausibly introduce (an export
format change, a different Unicode form, a change of case or padding) and nothing more.

## `normalizeDescription`

The input is the description cell as a string, after the file is decoded and the CSV is
parsed (0020). The steps, in order:

1. **Well-formed.** Replace each lone UTF-16 surrogate with U+FFFD
   (`String.prototype.toWellFormed`). Text decoded from bytes never has one. This step
   only makes the function total, and it matches what UTF-8 encoding does anyway.
2. **NFKC.** Unicode Normalization Form KC (`s.normalize("NFKC")`).
3. **Lowercase.** `String.prototype.toLowerCase()`: Unicode default lowercase mapping,
   with the unconditional mappings from SpecialCasing and the `Final_Sigma` rule, and
   **no locale**. This is not full case folding. See "Case" below.
4. **Whitespace.** Replace every run of one or more of the code points below with one
   U+0020, then remove a leading and a trailing U+0020.

The whitespace set is exactly the 25 code points with the Unicode `White_Space`
property:

```
U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A,
U+2028, U+2029, U+202F, U+205F, U+3000
```

Nothing else is changed. In particular:

- **Punctuation, symbols, and digits stay.** `SQ *`, `#123`, `AT&T`, and store numbers
  like `0412` are often what tells two rows apart.
- **Control and format characters stay**, other than the whitespace above. That includes
  U+200B ZERO WIDTH SPACE, U+00AD SOFT HYPHEN, U+200D ZERO WIDTH JOINER, and U+FEFF. A
  byte-order mark at the start of the file is the decoder's business, and `TextDecoder`
  removes it by default.
- **Accents stay.** NFKC composes `e` + U+0301 into `é`. It does not remove the accent.

### Reference implementation

```ts
const WS = new RegExp(
  "[\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]+",
  "g",
);

function normalizeDescription(s: string): string {
  return s.toWellFormed().normalize("NFKC").toLowerCase()
    .replace(WS, " ").replace(/^ | $/g, "");
}
```

The regex is built from a string because a literal U+2028 inside a regex literal is a line
terminator, which is a syntax error. Don't write `\s` or `trim()`. JavaScript's `\s` also
matches U+FEFF and has changed between Unicode versions (U+180E left it in Unicode 6.3).
Python's `str.strip()` and `str.split()` also treat U+001C–U+001F as whitespace. The
explicit list is the spec.

### Case

Step 3 had two candidates, and they differ:

| | `toLowerCase()` (chosen) | Full case folding (`CaseFolding.txt`, C + F) |
|---|---|---|
| `STRASSE`, `Straße` | `strasse`, `straße` (differ) | `strasse`, `strasse` (equal) |
| `ΟΔΟΣ` | `οδος` (final sigma) | `οδοσ` |
| Availability | Native in JavaScript, Python (`str.lower()`), ICU, and Swift | Not in JavaScript. A table would have to ship in the core, pinned to a Unicode version. |

The differences are all cases where the spelling changes, not just the case. `ß` against
`SS` is a different spelling of the word, and a bank re-exporting the same row doesn't
change it. Full folding would only help match *different* exports of the same merchant,
which is the rules' job. Native lowercase needs no table to ship and keep in sync, and
every platform a future client is likely to use has it.

`toLowerCase` ignores the locale, so Turkish `İ` (U+0130) becomes `i` + U+0307 COMBINING
DOT ABOVE everywhere, never a Turkish dotted `i`. That is deliberate. `toLocaleLowerCase`
must never be used.

### Idempotence

`normalizeDescription(normalizeDescription(s)) === normalizeDescription(s)` for every
string. Lowercasing can in principle produce text that is no longer NFKC, so this was
checked rather than assumed: it holds for every Unicode scalar value on its own, and for
3 million random strings of 2–5 characters drawn from every character that NFKC or
lowercase changes, every lowercase letter, and every combining mark. (Node 25.4,
Unicode 17.0.)

So a value that is already normalized can be normalized again safely. Import rule
patterns are stored normalized (`ledger/rules` in [SCHEMAS.md](SCHEMAS.md)), and a client
may normalize them again on read.

### Unicode versions

NFKC and lowercase come from the engine's Unicode data, which varies by browser and
runtime version. Unicode's [stability policies](https://www.unicode.org/policies/stability_policy.html)
fix the decomposition of a character once it is encoded and keep case pairs fixed once
formed. So two engines can only disagree on characters encoded in a Unicode version one
of them doesn't have.

Measured: Node 25.4 (Unicode 17.0) and Python 3.14 (Unicode 16.0) give byte-identical
output for all 1,112,064 Unicode scalar values except 29. All 29 were encoded in
Unicode 17.0 (new Latin letters at U+A7CE–U+A7F1 and the Beria Erfe script at U+16EA0).
They agree on every test vector below.

The remaining risk is accepted. It needs a description containing a newly encoded
character with a case mapping or compatibility decomposition, imported once on an older
engine and again on a newer one. The failure is the safe one: the row shows up again in
review instead of being merged with something else.

## The `import/v1` label input

`label("import/v1", s)` takes `s` as UTF-8 with no further processing. `label` itself
does no normalization (see "Derivation" in ACCOUNTING.md). Normalization is applied here,
to the description only. Account IDs, `fitid`s, and dates are case-sensitive or already
canonical, and folding them would merge distinct values.

There are two schemes. An account's profile uses one or the other, never both (0023).

**Row scheme**, for a CSV with no `fitid` column:

```
{account}|{date}|{amount}|{description}|#{n}
```

| Field | Value |
|---|---|
| `account` | The `AccountId` the file is imported into, as is. |
| `date` | The row's date as a `Date` (`YYYY-MM-DD`), after the profile's date format is applied. |
| `amount` | The [canonical decimal form](AMOUNTS.md#canonical-decimal-form) of the signed amount as posted to the account. |
| `description` | `normalizeDescription` of the description cell. |
| `n` | The 0-based count of earlier rows in the same file with the same date, amount (by value), and normalized description (0023). Decimal, with no leading zeros. |

**`fitid` scheme**, for OFX, or a CSV whose profile has a `fitid` column:

```
{account}|fitid|{fitid}
```

`fitid` is the cell after step 1 (well-formed) and the trimming half of step 4: leading
and trailing whitespace from the set above is removed. Nothing else changes, not even
case. An institution's transaction ID is an opaque token, and `ab12` and `AB12` may be
different transactions. A `fitid` that is empty after trimming is 0023's business, as
blank amount cells are 0020's.

No escaping is needed. The description is the only field that can contain `|`, and it is
the only free-text field in its scheme, so the string splits uniquely: three fields from
the left and one from the right. The two schemes can't collide either, since the second
field is either the literal `fitid` or a `Date`.

Because `n` counts **normalized** descriptions, `BLUE BOTTLE` and `Blue  Bottle` on the
same date with the same amount are `#0` and `#1` in one file. They are the same string
for every purpose here.

## TypeScript surface

For 0007 to implement in `src/core/`. Names are a suggestion; behavior is the spec above.

```ts
normalizeDescription(s: string): string
normalizeFitid(s: string): string                 // well-formed + trim only

importInputRow(row: {
  account: AccountId; date: string; amount: { amount: bigint; exp: number };
  description: string;                            // the raw cell; normalized inside
  n: number;
}): string
importInputFitid(account: AccountId, fitid: string): string   // fitid raw; normalized inside
```

`importInputRow` normalizes the description itself, so a caller that already normalized
it (to compute `n`) gets the same result, by idempotence.

## Test vectors

Implementations must pass every vector, comparing the UTF-8 bytes. Inputs are written as
JavaScript string literals. The UTF-8 is given wherever the output is not ASCII, since
`é` and `e` + U+0301 look the same.

### `normalizeDescription`

| Input | Output | UTF-8 of output |
|---|---|---|
| `"BLUE BOTTLE"` | `blue bottle` | |
| `"  SQ *BLUE   BOTTLE 0412  "` | `sq *blue bottle 0412` | |
| `"Blue\tBottle\r\nCoffee"` | `blue bottle coffee` | |
| `"BLUE BOTTLE COFFEE　SF"` | `blue bottle coffee sf` | |
| `"BLUE\u0085BOTTLE COFFEE"` | `blue bottle coffee` | |
| `"ＡＭＡＺＯＮ．ＣＯＭ"` (full-width `ＡＭＡＺＯＮ．ＣＯＭ`) | `amazon.com` | |
| `"Oﬃce Depot"` (`ﬃ` ligature) | `office depot` | |
| `"Café Rouge"` | `café rouge` | `63 61 66 c3 a9 20 72 6f 75 67 65` |
| `"Café Rouge"` | `café rouge` | `63 61 66 c3 a9 20 72 6f 75 67 65` |
| `"STRASSE"` | `strasse` | |
| `"Straße"` | `straße` | `73 74 72 61 c3 9f 65` |
| `"ΟΔΟΣ 5"` (`ΟΔΟΣ 5`) | `οδος 5` | `ce bf ce b4 ce bf cf 82 20 35` |
| `"İSTANBUL"` | `i̇stanbul` | `69 cc 87 73 74 61 6e 62 75 6c` |
| `"K-MART"` (KELVIN SIGN) | `k-mart` | |
| `"Unit Ⅷ ① ½ m²"` (`Ⅷ ① ½ m²`) | `unit viii 1 1⁄2 m2` | `75 6e 69 74 20 76 69 69 69 20 31 20 31 e2 81 84 32 20 6d 32` |
| `"AT&T  *Bill-Pay #123"` | `at&t *bill-pay #123` | |
| `"PAYPAL *J.DOE"` | `paypal *j.doe` | |
| `""` | (empty) | |
| `" \t "` | (empty) | |
| `"BLUE​BOTTLE"` | `blue`U+200B`bottle` | `62 6c 75 65 e2 80 8b 62 6f 74 74 6c 65` |
| `"﻿BLUE"` | U+FEFF`blue` | `ef bb bf 62 6c 75 65` |
| `"\uD800X"` (lone surrogate) | U+FFFD`x` | `ef bf bd 78` |

### Label input

Account `acct_7bQ2xV9mKd4TnR1sYgLp`, date `2026-09-14`. An amount written `(i, e)` is
integer `i` at exponent `e`.

| Inputs | Label input |
|---|---|
| `(-500, 2)`, `"BLUE BOTTLE"`, n 0 | `acct_7bQ2xV9mKd4TnR1sYgLp\|2026-09-14\|-5\|blue bottle\|#0` |
| `(-5000, 3)`, `"Blue  Bottle "`, n 1 | `acct_7bQ2xV9mKd4TnR1sYgLp\|2026-09-14\|-5\|blue bottle\|#1` |
| `(1234, 2)`, `"REFUND \| ACME"`, n 0 | `acct_7bQ2xV9mKd4TnR1sYgLp\|2026-09-14\|12.34\|refund \| acme\|#0` |
| `(-5, 2)`, `""`, n 12 | `acct_7bQ2xV9mKd4TnR1sYgLp\|2026-09-14\|-0.05\|\|#12` |
| fitid `" 20260914-ABc01 "` | `acct_7bQ2xV9mKd4TnR1sYgLp\|fitid\|20260914-ABc01` |
| fitid `" X​"` | `acct_7bQ2xV9mKd4TnR1sYgLp\|fitid\|X`U+200B |

The `\|` are table escapes; each is a single `|` (U+007C). The labels these inputs hash to
are in the test vectors in [LABELS.md](LABELS.md) (0005).
