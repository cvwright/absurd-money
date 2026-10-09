import { describe, expect, it } from 'vitest';
import type { RawMessage } from '@/core/fold/segment.js';
import type { EnvelopeId, Label, Month, MsgId } from '@/core/ids.js';
import type { BudgetDoc } from '@/core/messages.js';
import { budgetDoc, E, msg } from '@/core/testing.js';
import { materializeSchedule, type BudgetTopic } from './materialize.js';
import { StaleHeadError } from './state-store.js';
import { TopicConflictError } from './topic-append.js';

const idem = (env: EnvelopeId, month: Month) => `${env === E.groceries ? 'g' : 'd'}-${month}`.padEnd(20, '0') as Label;
const through = '2026-10' as Month;

const doc: BudgetDoc = {
  ...budgetDoc,
  envelopes: {
    ...budgetDoc.envelopes,
    [E.groceries]: { ...budgetDoc.envelopes[E.groceries], schedule: [{ from: '2026-08' as Month, amount: 60000n, exp: 2 }] },
  },
};

/** The `budget` chain in memory, with a hook to land a rival post before ours. */
class FakeBudget implements BudgetTopic {
  readonly chain: RawMessage[] = [];
  reads = 0;
  beforePost: (() => void) | null = null;

  async read() {
    this.reads++;
    return [...this.chain];
  }

  async post(data: Uint8Array, prevHash: string | null) {
    this.beforePost?.();
    if (prevHash !== (this.chain.at(-1)?.id ?? null)) throw new StaleHeadError();
    return this.put(JSON.parse(new TextDecoder().decode(data)));
  }

  put(data: unknown, type = 'ledger.allocation'): MsgId {
    const id = msg(`m${this.chain.length}`);
    this.chain.push({ id, type, data });
    return id;
  }

  months(): string[] {
    return this.chain.map((m) => (m.data as { date: string }).date.slice(0, 7));
  }
}

const wire = (month: string) => ({
  v: 1, date: `${month}-01`, envelope: E.groceries, amount: '60000', exp: 2, cur: 'USD', idem: idem(E.groceries, month as Month),
});

describe('materializeSchedule', () => {
  it('posts each missing month once, oldest first, and nothing on a second run', async () => {
    const topic = new FakeBudget();
    expect(await materializeSchedule(topic, doc, through, idem)).toBe(3);
    expect(topic.months()).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(topic.chain[0].data).toEqual(wire('2026-08'));
    expect(await materializeSchedule(topic, doc, through, idem)).toBe(0);
    expect(topic.chain).toHaveLength(3);
  });

  it('skips months another device posted, and re-reads when it posts mid-run', async () => {
    const topic = new FakeBudget();
    topic.put(wire('2026-08'));
    let posts = 0;
    topic.beforePost = () => {
      if (++posts === 2) topic.put(wire('2026-10'));
    };
    expect(await materializeSchedule(topic, doc, through, idem)).toBe(1);
    expect(topic.months()).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(topic.reads).toBe(2);
  });

  it('gives up if it keeps losing the race', async () => {
    const topic = new FakeBudget();
    topic.beforePost = () => void topic.put({ v: 1 }, 'ledger.reallocation');
    await expect(materializeSchedule(topic, doc, through, idem)).rejects.toBeInstanceOf(TopicConflictError);
  });

  it('posts nothing past a message it cannot read', async () => {
    const topic = new FakeBudget();
    topic.put({ v: 2 });
    await expect(materializeSchedule(topic, doc, through, idem)).rejects.toThrow(/Update the app/);
    expect(topic.chain).toHaveLength(1);
  });
});
