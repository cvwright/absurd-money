// Test vectors from design/ROUNDING.md.
import { describe, expect, it } from 'vitest';
import { commodity, type Amount, type Decimal } from './amount.js';
import { allocate, applyDraw, expectedBasis, floorDiv, value, type LotState } from './rounding.js';

const USD = commodity('USD');
const d = (amount: bigint, exp: number): Decimal => ({ amount, exp });
const usd = (amount: bigint, exp: number): Amount => ({ amount, exp, cur: USD });

describe('floorDiv', () => {
  it.each([[7n, 2n, 3n], [-7n, 2n, -4n], [-6n, 2n, -3n], [0n, 5n, 0n]])('%s / %s', (a, b, q) => {
    expect(floorDiv(a, b)).toBe(q);
  });
  it('requires a positive divisor', () => expect(() => floorDiv(1n, 0n)).toThrow(RangeError));
});

describe('basis released, draw by draw', () => {
  it.each([
    [7n, 100000n, [3n, 3n, 1n], [42857n, 42857n, 14286n]],
    [3n, 100000n, [1n, 1n, 1n], [33333n, 33333n, 33334n]],
    [6n, 100n, [1n, 1n, 1n, 1n, 1n, 1n], [16n, 16n, 17n, 17n, 17n, 17n]],
    [1000n, 123457n, [333n, 333n, 334n], [41111n, 41111n, 41235n]],
    [3n, 0n, [1n, 2n], [0n, 0n]],
  ])('lot (%s, 0), cost %s', (qty, cost, draws, expected) => {
    let lot: LotState = { qty: d(qty, 0), basis: usd(cost, 2), scale: 2 };
    const released = draws.map((q) => {
      const b = expectedBasis(lot, d(q, 0));
      if (b === 'oversold') throw new Error('oversold');
      expect(b.exp).toBe(2);
      lot = applyDraw(lot, d(q, 0), b);
      return b.amount;
    });
    expect(released).toEqual(expected);
    expect(lot.qty.amount).toBe(0n);
    expect(lot.basis.amount).toBe(0n);
  });
});

describe('basis released, single cases', () => {
  it('fractional BTC', () => {
    const lot = { qty: d(15n, 1), basis: usd(9000000n, 2), scale: 2 };
    expect(expectedBasis(lot, d(25n, 2))).toEqual(usd(1500000n, 2));
  });
  it('depleting at a different exponent', () => {
    const lot = { qty: d(100n, 0), basis: usd(500000n, 2), scale: 2 };
    expect(expectedBasis(lot, d(10000n, 2))).toEqual(usd(500000n, 2));
  });
  it('oversold', () => {
    const lot = { qty: d(100n, 0), basis: usd(500000n, 2), scale: 2 };
    expect(expectedBasis(lot, d(101n, 0))).toBe('oversold');
  });
  it('after a 2:1 split', () => {
    const lot = { qty: d(14n, 0), basis: usd(100000n, 2), scale: 2 };
    expect(expectedBasis(lot, d(3n, 0))).toEqual(usd(21428n, 2));
  });
});

describe('an anomaly does not cascade', () => {
  it('advances by the posted basis', () => {
    let lot: LotState = { qty: d(3n, 0), basis: usd(1000n, 2), scale: 2 };
    expect(expectedBasis(lot, d(1n, 0))).toEqual(usd(333n, 2));
    lot = applyDraw(lot, d(1n, 0), usd(3333333n, 6));
    expect(lot.basis).toEqual(usd(6666667n, 6));

    expect(expectedBasis(lot, d(1n, 0))).toEqual(usd(333n, 2));
    lot = applyDraw(lot, d(1n, 0), usd(333n, 2));
    expect(lot.basis).toEqual(usd(3336667n, 6));

    expect(expectedBasis(lot, d(1n, 0))).toEqual(usd(3336667n, 6));
    lot = applyDraw(lot, d(1n, 0), usd(3336667n, 6));
    expect(lot.basis.amount).toBe(0n);
  });
  it('a basis in another commodity releases nothing', () => {
    const lot = { qty: d(3n, 0), basis: usd(1000n, 2), scale: 2 };
    const after = applyDraw(lot, d(1n, 0), { amount: 333n, exp: 2, cur: commodity('EUR') });
    expect(after.basis).toEqual(usd(1000n, 2));
    expect(after.qty).toEqual(d(2n, 0));
  });
});

describe('allocate', () => {
  it.each([
    [1000n, [1n, 1n, 1n], [334n, 333n, 333n]],
    [-1000n, [1n, 1n, 1n], [-334n, -333n, -333n]],
    [100n, [1n, 1n, 1n, 1n, 1n, 1n], [17n, 17n, 17n, 17n, 16n, 16n]],
    [350000n, [30n, 20n, 20n], [150000n, 100000n, 100000n]],
    [10n, [0n, 1n, 2n], [0n, 3n, 7n]],
  ])('allocate case %#', (total, weights, parts) => expect(allocate(total, weights)).toEqual(parts));
  it('throws on all-zero weights', () => expect(() => allocate(5n, [0n, 0n])).toThrow(RangeError));
});

describe('value', () => {
  it('is exact', () => {
    expect(value(d(15n, 1), usd(28734n, 2))).toEqual(usd(431010n, 3));
    expect(value(d(1n, 18), usd(350012n, 2))).toEqual(usd(350012n, 20));
  });
});
