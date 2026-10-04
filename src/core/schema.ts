/**
 * Small strict decoder combinators for the schemas in design/SCHEMAS.md. Every object
 * decoder rejects unknown fields, since a skipped field could change a message's meaning.
 */

import { decodeAmount, decodeCommodity, decodeExp, decodeInt, decodePosInt } from './amount.js';
import { CodecError } from './errors.js';

export type Decoder<T> = (v: unknown, path: string) => T;

const at = (path: string, k: string | number) =>
  typeof k === 'number' ? `${path}[${k}]` : path ? `${path}.${k}` : k;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const string: Decoder<string> = (v, path) => {
  if (typeof v !== 'string') throw new CodecError('expected a string', path);
  return v;
};

export const nonEmptyString: Decoder<string> = (v, path) => {
  if (string(v, path) === '') throw new CodecError('must not be empty', path);
  return v as string;
};

export const boolean: Decoder<boolean> = (v, path) => {
  if (typeof v !== 'boolean') throw new CodecError('expected a boolean', path);
  return v;
};

/** A JSON number that is a non-negative integer. */
export const count: Decoder<number> = (v, path) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new CodecError('expected a non-negative integer', path);
  }
  return v;
};

export function literal<T extends string | number | boolean>(x: T): Decoder<T> {
  return (v, path) => {
    if (v !== x) throw new CodecError(`expected ${JSON.stringify(x)}`, path);
    return x;
  };
}

export function oneOf<T extends string>(xs: readonly T[]): Decoder<T> {
  return (v, path) => {
    if (!xs.includes(v as T)) throw new CodecError(`expected one of ${xs.join(', ')}`, path);
    return v as T;
  };
}

/** A string matching a type guard, such as `isAccountId`. */
export function guard<T>(is: (v: unknown) => v is T, what: string): Decoder<T> {
  return (v, path) => {
    if (!is(v)) throw new CodecError(`expected ${what}`, path);
    return v;
  };
}

export function nullable<T>(d: Decoder<T>): Decoder<T | null> {
  return (v, path) => (v === null ? null : d(v, path));
}

export function arrayOf<T>(
  d: Decoder<T>,
  opts: { min?: number; uniqueBy?: (x: T) => string } = {},
): Decoder<T[]> {
  return (v, path) => {
    if (!Array.isArray(v)) throw new CodecError('expected an array', path);
    if (opts.min !== undefined && v.length < opts.min) {
      throw new CodecError(`expected at least ${opts.min} items`, path);
    }
    const out = v.map((x, i) => d(x, at(path, i)));
    if (opts.uniqueBy) {
      const seen = new Set<string>();
      out.forEach((x, i) => {
        const k = opts.uniqueBy!(x);
        if (seen.has(k)) throw new CodecError('duplicate item', at(path, i));
        seen.add(k);
      });
    }
    return out;
  };
}

/** A JSON object used as a map, with every key checked by `key`. */
export function record<K extends string, T>(
  key: (k: string) => k is K,
  d: Decoder<T>,
  opts: { min?: number } = {},
): Decoder<Record<K, T>> {
  return (v, path) => {
    if (!isPlainObject(v)) throw new CodecError('expected an object', path);
    const out = {} as Record<K, T>;
    const keys = Object.keys(v);
    if (opts.min !== undefined && keys.length < opts.min) {
      throw new CodecError(`expected at least ${opts.min} entries`, path);
    }
    for (const k of keys) {
      if (!key(k)) throw new CodecError(`bad key "${k}"`, path);
      out[k] = d(v[k], at(path, k));
    }
    return out;
  };
}

type Shape = Record<string, Decoder<unknown>>;
type Decoded<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };
type Out<R extends Shape, O extends Shape> = Decoded<R> & Partial<Decoded<O>>;

/** An object with exactly these required fields and any of these optional ones. */
export function object<R extends Shape, O extends Shape = Record<never, never>>(
  required: R,
  optional: O = {} as O,
): Decoder<Out<R, O>> {
  return (v, path) => {
    if (!isPlainObject(v)) throw new CodecError('expected an object', path);
    for (const k of Object.keys(v)) {
      if (!Object.hasOwn(required, k) && !Object.hasOwn(optional, k)) {
        throw new CodecError(`unknown field "${k}"`, path);
      }
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(required)) {
      if (!Object.hasOwn(v, k)) throw new CodecError(`missing field "${k}"`, path);
      out[k] = required[k](v[k], at(path, k));
    }
    for (const k of Object.keys(optional)) {
      if (Object.hasOwn(v, k)) out[k] = optional[k](v[k], at(path, k));
    }
    return out as Out<R, O>;
  };
}

/** Runs a decoder, then a check on its result. */
export function refine<T>(d: Decoder<T>, check: (x: T) => string | undefined): Decoder<T> {
  return (v, path) => {
    const x = d(v, path);
    const problem = check(x);
    if (problem) throw new CodecError(problem, path);
    return x;
  };
}

// Amount pieces, with the path threaded through.
export const int: Decoder<bigint> = (v, path) => decodeInt(v, path);
export const posInt: Decoder<bigint> = (v, path) => decodePosInt(v, path);
export const nonZeroInt: Decoder<bigint> = (v, path) => {
  const n = decodeInt(v, path);
  if (n === 0n) throw new CodecError('must not be zero', path);
  return n;
};
export const exp: Decoder<number> = (v, path) => decodeExp(v, path);
export const commodity = (v: unknown, path: string) => decodeCommodity(v, path);
export const amount = (v: unknown, path: string) => decodeAmount(v, path);
