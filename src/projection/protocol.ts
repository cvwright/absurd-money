/**
 * Messages between the page and the projection worker. Values cross by structured clone,
 * which carries `bigint` and `Map`, so amounts and balances arrive exact.
 */

import type { Projection } from './projection.js';

/** The projection methods the page may call. */
export const METHODS = [
  'watermarks', 'watermark', 'append', 'doc', 'years', 'balances', 'register', 'reversalTarget', 'editTarget',
  'segmentOpen', 'closes', 'entriesAfter', 'openings',
  'allocated', 'anomalies', 'halts',
] as const satisfies readonly (keyof Projection)[];

export type Method = (typeof METHODS)[number];
export type ProjectionApi = Pick<Projection, Method>;

export type ToWorker =
  /** Opens the database file, waiting for any other tab to close it first. */
  | { readonly kind: 'open'; readonly file: string }
  | { readonly kind: 'call'; readonly id: number; readonly method: Method; readonly args: unknown[] }
  /** Closes and deletes the database, then releases the lock. */
  | { readonly kind: 'wipe'; readonly id: number };

export type FromWorker =
  /** Another tab has the database open. This one opens it when that one closes. */
  | { readonly kind: 'waiting' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'result'; readonly id: number; readonly value: unknown }
  | { readonly kind: 'error'; readonly id: number; readonly name: string; readonly message: string }
  /** An append changed the projection. */
  | { readonly kind: 'changed'; readonly topic: string };
