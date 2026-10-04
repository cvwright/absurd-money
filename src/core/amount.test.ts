// Test vectors from design/AMOUNTS.md.
import { describe, expect, it } from 'vitest';
import {
  add, canonical, cmp, commodity, decodeAmount, decodeExp, decodeInt, decodePosInt, encodeAmount,
  eq, minor, parseDecimal, rescale, sumByCommodity, sumsToZero, writerExp, type Amount,
} from './amount.js';
import { CodecError, ParseError } from './errors.js';

const USD = commodity('USD');
const CAD = commodity('CAD');
const EUR = commodity('EUR');
const a = (amount: bigint, exp: number, cur = USD): Amount => ({ amount, exp, cur });

describe('decodeInt', () => {
  it.each([['0', 0n], ['8423', 8423n], ['-8423', -8423n], ['1000000000000000000000000000000', 10n ** 30n]])(
    '%s',
    (s, n) => expect(decodeInt(s)).toBe(n),
  );
  it.each(['-0', '+1', '01', '1.0', '1e3', ' 1', '', '١٢', 8423, null])('rejects %j', (s) => {
    expect(() => decodeInt(s)).toThrow(CodecError);
  });
  it('decodePosInt', () => {
    expect(decodePosInt('1')).toBe(1n);
    expect(() => decodePosInt('0')).toThrow(CodecError);
    expect(() => decodePosInt('-1')).toThrow(CodecError);
  });
});

describe('decodeExp', () => {
  it.each([0, 2, 30])('accepts %j', (n) => expect(decodeExp(n)).toBe(n));
  it.each([-1, 31, 2.5, '2', null])('rejects %j', (n) => expect(() => decodeExp(n)).toThrow(CodecError));
});

describe('decodeAmount', () => {
  it('round-trips', () => {
    const w = { amount: '-8423', exp: 2, cur: 'USD' };
    expect(encodeAmount(decodeAmount(w))).toEqual(w);
  });
  it('rejects unknown fields and bad commodities', () => {
    expect(() => decodeAmount({ amount: '1', exp: 0, cur: 'USD', x: 1 })).toThrow(CodecError);
    expect(() => decodeAmount({ amount: '1', exp: 0, cur: 'usd' })).toThrow(CodecError);
    expect(() => decodeAmount({ amount: '1', exp: 0 })).toThrow(CodecError);
  });
});

describe('equality and arithmetic', () => {
  it('compares by value', () => {
    expect(eq(a(8400n, 2), a(84n, 0))).toBe(true);
    expect(eq(a(0n, 0), a(0n, 18))).toBe(true);
    expect(eq(a(84n, 0, USD), a(84n, 0, CAD))).toBe(false);
    expect(() => cmp(a(84n, 0, USD), a(84n, 0, CAD))).toThrow();
    expect(cmp(a(1n, 3), a(1n, 2))).toBe(-1);
  });
  it('adds at the larger exponent', () => {
    expect(add(a(1n, 2), a(1n, 3))).toEqual(a(11n, 3));
    expect(add(a(-1000n, 2), a(10n, 0))).toEqual(a(0n, 2));
  });
  it('sumsToZero per commodity', () => {
    expect(sumsToZero([a(-8423n, 2), a(6112n, 2), a(2311n, 2)])).toBe(true);
    expect(sumsToZero([a(-1000n, 2), a(1000n, 2), a(920n, 2, EUR), a(-920n, 2, EUR)])).toBe(true);
    expect(sumsToZero([a(-1000n, 2), a(1000n, 2, EUR)])).toBe(false);
    expect(sumsToZero([a(-500n, 2), a(5n, 0)])).toBe(true);
  });
  it('sumByCommodity leaves absent commodities out', () => {
    const m = sumByCommodity([a(1n, 0), a(2n, 1, EUR)]);
    expect([...m.keys()]).toEqual([USD, EUR]);
    expect(m.get(CAD)).toBeUndefined();
  });
  it('rescales exactly or throws', () => {
    expect(rescale(a(84n, 0), 2)).toEqual(a(8400n, 2));
    expect(rescale(a(8400n, 2), 0)).toEqual(a(84n, 0));
    expect(() => rescale(a(8423n, 2), 0)).toThrow(RangeError);
    expect(() => rescale(a(5n, 1), 31)).toThrow(RangeError);
  });
  it('writerExp uses max(minor, digits needed)', () => {
    expect(writerExp({ amount: 5n, exp: 0 }, 2)).toEqual({ amount: 500n, exp: 2 });
    expect(writerExp({ amount: 1250n, exp: 4 }, 2)).toEqual({ amount: 125n, exp: 3 });
  });
});

