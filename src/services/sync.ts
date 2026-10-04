/**
 * Keeps the projection up to date with the space: catches every topic up from its
 * watermark, then applies messages from the WebSocket stream as they arrive.
 *
 * Work on each topic runs one job at a time, in order. A live message that arrives while
 * its topic is catching up waits behind the catch-up, so catching up always comes first.
 * A live message that doesn't continue the chain (one was missed while disconnected, say)
 * makes the topic catch up instead.
 */

import type { Message } from 'reeeductio';
import { ChainBrokenError } from '@/core/chain.js';
import { segmentOf } from '@/core/ids.js';
import { FIXED_TOPICS, isProjectedTopic, type LogMessage, type Watermark } from '@/projection/projection.js';

/** The space, as the sync sees it. */
export interface SyncRemote {
  /** Every message on `topic` with a `server_timestamp` of `from` or later, in any order. */
  fetchSince(topic: string, from: number): Promise<Message[]>;
  /** The message as the log keeps it, with its payload decrypted. */
  toLog(m: Message): LogMessage;
}

/** The projection, as the sync sees it. */
export interface SyncStore {
  watermark(topic: string): Promise<Watermark | undefined>;
  append(topic: string, messages: LogMessage[]): Promise<number>;
  years(): Promise<readonly number[]>;
}

export class Sync {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly remote: SyncRemote,
    private readonly store: SyncStore,
  ) {}

  /**
   * Catches every topic up. State goes first, since it lists the journal years and holds
   * the chart every segment is folded against.
   */
  async catchUpAll(): Promise<void> {
    await this.catchUp('state');
    const years = await this.store.years();
    const topics = [...FIXED_TOPICS.filter((t) => t !== 'state'), ...years.map(segmentOf)];
    await Promise.all(topics.map((t) => this.catchUp(t)));
  }

  catchUp(topic: string): Promise<void> {
    return this.enqueue(topic, () => this.fetch(topic));
  }

  /** A message from the stream. Messages on topics the projection doesn't replay are ignored. */
  live(m: Message): Promise<void> {
    const topic = m.topic_id;
    if (!isProjectedTopic(topic)) return Promise.resolve();
    return this.enqueue(topic, async () => {
      try {
        await this.store.append(topic, [this.remote.toLog(m)]);
      } catch (err) {
        if (!(err instanceof ChainBrokenError)) throw err;
        await this.fetch(topic);
      }
    });
  }

  private async fetch(topic: string): Promise<void> {
    const mark = await this.store.watermark(topic);
    // `from` is inclusive, so this repeats the head, which the projection skips.
    const messages = await this.remote.fetchSince(topic, mark?.ts ?? 0);
    if (messages.length > 0) await this.store.append(topic, messages.map((m) => this.remote.toLog(m)));
  }

  private enqueue(topic: string, job: () => Promise<void>): Promise<void> {
    const run = (this.queues.get(topic) ?? Promise.resolve()).then(job);
    // A failed job is reported to its caller, and doesn't stop the jobs behind it.
    this.queues.set(topic, run.catch(() => undefined));
    return run;
  }
}
