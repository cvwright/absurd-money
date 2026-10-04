import { describe, expect, it } from 'vitest';
import { EMPTY_CHART } from '@/core/chart.js';
import { CodecError } from '@/core/errors.js';
import type { AccountId, IsoDate } from '@/core/ids.js';
import { UnknownVersionError, type Account, type AccountsDoc } from '@/core/messages.js';
import { A, accountsDoc } from '@/core/testing.js';
import { ACCOUNTS } from './ledger-space.js';
import {
  InvalidDocError,
  loadDoc,
  StaleHeadError,
  StateConflictError,
  updateDoc,
  type StateBackend,
} from './state-store.js';

/** One state chain in memory, with a hook to land a rival write before ours. */
class FakeState implements StateBackend {
  readonly docs = new Map<string, Uint8Array>();
  chain: string[] = [];
  writes = 0;
  beforeWrite: (() => void) | null = null;

  async head() {
    return this.chain.at(-1) ?? null;
  }

  async read(path: string) {
    return this.docs.get(path) ?? null;
  }

  async write(path: string, data: Uint8Array, prevHash: string | null) {
    this.beforeWrite?.();
    if (prevHash !== (this.chain.at(-1) ?? null)) throw new StaleHeadError();
    this.put(path, data);
    this.writes++;
  }

  put(path: string, data: Uint8Array | string) {
    this.docs.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data);
    this.chain.push(`M${this.chain.length}`);
  }
}

const checking: Account = { name: 'Checking', type: 'asset', cur: 'USD' as Account['cur'], parent: null };
const id = A.checking as AccountId;
const add = (doc: AccountsDoc): AccountsDoc => ({ ...doc, accounts: { ...doc.accounts, [id]: checking } });
const rename = (name: string) => (doc: AccountsDoc): AccountsDoc => ({
  ...doc,
  accounts: { ...doc.accounts, [id]: { ...doc.accounts[id], name } },
});

describe('loadDoc', () => {
  it('returns the empty document when nothing was written', async () => {
    expect(await loadDoc(new FakeState(), ACCOUNTS)).toBe(EMPTY_CHART);
  });

  it('decodes what is there', async () => {
    const state = new FakeState();
    state.put('ledger/accounts', JSON.stringify(accountsDoc));
    expect(await loadDoc(state, ACCOUNTS)).toEqual(accountsDoc);
  });

  it('refuses a deleted document instead of starting over', async () => {
    const state = new FakeState();
    state.put('ledger/accounts', new Uint8Array());
    await expect(loadDoc(state, ACCOUNTS)).rejects.toThrow(CodecError);
  });

  it('stops on a newer version', async () => {
    const state = new FakeState();
    state.put('ledger/accounts', '{"v":2,"rev":1,"accounts":{}}');
    await expect(loadDoc(state, ACCOUNTS)).rejects.toThrow(UnknownVersionError);
  });
});

describe('updateDoc', () => {
  it('writes the first revision as rev 1', async () => {
    const state = new FakeState();
    const doc = await updateDoc(state, ACCOUNTS, add);
    expect(doc.rev).toBe(1);
    expect(await loadDoc(state, ACCOUNTS)).toEqual(doc);
  });

  it('sets rev itself, whatever the edit returns', async () => {
    const state = new FakeState();
    await updateDoc(state, ACCOUNTS, add);
    const doc = await updateDoc(state, ACCOUNTS, (d) => ({ ...rename('Main')(d), rev: 99 }));
    expect(doc.rev).toBe(2);
    expect(doc.accounts[id].name).toBe('Main');
  });

  it('rejects a chart that breaks the post-time rules, and writes nothing', async () => {
    const state = new FakeState();
    await updateDoc(state, ACCOUNTS, add);
    const retype = (d: AccountsDoc): AccountsDoc => ({
      ...d,
      accounts: { ...d.accounts, [id]: { ...d.accounts[id], type: 'liability' } },
    });
    await expect(updateDoc(state, ACCOUNTS, retype)).rejects.toThrow(InvalidDocError);
    await expect(updateDoc(state, ACCOUNTS, (d) => ({ ...d, accounts: {} }))).rejects.toThrow(
      /never removed/,
    );
    expect(state.writes).toBe(1);
  });

  it('re-applies the edit to the winner of a race', async () => {
    const state = new FakeState();
    await updateDoc(state, ACCOUNTS, add);
    // Another device renames the account between our head read and our post.
    state.beforeWrite = () => {
      state.beforeWrite = null;
      state.put(
        'ledger/accounts',
        JSON.stringify({ v: 1, rev: 2, accounts: { [id]: { ...checking, name: 'Theirs' } } }),
      );
    };
    const seen: string[] = [];
    const doc = await updateDoc(state, ACCOUNTS, (d) => {
      seen.push(d.accounts[id].name);
      return { ...d, accounts: { ...d.accounts, [id]: { ...d.accounts[id], closed_at: '2026-10-03' as IsoDate } } };
    });
    expect(seen).toEqual(['Checking', 'Theirs']);
    expect(doc.rev).toBe(3);
    expect(doc.accounts[id].name).toBe('Theirs');
  });

  it('conflicts on a write to any State path, not just its own', async () => {
    const state = new FakeState();
    state.beforeWrite = () => {
      state.beforeWrite = null;
      state.put('ledger/payees', '{}');
    };
    const doc = await updateDoc(state, ACCOUNTS, add);
    expect(doc.rev).toBe(1);
    expect(state.chain).toHaveLength(2);
  });

  it('gives up after repeated conflicts', async () => {
    const state = new FakeState();
    state.write = async () => {
      throw new StaleHeadError();
    };
    await expect(updateDoc(state, ACCOUNTS, add)).rejects.toThrow(StateConflictError);
  });

  it('does not retry other failures', async () => {
    const state = new FakeState();
    let calls = 0;
    state.write = async () => {
      calls++;
      throw new Error('offline');
    };
    await expect(updateDoc(state, ACCOUNTS, add)).rejects.toThrow('offline');
    expect(calls).toBe(1);
  });
});
