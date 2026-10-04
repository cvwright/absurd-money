import init from '@sqlite.org/sqlite-wasm';
import type { Message } from 'reeeductio';
import { beforeAll, describe, expect, it } from 'vitest';
import { commodity } from '@/core/amount.js';
import { balanceOf } from '@/core/fold/ledger.js';
import { stringifyJson } from '@/core/json.js';
import { encodeState } from '@/core/messages.js';
import { A, accountsDoc, entry, msg, usd } from '@/core/testing.js';
import { Projection } from '@/projection/projection.js';
import { Sync, type SyncRemote, type SyncStore } from './sync.js';

const USD = commodity('USD');

let sqlite: Awaited<ReturnType<typeof init>>;
beforeAll(async () => {
  sqlite = await init();
});

/** A space's topics, with payloads in the clear. */
class FakeServer implements SyncRemote {
  readonly topics = new Map<string, Message[]>();
  readonly fetches: { topic: string; from: number }[] = [];
  /** When set, fetches wait for it, to hold a catch-up open. */
  gate: Promise<void> | undefined;
  private ts = 1000;

  post(topic: string, name: string, type: string, data: unknown): Message {
    const list = this.topics.get(topic) ?? [];
    this.topics.set(topic, list);
    const m: Message = {
      message_hash: msg(name),
      topic_id: topic,
      type,
      prev_hash: list.at(-1)?.message_hash ?? null,
      data: stringifyJson(data),
      sender: 'U-test',
      signature: '',
      server_timestamp: this.ts++,
    };
    list.push(m);
    return m;
  }

  async fetchSince(topic: string, from: number): Promise<Message[]> {
    this.fetches.push({ topic, from });
    await this.gate;
    return (this.topics.get(topic) ?? []).filter((m) => m.server_timestamp >= from).reverse();
  }

  toLog(m: Message) {
    return { hash: m.message_hash, prev: m.prev_hash, type: m.type, sender: m.sender, ts: m.server_timestamp, body: m.data };
  }
}

function storeOf(p: Projection): SyncStore {
  return {
    watermark: async (t) => p.watermark(t),
    append: async (t, ms) => p.append(t, ms),
    years: async () => p.years(),
  };
}

function setup() {
  const server = new FakeServer();
  server.post('state', 's1', 'ledger/accounts', JSON.parse(encodeState('ledger/accounts', accountsDoc)));
  server.post('state', 's2', 'ledger/journal', { v: 1, rev: 1, years: [2026] });
  const projection = Projection.open(new sqlite.oo1.DB(':memory:'));
  return { server, projection, sync: new Sync(server, storeOf(projection)) };
}

const pay = (cents: number) => entry('2026-03-01', [usd(A.checking, cents), usd(A.salary, -cents)]);
const checking = (p: Projection) => balanceOf(p.balances(), A.checking, USD).amount;

describe('Sync', () => {
  it('catches up every listed topic, then only what is new', async () => {
    const { server, projection, sync } = setup();
    server.post('journal-2026', 'a', 'ledger.entry', pay(100));
    server.post('journal-2026', 'b', 'ledger.entry', pay(200));
    await sync.catchUpAll();
    expect(checking(projection)).toBe(300n);
    expect(server.fetches.map((f) => f.topic).sort()).toEqual(
      ['budget', 'checkpoints', 'journal-2026', 'recon', 'state'],
    );

    // Reopening starts from the watermarks, not from the beginning.
    const c = server.post('journal-2026', 'c', 'ledger.entry', pay(400));
    server.fetches.length = 0;
    await new Sync(server, storeOf(projection)).catchUpAll();
    expect(checking(projection)).toBe(700n);
    expect(server.fetches.find((f) => f.topic === 'journal-2026')?.from).toBe(c.server_timestamp - 1);
  });

  it('applies a live message that continues the chain without fetching', async () => {
    const { server, projection, sync } = setup();
    await sync.catchUpAll();
    server.fetches.length = 0;
    await sync.live(server.post('journal-2026', 'a', 'ledger.entry', pay(100)));
    expect(checking(projection)).toBe(100n);
    expect(server.fetches).toEqual([]);
    // Topics the projection doesn't replay are ignored.
    await sync.live(server.post('chat', 'x', 'note', {}));
    expect(server.fetches).toEqual([]);
  });

  it('catches up when a live message leaves a gap', async () => {
    const { server, projection, sync } = setup();
    await sync.catchUpAll();
    server.post('journal-2026', 'a', 'ledger.entry', pay(100)); // missed while offline
    await sync.live(server.post('journal-2026', 'b', 'ledger.entry', pay(200)));
    expect(checking(projection)).toBe(300n);
  });

  it('applies live messages only after the catch-up in progress', async () => {
    const { server, projection, sync } = setup();
    server.post('journal-2026', 'a', 'ledger.entry', pay(100));
    let open!: () => void;
    server.gate = new Promise((r) => (open = r));
    const catchingUp = sync.catchUpAll();
    await Promise.resolve();
    const b = server.post('journal-2026', 'b', 'ledger.entry', pay(200));
    const live = sync.live(b);
    open();
    await Promise.all([catchingUp, live]);
    expect(checking(projection)).toBe(300n);
    expect(projection.watermark('journal-2026')).toMatchObject({ head: b.message_hash, count: 2 });
  });
});
