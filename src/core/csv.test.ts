// Test vectors from "CSV grammar" in design/NORMALIZATION.md.
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.js';
import { ParseError } from './errors.js';

describe('parseCsv', () => {
  it.each([
    ['a,b,c', [['a', 'b', 'c']]],
    ['"a ""q"" b",c', [['a "q" b', 'c']]],
    ['"x,y",z', [['x,y', 'z']]],
    ['"line1\r\nline2",z', [['line1\r\nline2', 'z']]],
    ['5" PIZZA,1', [['5" PIZZA', '1']]],
    ['"abc"def,1', [['"abc"def', '1']]],
    ['a, "b" ,c', [['a', ' "b" ', 'c']]],
    ['"",x', [['', 'x']]],
    [',,', [['', '', '']]],
    ['  a  ,b', [['  a  ', 'b']]],
    ['﻿a,b', [['﻿a', 'b']]],
    ['#x,y', [['#x', 'y']]],
    ['a,b,c\nd', [['a', 'b', 'c'], ['d']]],
    ['a,b\r\nc,d\re,f\ng,h', [['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']]],
    ['a,b\n\n\nc,d\n', [['a', 'b'], ['c', 'd']]],
    ['a\n   \nb', [['a'], ['   '], ['b']]],
  ])('%j', (text, records) => {
    expect(parseCsv(text, ',').map((r) => r.cells)).toEqual(records);
  });

  it('uses the given delimiter', () => {
    expect(parseCsv('a\t"b\tc"\td', '\t')[0].cells).toEqual(['a', 'b\tc', 'd']);
    expect(parseCsv('a;"b;c";d', ';')[0].cells).toEqual(['a', 'b;c', 'd']);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a,"b\nc,d', ',')).toThrow(ParseError);
  });

  it('reports the line each record starts on', () => {
    const text = 'a,b\n\n\nc,"1\r\n2\r3"\ne,f';
    expect(parseCsv(text, ',').map((r) => r.line)).toEqual([1, 4, 7]);
  });
});
