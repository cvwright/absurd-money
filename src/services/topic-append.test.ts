import { describe, expect, it } from 'vitest';
import { StaleHeadError } from './state-store.js';
import { appendMessage, TopicConflictError, type TopicBackend } from './topic-append.js';

/** Topic chains in memory, with a hook to land a rival post before ours. */
class FakeTopics implements TopicBackend {
  readonly chains = new Map<string, { type: string; data: string; prev: string | null }[]>();
  posts = 0;
  beforePost: (() => void) | null = null;

  async head(topic: string) {
    const chain = this.chains.get(topic) ?? [];
    return chain.length === 0 ? null : `${topic}#${chain.length - 1}`;
  }

  async post(topic: string, type: string, data: Uint8Array, prevHash: string | null) {
    this.beforePost?.();
    this.posts++;
    if (prevHash !== (await this.head(topic))) throw new StaleHeadError();
    return this.put(topic, type, new TextDecoder().decode(data));
  }

  put(topic: string, type: string, data: string): string {
    const chain = this.chains.get(topic) ?? [];
    chain.push({ type, data, prev: chain.length === 0 ? null : `${topic}#${chain.length - 1}` });
    this.chains.set(topic, chain);
    return `${topic}#${chain.length - 1}`;
  }
}

const bytes = (s: string) => () => new TextEncoder().encode(s);

describe('appendMessage', () => {
  it('posts on the current head', async () => {
    const topics = new FakeTopics();
    topics.put('journal-2026', 'ledger.entry', 'first');
    const id = await appendMessage(topics, 'journal-2026', 'ledger.entry', bytes('second'));
    expect(id).toBe('journal-2026#1');
    expect(topics.chains.get('journal-2026')![1]).toEqual({ type: 'ledger.entry', data: 'second', prev: 'journal-2026#0' });
  });

  it('retries on the new head when a rival post lands first', async () => {
    const topics = new FakeTopics();
    topics.beforePost = () => {
      topics.beforePost = null;
      topics.put('journal-2026', 'ledger.entry', 'theirs');
    };
    const id = await appendMessage(topics, 'journal-2026', 'ledger.entry', bytes('ours'));
    expect(id).toBe('journal-2026#1');
    expect(topics.chains.get('journal-2026')!.map((m) => m.data)).toEqual(['theirs', 'ours']);
    expect(topics.posts).toBe(2);
  });

  it('rebuilds the message on every attempt', async () => {
    const topics = new FakeTopics();
    topics.put('journal-2026', 'ledger.entry', 'a');
    topics.beforePost = () => {
      topics.beforePost = null;
      topics.put('journal-2026', 'ledger.entry', 'b');
      topics.put('checkpoints', 'ledger.checkpoint', 'rival');
    };
    let builds = 0;
    // Like a close, which cites another topic's head as it is when built.
    const id = await appendMessage(topics, 'checkpoints', 'ledger.checkpoint', async () => {
      builds++;
      return new TextEncoder().encode((await topics.head('journal-2026'))!);
    });
    expect(id).toBe('checkpoints#1');
    expect(builds).toBe(2);
    expect(topics.chains.get('checkpoints')!.map((m) => m.data)).toEqual(['rival', 'journal-2026#1']);
  });

  it('stops when the build throws', async () => {
    const topics = new FakeTopics();
    const build = () => {
      throw new Error('invalid');
    };
    await expect(appendMessage(topics, 'checkpoints', 'ledger.checkpoint', build)).rejects.toThrow('invalid');
    expect(topics.posts).toBe(0);
  });

  it('gives up after repeated conflicts', async () => {
    const topics = new FakeTopics();
    topics.post = async () => {
      throw new StaleHeadError();
    };
    await expect(appendMessage(topics, 'journal-2026', 'ledger.entry', bytes('x'))).rejects.toThrow(TopicConflictError);
  });

  it('does not retry other failures', async () => {
    const topics = new FakeTopics();
    let calls = 0;
    topics.post = async () => {
      calls++;
      throw new Error('offline');
    };
    await expect(appendMessage(topics, 'journal-2026', 'ledger.entry', bytes('x'))).rejects.toThrow('offline');
    expect(calls).toBe(1);
  });
});
