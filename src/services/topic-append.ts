/**
 * Appending to a topic chain with compare-and-swap (design/ACCOUNTING.md, "Concurrency").
 *
 * A post names the head it builds on as `prev_hash`, and the server rejects it if another
 * message landed first. That rejection is retried here: read the new head, rebuild the
 * message, post again. Each attempt is a new message with a new hash, so nothing may hold
 * on to a message's ID until its post succeeds.
 *
 * This module knows nothing about the SDK; `TopicBackend` is the seam, which keeps the
 * retry logic testable without a server.
 */

import { StaleHeadError } from './state-store.js';

export interface TopicBackend {
  /** The newest message hash on `topic`, or null if it is empty. */
  head(topic: string): Promise<string | null>;
  /**
   * Posts `data` to `topic` and returns the new message's hash. Throws `StaleHeadError`
   * if `prevHash` is not the head.
   */
  post(topic: string, type: string, data: Uint8Array, prevHash: string | null): Promise<string>;
}

/** A post kept losing the race for a topic's chain, and gave up. */
export class TopicConflictError extends Error {
  constructor(readonly topic: string, attempts: number) {
    super(`${topic}: another device kept posting first, still conflicting after ${attempts} attempts`);
    this.name = 'TopicConflictError';
  }
}

const MAX_ATTEMPTS = 5;

/**
 * Posts the message `build` returns to `topic`, retrying if another post lands first.
 * `build` runs once per attempt, before the head is read, so it can re-check the message
 * or rebuild it from fresh reads; it may throw to abort. Returns the new message's hash.
 */
export async function appendMessage(
  backend: TopicBackend,
  topic: string,
  type: string,
  build: () => Uint8Array | Promise<Uint8Array>,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const data = await build();
    const head = await backend.head(topic);
    try {
      return await backend.post(topic, type, data, head);
    } catch (err) {
      if (!(err instanceof StaleHeadError)) throw err;
    }
  }
  throw new TopicConflictError(topic, MAX_ATTEMPTS);
}
