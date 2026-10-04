/**
 * Strict JSON at the decrypt/encrypt edge.
 *
 * SCHEMAS.md forbids duplicate keys, and `JSON.parse` silently keeps the last one, so
 * reading uses its own RFC 8259 parser that rejects them. Writing turns every `bigint`
 * into its decimal string first, so `JSON.stringify` never sees one.
 */

import { CodecError } from './errors.js';

const MAX_DEPTH = 64;
const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES: Record<string, string> = {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
};

/** Decodes UTF-8 bytes (strictly; no BOM) and parses them as strict JSON. */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CodecError('invalid UTF-8');
  }
  return parseJson(text);
}

/**
 * Parses JSON, rejecting duplicate keys. Objects come back with a null prototype, so a
 * `__proto__` key is just a key.
 */
export function parseJson(text: string): unknown {
  let i = 0;

  const fail = (what: string): never => {
    throw new CodecError(`JSON: ${what} at offset ${i}`);
  };
  const ws = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else break;
    }
  };

  const str = (): string => {
    i++; // opening quote
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail('bad \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (e !== undefined && e in ESCAPES) {
          out += ESCAPES[e];
          i += 2;
        } else {
          fail('bad escape');
        }
      } else if (c < ' ') {
        fail('control character in string');
      } else {
        out += c;
        i++;
      }
    }
  };

  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) fail('nesting too deep');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = Object.create(null);
      const seen = new Set<string>();
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected a key');
        const key = str();
        if (seen.has(key)) fail(`duplicate key "${key}"`);
        seen.add(key);
        ws();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        obj[key] = value(depth + 1);
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') {
          i++;
          return obj;
        } else fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') {
          i++;
          return arr;
        } else fail('expected "," or "]"');
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(text);
    if (!m) return fail('unexpected character');
    i += m[0].length;
    return Number(m[0]);
  };

  const result = value(0);
  ws();
  if (i !== text.length) fail('trailing characters');
  return result;
}

/** A deep copy with every `bigint` turned into its decimal string. */
export function toWire(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(toWire);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toWire(x);
    return out;
  }
  return v;
}

/** Serializes a value that may hold `bigint`s. */
export function stringifyJson(v: unknown): string {
  return JSON.stringify(toWire(v));
}
