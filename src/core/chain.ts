/**
 * Putting a topic's messages in chain order. The server returns messages by timestamp,
 * but the folds need chain order, and the `prev_hash` links are what the server's
 * compare-and-swap made linear.
 */

/** A topic's messages don't form one unbroken chain from its first message. */
export class ChainBrokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainBrokenError';
  }
}

export interface Link {
  readonly hash: string;
  /** The previous message's hash, or null for a topic's first message. */
  readonly prev: string | null;
}

/**
 * `messages` from the first to the head. Throws `ChainBrokenError` unless they are the
 * whole chain: one first message, no forks, no gaps, and no repeats.
 */
export function chainOrder<T>(messages: readonly T[], link: (m: T) => Link): T[] {
  if (messages.length === 0) return [];
  let first: T | undefined;
  const next = new Map<string, T>();
  const hashes = new Set<string>();
  for (const m of messages) {
    const { hash, prev } = link(m);
    if (hashes.has(hash)) throw new ChainBrokenError(`${hash} appears twice`);
    hashes.add(hash);
    if (prev === null) {
      if (first !== undefined) throw new ChainBrokenError('two messages start the chain');
      first = m;
    } else {
      if (next.has(prev)) throw new ChainBrokenError(`the chain forks after ${prev}`);
      next.set(prev, m);
    }
  }
  if (first === undefined) throw new ChainBrokenError('no message starts the chain');

  const out: T[] = [];
  for (let m: T | undefined = first; m !== undefined; m = next.get(link(m).hash)) out.push(m);
  if (out.length !== messages.length) {
    throw new ChainBrokenError(`only ${out.length} of ${messages.length} messages link to the first`);
  }
  return out;
}