describe('canonical', () => {
  it.each([
    [-500n, 2, '-5'], [-510n, 2, '-5.1'], [5n, 2, '0.05'], [0n, 2, '0'], [0n, 0, '0'],
    [1000n, 3, '1'], [123456n, 0, '123456'], [-1n, 18, '-0.000000000000000001'], [120034n, 4, '12.0034'],
  ] as const)('(%s, %s) is %s', (amount, exp, s) => expect(canonical({ amount, exp })).toBe(s));
});

describe('parseDecimal', () => {
  const dot2 = { decimal: '.', exp: 2 } as const;
  const comma2 = { decimal: ',', exp: 2 } as const;
  const ok = (text: string, opts: Parameters<typeof parseDecimal>[1], amount: bigint, exp = 2) =>
    expect(parseDecimal(text, opts)).toEqual({ amount, exp });

  it.each(['-5.00', '\u22125.00', '5.00-', '(5.00)'])('fixed "." %s is -500', (t) => ok(t, dot2, -500n));
  it.each(['5', '+5.00', ' 5.00 ', '5.000'])('fixed "." %s is 500', (t) => ok(t, dot2, 500n));
  it('fixed "." .5', () => ok('.5', dot2, 50n));
  it.each(['$1,234.56', "1'234.56", '1 234.56'])('fixed "." %s', (t) => ok(t, dot2, 123456n));
  it.each(['-$1,234.56', '$-1,234.56', '($1,234.56)'])('fixed "." %s', (t) => ok(t, dot2, -123456n));
  it('Indian grouping', () => ok('1,23,456.00', dot2, 12345600n));
  it('negative zero is zero', () => ok('-0.00', dot2, 0n));
  it.each(['5.005', '1.234', '1,23', '1,234,56', '1,,234', ',123', '1e3', '--5', '(-5)', '5 USD', '5.', '.', ''])(
    'fixed "." rejects %j',
    (t) => expect(() => parseDecimal(t, dot2)).toThrow(ParseError),
  );

  it.each(['1.234,56', '1\u00A0234,56', '1\u202F234,56'])('fixed "," %j', (t) => ok(t, comma2, 123456n));
  it('fixed "," with a trailing symbol', () => ok('5,5 €', comma2, 550n));
  it('fixed "," grouping', () => ok('1.234', comma2, 123400n));
  it('fixed "," excess precision', () => expect(() => parseDecimal('1,234', comma2)).toThrow(ParseError));

  it.each([
    ['0.125', 2, 125n, 3], ['5.10', 2, 510n, 2], ['5.1000', 2, 510n, 2], ['1.5', 0, 15n, 1],
    ['10', 0, 10n, 0], ['10.0', 0, 10n, 0], ['0.000000000000000001', 0, 1n, 18],
  ] as const)('grow %s minExp %s', (t, minExp, amount, exp) => ok(t, { decimal: '.', minExp }, amount, exp));
  it('grow rejects exponents above 30', () => {
    expect(() => parseDecimal('0.0000000000000000000000000000001', { decimal: '.', minExp: 0 })).toThrow(ParseError);
  });
});

describe('minor', () => {
  it('knows ISO minor units and defaults to 0', () => {
    expect(minor(USD)).toBe(2);
    expect(minor(commodity('JPY'))).toBe(0);
    expect(minor(commodity('KWD'))).toBe(3);
    expect(minor(commodity('VTI'))).toBe(0);
  });
});
