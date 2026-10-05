# Amounts

This is the amount codec: how amounts are represented, compared, added,
parsed from text, and written back out. The wire grammar itself (`Int`,
`PosInt`, `Exp`, `Commodity`) is pinned in
[SCHEMAS.md](SCHEMAS.md#primitive-types). The reasons for integers and
strings are in "Numbers, currencies, and commodities" in
[ACCOUNTING.md](ACCOUNTING.md). Issue 0002.

Some of this is permanent and some is not:

| Part | Pinned? | Why |
|---|---|---|
| Wire form, value equality, arithmetic | **Yes** | Every client must fold the same messages to the same balances. |
| Canonical decimal form | **Yes** | It is hashed into `import/v1` labels (0023). Changing it mints new labels for old rows. |
| Exponent a writer chooses | No | Equality is by value, so any valid exponent folds the same. |
| Parsing text, display | No | Client behavior. It can improve without changing anything posted. |
| Projection encoding | No | The projection is a disposable cache. |

The codec does **no rounding**. Every operation here is exact or fails.
Multiplication, division, and rounding are in [ROUNDING.md](ROUNDING.md)
(0003).

## Representation

| Where | Form |
|---|---|
| Wire | `{"amount": "-8423", "exp": 2, "cur": "USD"}`. `amount` is a JSON string matching `Int`, `exp` a JSON number, `cur` a `Commodity`. |
| Memory | `{amount: -8423n, exp: 2, cur: "USD"}`. Same field names, `amount` is a `bigint`. |
| SQLite | `amount TEXT` (the wire string), `exp INTEGER`, `cur TEXT`. See "Projection". |

The value is `amount × 10^-exp` units of `cur`. `-8423, 2, USD` is
−84.23 dollars.

## Value, not spelling

**Amounts are compared by value, never by representation.**
`{"amount": "8400", "exp": 2}` and `{"amount": "84", "exp": 0}` are the
same amount. Every rule in SCHEMAS.md that says "equals", "matches", "is
zero", or "sums to zero" means value equality:

- a split's amount must not be zero (`"0"` at any exponent is zero);
- splits sum to zero per commodity;
- `from_lots` quantities sum to the split's quantity drawn;
- a `ledger.lotadjust` `old_qty` matches the lot's remaining quantity;
- a recomputed checkpoint balance matches the posted one;
- an import row matches an unconfirmed split "with the same amount".

So two honest clients can write different exponents for the same fact
and still agree on every verdict. A checkpoint can't be flagged as
dishonest because one client wrote a balance as `"100"`, exp 0, and
another wrote it as `"10000"`, exp 2.

Amounts in different commodities are never equal and never comparable.
Comparing or adding them is a programming error, and the codec throws.

## Decoding and encoding

Decoding happens right after `JSON.parse` and after decryption, in one
place. It is strict, because SCHEMAS.md says a malformed message is
invalid, not repaired.

- `amount` must be a JSON **string** matching `^-?(0|[1-9][0-9]*)$`. A
  JSON number, `"-0"`, `"+1"`, `"01"`, `"1.0"`, `"1e3"`, surrounding
  whitespace, and non-ASCII digits are all invalid. The string goes
  straight to `BigInt()`. It is never passed through `Number`.
- `PosInt` additionally excludes `"0"`.
- `exp` must be a JSON number for which `Number.isInteger` is true, from
  0 to 30. `JSON.parse` turns `2.0` and `2e0` into `2`, so a JavaScript
  reader can't tell them apart and accepts them. Writers always emit
  `2`.
- `cur` must match `^[A-Z0-9][A-Z0-9._-]{0,15}$`.

There is **no bound on the number of digits** in `amount`. The 100 KB
message limit already bounds it, `BigInt` parses even absurd lengths
quickly, and a bound would also have to hold for checkpoint balances,
which are sums and can outgrow any bound their inputs meet.

Encoding is `amount.toString()` for the integer and the exponent as a
JSON number. Since `bigint` has no negative zero, the output is always
canonical. The app never calls `JSON.stringify` on an object that holds
a `bigint`. The codec turns amounts into strings first.

## Arithmetic

| Operation | Result |
|---|---|
| `neg(a)` | `{-a.amount, a.exp, a.cur}` |
| `add(a, b)`, `sub(a, b)` | Same `cur` required. Both are scaled up to `max(a.exp, b.exp)` and the integers are added. The result keeps that exponent. |
| `cmp(a, b)`, `eq(a, b)` | Same `cur` required for `cmp`. Scale to the larger exponent and compare the integers. `eq` across commodities is `false`. |
| `isZero(a)` | `a.amount === 0n` |
| `sumByCommodity(list)` | A map from `cur` to the sum. An empty commodity is absent, not zero. |
| `sumsToZero(splits)` | `true` if and only if every commodity in `sumByCommodity` is zero. |
| `rescale(a, exp)` | Exact only. Scaling up multiplies by `10^(exp - a.exp)`. Scaling down succeeds only if the integer is divisible by `10^(a.exp - exp)`, and throws otherwise. `exp` must be from 0 to 30. |

Results of `add` and `sub` are never rescaled down to strip trailing
zeros. The exponent only ever grows, and it is capped at 30 because no
input exceeds 30.

There is no `mul` or `div` here. The basis released by a partial
disposal, and splitting a total into parts, need a rounding rule. A
price times a quantity is exact but isn't an `Amount`. All three are in
[ROUNDING.md](ROUNDING.md) (0003).

## Choosing an exponent when writing

Since equality is by value, this is a client convention, not a rule:

- The writer uses `max(minor(cur), d)`, where `d` is the number of
  fractional digits the value needs once trailing zeros are dropped. $5
  is `"500"`, exp 2. $0.125 is `"125"`, exp 3. 1.5 shares of VTI is
  `"15"`, exp 1.
- `minor(cur)` is the ISO 4217 minor unit for currency codes (USD 2, JPY
  0, KWD 3) and 0 for anything else. The table ships as data in the
  core. It only sets defaults and display, never validity, so updating
  it is always safe.
- A reversal copies its target's exponents, and an edit never touches
  amounts. That keeps a reversal visibly the inverse of its target.
- An import uses the profile's `exp` (see "Parsing text").

## Parsing text

User input and CSV cells are parsed by one function,
`parseDecimal(text, options)`. This is client behavior and not pinned:
import labels hash the canonical decimal form of the **value**, not the
cell text, so a better parser that reads the same value mints the same
label.

**Parsing never rounds.** It is exact or it fails.

Options:

- `decimal`: `"."` or `","`. The user's locale in the UI. The profile's
  `decimal` for CSV (default `"."`).
- One of two scale modes:
  - **Fixed** (`exp: n`), for CSV. The result has exponent `n`. Missing
    digits are zeros. Extra fractional digits must be zeros (`"5.000"`
    at exp 2 is fine), and any non-zero extra digit is an error, never a
    rounding.
  - **Grow** (`minExp: n`), for the UI. The result has exponent
    `max(n, d)` as in "Choosing an exponent".

Grammar, applied in order:

1. Trim Unicode whitespace, including U+00A0 and U+202F.
2. **Sign.** At most one marker: a leading `-`, `+`, or `−` (U+2212); a
   trailing `-`; or parentheses around everything else. Two markers
   (`--5`, `(-5)`) are an error.
3. **Currency symbol.** At most one character of Unicode category `Sc`
   (`$`, `€`, `£`, `¥`…), immediately before or after the number, inside
   or outside the sign, optionally separated by whitespace. `-$5`,
   `$-5`, `($5.00)`, and `5,00 €` are fine. Letters, including ISO codes
   like `USD`, are an error.
4. **Digits** are ASCII `0`–`9` only.
5. **Grouping.** The grouping separators are the other one of `.` and
   `,`, plus `'`, U+0020, U+00A0, and U+202F. One value uses at most one
   kind. Groups appear only in the integer part. The first group has 1–3
   digits, the last has exactly 3, and the ones between have 2 or 3,
   which allows Indian grouping (`1,23,456`). This rejects `1,5` when
   `decimal` is `.` instead of reading it as 15, a silent tenfold error.
6. **Fraction.** The decimal separator, if present, is followed by at
   least one digit. The integer part may be empty (`.5`). At least one
   digit appears overall.
7. Exponent notation (`1e3`), empty input, and anything left over are
   errors.
8. `-0.00` parses to zero. The output never carries a sign on zero,
   since `bigint` can't.

Blank cells are the caller's business. Combining separate debit and
credit columns, and the profile's `negate`, are 0020's business.

## Canonical decimal form

`canonical(a)` is the shortest exact decimal spelling of a value,
independent of its exponent:

- an optional `-`, then the integer part with no leading zeros (`0` if
  empty);
- then, only if the fraction is non-zero, `.` and the fractional digits
  with trailing zeros removed;
- no grouping, no `+`, no exponent, no currency. Zero is `0`, never
  `-0`.

`-500`, exp 2 is `-5`. `-510`, exp 2 is `-5.1`. `5`, exp 2 is `0.05`.

This is the `{amount}` in the derived import ID (0023):
`label("import/v1", "{account}|{date}|{amount}|…")`. The amount is the
signed amount **as it will be posted to the account**, after the
profile's `negate` or debit/credit combination. Because the form ignores
the exponent, changing a profile's `exp` from 2 to 3 doesn't mint new
labels for rows already imported. The form is pinned under `import/v1`,
and changing it would need `import/v2`.

The edit form of an amount in the UI starts from `canonical(a)`, never
from the displayed string, which may be rounded or grouped.

## Display

Not pinned. Format from the decimal string, never from a `Number`.
`Intl.NumberFormat` formats a decimal string exactly in current browsers
(ECMA-402 NumberFormat v3), with `minimumFractionDigits: minor(cur)` and
`maximumFractionDigits` at least the value's exponent. Display may
round, for example a wei balance shown to 6 places. Floats are fine for
charts and percentages. A displayed value is never posted.

## Projection

Not pinned, since the projection is rebuilt from the log (0012). The
default:

- `amount TEXT` holding the wire `Int` string, `exp INTEGER`,
  `cur TEXT`. Never an `INTEGER` amount, because wei overflows 64 bits
  at about 9.2 ETH.
- Optionally `approx REAL`, for `ORDER BY` and range filters in SQL. It
  is display data: nothing read from it is summed into a balance,
  compared for equality, or posted.
- Balances and sums run in TypeScript with `bigint`.

## TypeScript surface

For 0007 to implement in `src/core/`. Names are a suggestion; behavior
is the spec above.

```ts
type Commodity = string & { readonly __brand: "Commodity" };
interface Amount { readonly amount: bigint; readonly exp: number; readonly cur: Commodity }
interface WireAmount { amount: string; exp: number; cur: string }

decodeInt(s: unknown): bigint            // throws CodecError
decodePosInt(s: unknown): bigint
decodeExp(n: unknown): number
decodeAmount(w: unknown): Amount
encodeAmount(a: Amount): WireAmount

neg, add, sub, cmp, eq, isZero, rescale
sumByCommodity(xs: Iterable<Amount>): Map<Commodity, Amount>
sumsToZero(xs: Iterable<Amount>): boolean

parseDecimal(text: string, opts: { decimal: "." | "," } & ({ exp: number } | { minExp: number })):
  { amount: bigint; exp: number }        // throws ParseError
canonical(a: { amount: bigint; exp: number }): string
minor(cur: Commodity): number
```

## Test vectors

Implementations must pass every vector. An amount written `(i, e)` is
integer `i` at exponent `e`.

### Decoding `Int`

| Input (JSON) | Result |
|---|---|
| `"0"`, `"8423"`, `"-8423"` | `0n`, `8423n`, `-8423n` |
| `"1000000000000000000000000000000"` | `10n ** 30n` |
| `"-0"`, `"+1"`, `"01"`, `"1.0"`, `"1e3"`, `" 1"`, `""`, `"١٢"` | invalid |
| `8423` (number), `null` | invalid |

`decodePosInt`: `"1"` is valid, and `"0"` and `"-1"` are invalid.

### Decoding `Exp`

| Input | Result |
|---|---|
| `0`, `2`, `30` | valid |
| `-1`, `31`, `2.5`, `"2"`, `null` | invalid |

### Equality and arithmetic (all USD unless shown)

| Expression | Result |
|---|---|
| `eq((8400, 2), (84, 0))` | `true` |
| `eq((0, 0), (0, 18))` | `true` |
| `eq((84, 0, USD), (84, 0, CAD))` | `false` |
| `cmp((84, 0, USD), (84, 0, CAD))` | throws |
| `cmp((1, 3), (1, 2))` | `-1` |
| `add((1, 2), (1, 3))` | `(11, 3)` |
| `add((-1000, 2), (10, 0))` | `(0, 2)` |
| `sumsToZero([(-8423, 2), (6112, 2), (2311, 2)])` | `true` |
| `sumsToZero([(-1000, 2, USD), (1000, 2, USD), (920, 2, EUR), (-920, 2, EUR)])` | `true` |
| `sumsToZero([(-1000, 2, USD), (1000, 2, EUR)])` | `false` |
| `sumsToZero([(-500, 2), (5, 0)])` | `true` |
| `rescale((84, 0), 2)` | `(8400, 2)` |
| `rescale((8400, 2), 0)` | `(84, 0)` |
| `rescale((8423, 2), 0)` | throws (inexact) |
| `rescale((5, 1), 31)` | throws (range) |

### Canonical decimal form

| Amount | `canonical` |
|---|---|
| `(-500, 2)` | `-5` |
| `(-510, 2)` | `-5.1` |
| `(5, 2)` | `0.05` |
| `(0, 2)`, `(0, 0)` | `0` |
| `(1000, 3)` | `1` |
| `(123456, 0)` | `123456` |
| `(-1, 18)` | `-0.000000000000000001` |
| `(120034, 4)` | `12.0034` |

### Parsing, fixed mode, `decimal: "."`, `exp: 2`

| Text | Result |
|---|---|
| `-5.00`, `−5.00`, `5.00-`, `(5.00)` | `-500` |
| `5`, `+5.00`, ` 5.00 `, `5.000` | `500` |
| `.5` | `50` |
| `$1,234.56`, `1'234.56`, `1 234.56` | `123456` |
| `-$1,234.56`, `$-1,234.56`, `($1,234.56)` | `-123456` |
| `1,23,456.00` | `12345600` |
| `-0.00` | `0` |
| `5.005`, `1.234` | error (excess precision) |
| `1,23`, `1,234,56`, `1,,234`, `,123` | error (grouping) |
| `1e3`, `--5`, `(-5)`, `5 USD`, `5.`, `.`, `` | error |

`5.` fails rule 6, since a separator must be followed by a digit.

### Parsing, fixed mode, `decimal: ","`, `exp: 2`

| Text | Result |
|---|---|
| `1.234,56`, `1 234,56` (U+00A0), `1 234,56` (U+202F) | `123456` |
| `5,5 €` | `550` |
| `1.234` | `123400` |
| `1,234` | error (excess precision) |

### Parsing, grow mode, `decimal: "."`

| Text | `minExp` | Result |
|---|---|---|
| `0.125` | 2 | `(125, 3)` |
| `5.10`, `5.1000` | 2 | `(510, 2)` |
| `1.5` | 0 | `(15, 1)` |
| `10`, `10.0` | 0 | `(10, 0)` |
| `0.000000000000000001` | 0 | `(1, 18)` |
| `0.0000000000000000000000000000001` | 0 | error (exponent above 30) |
