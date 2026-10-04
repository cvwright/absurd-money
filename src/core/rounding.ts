/**
 * Every place the app multiplies or divides an amount. Spec and test vectors:
 * design/ROUNDING.md (0003). Only the basis released by a partial disposal is pinned.
 */

import { cmpDecimal, pow10, type Amount, type Decimal } from './amount.js';

/** Integer division rounding toward negative infinity. `b` must be positive. */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('floorDiv: divisor must be positive');
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/**
 * A lot's remaining quantity and basis. `scale` is the exponent of the lot's `cost` as
 * posted on the split that created it, which is the scale partial draws are floored at.
 */
export interface LotState {
  readonly qty: Decimal;
  readonly basis: Amount;
  readonly scale: number;
}

/** The basis a draw of `q` must release, by the pinned rule, or `"oversold"`. */
export function expectedBasis(lot: LotState, q: Decimal): Amount | 'oversold' {
  const c = cmpDecimal(q, lot.qty);
  if (c > 0) return 'oversold';
  if (c === 0) return lot.basis;

  const S = lot.scale;
  const R = lot.basis;
  const E = Math.max(S, R.exp);
  const F = Math.max(q.exp, lot.qty.exp);
  const r = R.amount * pow10(E - R.exp);
  const qi = q.amount * pow10(F - q.exp);
  const Qi = lot.qty.amount * pow10(F - lot.qty.exp);
  return { amount: floorDiv(r * qi, Qi * pow10(E - S)), exp: S, cur: R.cur };
}

/**
 * Advances a lot by a draw, using the **posted** basis, never the expected one, so one bad
 * draw is flagged once. A basis in another commodity releases nothing.
 */
export function applyDraw(lot: LotState, q: Decimal, posted: Amount): LotState {
  return {
    qty: subDecimal(lot.qty, q),
    basis: posted.cur === lot.basis.cur ? { ...subDecimal(lot.basis, posted), cur: lot.basis.cur } : lot.basis,
    scale: lot.scale,
  };
}

function subDecimal(a: Decimal, b: Decimal): Decimal {
  const exp = Math.max(a.exp, b.exp);
  return { amount: a.amount * pow10(exp - a.exp) - b.amount * pow10(exp - b.exp), exp };
}

/**
 * Splits `total` into parts proportional to non-negative `weights` by the largest
 * remainder method. Parts sum exactly to `total`; ties go to the lower index.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  let W = 0n;
  for (const w of weights) {
    if (w < 0n) throw new RangeError('allocate: weights must be non-negative');
    W += w;
  }
  if (W === 0n) throw new RangeError('allocate: weights must not all be zero');

  const abs = total < 0n ? -total : total;
  const parts = weights.map((w) => (abs * w) / W);
  const rems = weights.map((w) => (abs * w) % W);
  let leftover = abs - parts.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((_, i) => i)
    .sort((i, j) => (rems[i] > rems[j] ? -1 : rems[i] < rems[j] ? 1 : i - j));
  for (const i of order) {
    if (leftover === 0n) break;
    parts[i] += 1n;
    leftover -= 1n;
  }
  return total < 0n ? parts.map((p) => -p) : parts;
}

/**
 * Quantity × price, exact. The exponent may exceed 30, which is fine: a valuation is
 * never posted, so it is never encoded as a wire amount.
 */
export function value(qty: Decimal, price: Amount): Amount {
  return { amount: qty.amount * price.amount, exp: qty.exp + price.exp, cur: price.cur };
}
