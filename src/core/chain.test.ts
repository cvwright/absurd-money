import { describe, expect, it } from 'vitest';
import { chainOrder, ChainBrokenError, type Link } from './chain.js';

const id = (l: Link) => l;
const a: Link = { hash: 'a', prev: null };
const b: Link = { hash: 'b', prev: 'a' };
const c: Link = { hash: 'c', prev: 'b' };

describe('chainOrder', () => {
  it('orders by links, not input order', () => {
    expect(chainOrder([c, a, b], id)).toEqual([a, b, c]);
    expect(chainOrder([], id)).toEqual([]);
  });

  it('rejects anything but one whole chain', () => {
    const broken = [
      [b, c], // no first message
      [a, c], // gap
      [a, b, { hash: 'b2', prev: 'a' }], // fork
      [a, { hash: 'z', prev: null }], // two firsts
      [a, b, b], // repeat
      [a, b, { hash: 'x', prev: 'y' }, { hash: 'y', prev: 'x' }], // detached cycle
    ];
    for (const msgs of broken) expect(() => chainOrder(msgs, id)).toThrow(ChainBrokenError);
  });

  it('continues from a known head', () => {
    expect(chainOrder([c, b], id, 'a')).toEqual([b, c]);
    expect(() => chainOrder([a, b], id, 'a')).toThrow(ChainBrokenError); // a doesn't follow a
    expect(() => chainOrder([c], id, 'a')).toThrow(ChainBrokenError); // gap
  });
});
