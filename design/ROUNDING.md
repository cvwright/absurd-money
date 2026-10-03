# Rounding

This is the rounding policy: every place the app multiplies or divides an amount, and the
rule each one follows. The codec in [AMOUNTS.md](AMOUNTS.md) only adds, subtracts, and
compares, and it never rounds. This document builds on it. The reasoning for keeping
division out of the ledger is in "Numbers, currencies, and commodities" and "Basis
conservation" in [ACCOUNTING.md](ACCOUNTING.md). Issue 0003.

## Where rounding happens

The journal only adds and subtracts. Only four operations go beyond that:

| Operation | Result goes | Rounds? | Pinned? |
|---|---|---|---|
| **Basis released** by a partial lot disposal | Posted, in `LotDraw.basis` and the entry's splits | Yes, floor | **Yes.** Every client checks posted draws against it. |
| **Allocating** a total across parts (splitting a bill, proceeds per lot on Form 8949) | Posted (UI) or a report | Yes, largest remainder | No |
| **Valuation**, quantity × price | Reports and display | No. A product of two decimals is exact. | No |
| **Display** of a ratio or a long value (per-share cost, implied FX rate, wei) | The screen | At display only | No |

Only the first is pinned. The other three produce either a report, which can improve at
any time, or a value the user sees before it is posted, which becomes an ordinary fact
once it is.

### Checkpoints don't depend on rounding

The design once assumed that checkpoints needed a pinned policy, because they carry basis
figures. They don't. Every basis release is a posted fact. So a lot's remaining basis is
`cost − Σ posted basis`, and its remaining quantity is `qty − Σ posted qty`. Both are sums,
and sums are reproducible for free. Balances and envelopes are sums too, and `prices` are
copied observations. Every figure in a `v: 1` checkpoint is a sum or a copy, so two honest
clients write the same checkpoint even if they disagree about rounding.

The checkpoint's `rounding` field is still required. In `v: 1` it is always `"v1"`, and it
names this document. A later checkpoint version that adds computed figures, such as market
valuations, would name the rule it used there. A reader that meets a `rounding` value it
doesn't know treats the checkpoint as unverifiable, not as tampered.

## Basis released by a disposal

This rule is pinned for `ledger.entry` `v: 1`. A draw doesn't say which rule computed it,
so changing the rule would turn honest old draws into anomalies. A new rule would need a
new entry version, and draws in `v: 1` entries would keep this one.

### The rule

A lot's state is its remaining quantity `Q` and remaining basis `R`. When a draw takes
quantity `q`:

```
if q = Q:   basis = R                                   (depleting: take what's left)
if q < Q:   basis = floor_S(R × q / Q)                  (partial)
if q > Q:   no expected basis; the draw oversells the lot (an anomaly)
```

Then `R ← R − basis` and `Q ← Q − q`.

- **Direction: floor**, toward negative infinity. Cost is never negative in practice, so
  this is truncation, but the rule is defined for any sign. `BigInt` `/` truncates toward
  zero, so the implementation uses a real floor division.
- **Scale `S`: the exponent of the lot's `cost`**, as posted on the split that created the
  lot. Not `minor(cur)`, which is unpinned data that may change. Not the exponent of `R`,
  which can grow if an earlier draw posted a finer basis.
- **Remainder: the lot keeps it.** Each partial draw takes the floor of its proportional
  share of what *remains*, and the fraction stays in `R`. The depleting draw takes all of
  `R`. So Σ basis released equals the lot's cost exactly, by construction.
