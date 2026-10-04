import { describe, expect, it } from 'vitest';
import { CodecError } from './errors.js';
import { parseJson, parseJsonBytes, stringifyJson } from './json.js';

describe('parseJson', () => {
  it('parses what JSON.parse parses', () => {
    const text = '{"a":[1,-2.5e3,true,false,null,"x\\u00e9\\n\\"\\/"],"b":{}, "c" : [ ] }';
    expect(JSON.stringify(parseJson(text))).toBe(JSON.stringify(JSON.parse(text)));
  });
  it('rejects duplicate keys, including escaped spellings', () => {
    expect(() => parseJson('{"a":1,"a":2}')).toThrow(CodecError);
    expect(() => parseJson('{"a":1,"\\u0061":2}')).toThrow(CodecError);
    expect(() => parseJson('{"x":{"a":1,"a":1}}')).toThrow(CodecError);
  });
  it.each(['', '{', '{"a":1,}', '[1,]', '01', '1.', "{'a':1}", '"\t"', 'nul', '1 2', '{"a" 1}', 'NaN'])(
    'rejects %j',
    (text) => expect(() => parseJson(text)).toThrow(CodecError),
  );
  it('treats __proto__ as an ordinary key', () => {
    const v = parseJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('rejects deep nesting', () => {
    expect(() => parseJson('['.repeat(100) + ']'.repeat(100))).toThrow(CodecError);
  });
  it('rejects invalid UTF-8 and a BOM', () => {
    expect(() => parseJsonBytes(Uint8Array.of(0x22, 0xff, 0x22))).toThrow(CodecError);
    expect(() => parseJsonBytes(Uint8Array.of(0xef, 0xbb, 0xbf, 0x31))).toThrow(CodecError);
    expect(parseJsonBytes(new TextEncoder().encode('{"a":"é"}'))).toEqual({ a: 'é' });
  });
});

describe('stringifyJson', () => {
  it('writes bigints as decimal strings and drops undefined', () => {
    expect(stringifyJson({ amount: -8423n, exp: 2, x: undefined, list: [1n] })).toBe(
      '{"amount":"-8423","exp":2,"list":["1"]}',
    );
  });
});