- `q`, `Q`, and `R` are compared and combined by value, after scaling to a common
  exponent. `q` is in the draw's split exponent, `Q` in the lot's (or the last
  `ledger.lotadjust`'s) exponent.

In integers: let `E = max(S, R.exp)` and `F = max(q.exp, Q.exp)`. Write `r` for `R` at
exponent `E`, and `qi`, `Qi` for `q` and `Q` at exponent `F`. Then the partial basis is the
integer `floor(r × qi / (Qi × 10^(E − S)))` at exponent `S`, in the cost's commodity.

A `ledger.lotadjust` changes `Q` to `new_qty` and leaves `R` alone, so the rule needs no
special case for stock splits. The state is just `(Q, R)`, which is exactly what a full
checkpoint's `OpenLot` carries, so a reader starting from a checkpoint can keep checking.

### Properties

- **Conservation is exact.** A lot drawn to zero has released exactly its cost.
- **Never ahead of the proportional share.** After any sequence of draws, the basis
  released is at most `cost × (quantity sold) / (original quantity)`. A partial draw never
  reports less gain than its exact share would.
- **Never far behind.** The shortfall is less than one minor unit (at scale `S`) per draw
  so far, and the depleting draw makes it exact. In practice it is a few cents over the
  life of a lot that is sold in many pieces, and it only moves gain earlier, never
  understating it.

Rounding against the *original* lot instead would leak basis on every lot that isn't sold
in one piece (see the table in ACCOUNTING.md). A cumulative rule,
`floor(cost × sold / original) − floor(cost × sold_before / original)`, trails by less
than one unit in total, but it needs the original quantity and cost. Those aren't in
`OpenLot`, and a stock split would make the original quantity fractional.

### Order of lot events

`R` and `Q` at a draw depend on which draws came before it, so every client must order a
lot's events the same way. Sort by:

1. **date**: the creating entry's `date`, the adjustment's `date`, the draw's entry `date`;
2. **kind**: creation, then `ledger.lotadjust`, then draws. This is the existing rule that
   draws dated on or after an adjustment are in post-adjustment units;
3. **chain position**: messages with the same date are in the same `journal-YYYY`
   segment, so its chain orders them;
4. within one entry, **split index**, then index in `from_lots`.

Draws in voided entries (the target of a `ledger.reversal`) are left out entirely. Lots
created by voided entries don't exist.

Date order is the economic order, which is what a tax report needs. Its cost: a
back-dated disposal, or the reversal of an earlier disposal, changes the state seen by
later-dated draws, and their posted basis may stop matching. That's correct. Their basis
was computed against a history that has since changed, and the anomaly tells the user to
repost them. A single anomaly never cascades: see the next section.

### The fold-time check

For each draw, in the order above:

- If the lot is unknown, or the draw sorts before the lot's creation, it is an anomaly
  and there is no expected basis.
- If `q > Q`, the lot is oversold. That is an anomaly, and there is no expected basis.
- If `basis.cur` isn't the cost's commodity, it is an anomaly, and the draw releases no
  basis.
- Otherwise, if `basis` doesn't equal the expected basis **by value**, it is an anomaly.
  The posted exponent doesn't matter.
- Either way, the state advances by the **posted** `basis` and `qty`, never by the
  expected one. One bad draw is flagged once, and the draws after it are checked against
  the lot as it actually stands.

As SCHEMAS.md says, these are lot anomalies. They never change the validity of the entry
or any balance. The check needs the lot's creating segment (or a full checkpoint), so a
reader holding only one year skips it for lots created in other years.

The remaining quantity and basis come out as the order-independent sums above. The order
matters only to the check.

### Writing a disposal

The client computes each draw with the same rule against its projection, in the same
order, as if the new draw sorted last on its date. It writes `basis` at exponent
`max(S, d)`, where `d` is the number of fractional digits the value needs (as in
AMOUNTS.md). A depleting draw can need more than `S` after an earlier anomaly.

The entry's basis split (e.g. `Trading:USD`) is the sum of the draws' `basis`. If that sum
is zero, the split is left out, since a split's amount can't be zero.

## Allocating a total across parts

`allocate(total, weights)` splits an `Int` at one exponent into parts proportional to
non-negative integer weights, which can't all be zero. It uses the **largest remainder
method**:

1. Work on `|total|`, then give every part the sign of `total`, so
   `allocate(−t, w) = −allocate(t, w)`.
2. With `W = Σ w`, part `i` gets `floor(|total| × w_i / W)`, with remainder
   `(|total| × w_i) mod W`.
3. The leftover units, `|total| − Σ parts`, go one each to the parts with the largest
   remainders. Equal remainders go to the lower index first.

Parts sum exactly to `total`. A part whose weight is zero gets zero. $10.00 three ways is
334 / 333 / 333, as in ACCOUNTING.md.

Uses:

- **Splitting an amount** in the entry editor: evenly (all weights 1) or by shares. The
  user sees the result before posting, so this isn't pinned.
- **Proceeds per lot** on Form 8949, for a disposal that draws from several lots: weights
  are each draw's `qty` at a common exponent. Gain per lot is then that lot's proceeds
  minus its posted `basis`. This is a report, not pinned, but it uses the same rule so that
  regenerating a report gives the same rows. Finding the total proceeds in an entry is
  0027's business.

## Valuation

`value(qty, price) = qty.amount × price.amount` at exponent `qty.exp + price.exp`, in
`price.cur`. It is exact and needs no rounding. The exponent can exceed 30, which is fine
because a valuation is never a wire `Amount`. Totals of valuations are exact too. They are
rounded only for display.

Valuations aren't posted, and `v: 1` checkpoints don't carry them. Unrealized gain is
`Σ value − remaining basis`, also exact.

## Display

Not pinned. Ratios such as per-share cost, the implied rate of a currency conversion, or
percentages are computed for display and may use floats. Long exact values are rounded by
`Intl.NumberFormat` with its default `roundingMode` (`halfExpand`). AMOUNTS.md has the rule
that a displayed value is never posted.

## TypeScript surface

For 0007 to implement in `src/core/`, alongside the codec. Names are a suggestion;
behavior is the spec above.

```ts
floorDiv(a: bigint, b: bigint): bigint          // b > 0n; rounds toward −∞

interface LotState { qty: { amount: bigint; exp: number }; basis: Amount; scale: number }
expectedBasis(lot: LotState, q: { amount: bigint; exp: number }): Amount | "oversold"
applyDraw(lot: LotState, q: { amount: bigint; exp: number }, posted: Amount): LotState

allocate(total: bigint, weights: readonly bigint[]): bigint[]
value(qty: Amount, price: Amount): { amount: bigint; exp: number; cur: Commodity }
```

## Test vectors

Amounts are written `(i, e)`, an integer `i` at exponent `e`. Costs are USD.

### `floorDiv`

| Expression | Result |
|---|---|
| `floorDiv(7n, 2n)` | `3n` |
| `floorDiv(-7n, 2n)` | `-4n` |
| `floorDiv(-6n, 2n)` | `-3n` |
| `floorDiv(0n, 5n)` | `0n` |

### Basis released, draw by draw

Each row is one lot drawn down in sequence. The last draw in each row depletes the lot.

| Lot (qty, cost) | Draws | Basis released |
|---|---|---|
| `(7, 0)`, `(100000, 2)` | 3, 3, 1 | `42857`, `42857`, `14286` |
| `(3, 0)`, `(100000, 2)` | 1, 1, 1 | `33333`, `33333`, `33334` |
| `(6, 0)`, `(100, 2)` | 1 × 6 | `16`, `16`, `17`, `17`, `17`, `17` |
| `(1000, 0)`, `(123457, 2)` | 333, 333, 334 | `41111`, `41111`, `41235` |
| `(3, 0)`, `(0, 2)` | 1, 2 | `0`, `0` |

All basis is at exponent 2.

### Basis released, single cases

| Lot state (Q, R, S) | Draw `q` | Expected basis |
|---|---|---|
| `(15, 1)` BTC, `(9000000, 2)`, 2 | `(25, 2)` | `(1500000, 2)` |
| `(100, 0)`, `(500000, 2)`, 2 | `(10000, 2)` | `(500000, 2)` (depleting) |
| `(100, 0)`, `(500000, 2)`, 2 | `(101, 0)` | oversold |
| `(14, 0)` after a 2:1 split of 7, `(100000, 2)`, 2 | `(3, 0)` | `(21428, 2)` |

### An anomaly doesn't cascade

Lot `(3, 0)`, cost `(1000, 2)`, so `S = 2`:

| Draw | Posted basis | Expected | Verdict | `R` after |
|---|---|---|---|---|
| 1 | `(3333333, 6)` | `(333, 2)` | anomaly | `(6666667, 6)` |
| 1 | `(333, 2)` | `floor(6666667 / (2 × 10^4)) = (333, 2)` | ok | `(3336667, 6)` |
| 1 | `(3336667, 6)` | `(3336667, 6)` (depleting) | ok | `0` |

### `allocate`

| Expression | Result |
|---|---|
| `allocate(1000n, [1n, 1n, 1n])` | `[334n, 333n, 333n]` |
| `allocate(-1000n, [1n, 1n, 1n])` | `[-334n, -333n, -333n]` |
| `allocate(100n, [1n, 1n, 1n, 1n, 1n, 1n])` | `[17n, 17n, 17n, 17n, 16n, 16n]` |
| `allocate(350000n, [30n, 20n, 20n])` | `[150000n, 100000n, 100000n]` |
| `allocate(10n, [0n, 1n, 2n])` | `[0n, 3n, 7n]` |
| `allocate(5n, [0n, 0n])` | throws |

### `value`

| Expression | Result |
|---|---|
| `value((15, 1) VTI, (28734, 2) USD)` | `(431010, 3)` USD, which is 431.01 |
| `value((1, 18) ETH, (350012, 2) USD)` | `(350012, 20)` USD |
