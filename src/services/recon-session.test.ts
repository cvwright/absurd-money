import { describe, expect, it } from 'vitest';
import { A, msg } from '@/core/testing.js';
import { clearReconSessions, ReconSessions } from './recon-session.js';

/** Local storage in memory, which can be told to fail. */
class FakeStorage {
  readonly items = new Map<string, string>();
  failing = false;

  getItem(key: string) {
    if (this.failing) throw new Error('denied');
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (this.failing) throw new Error('quota');
    this.items.set(key, value);
  }

  removeItem(key: string) {
    if (this.failing) throw new Error('denied');
    this.items.delete(key);
  }
}

const session = { date: '2026-09-30', balance: '1,234.50', checked: [msg('a'), msg('b')] };

describe('ReconSessions', () => {
  it('keeps a session per account, and remembers the last account', () => {
    const storage = new FakeStorage();
    const s = new ReconSessions('space1', storage);
    expect(s.lastAccount()).toBeUndefined();
    s.save(A.checking, session);
    s.save(A.visa, { date: '2026-09-15', balance: '', checked: [msg('c')], supersedes: msg('r') });
    const again = new ReconSessions('space1', storage);
    expect(again.lastAccount()).toBe(A.visa);
    expect(again.get(A.checking)).toEqual(session);
    expect(again.get(A.visa)).toEqual({ date: '2026-09-15', balance: '', checked: [msg('c')], supersedes: msg('r') });
  });

  it('keeps each space apart', () => {
    const storage = new FakeStorage();
    new ReconSessions('space1', storage).save(A.checking, session);
    const other = new ReconSessions('space2', storage);
    expect(other.get(A.checking)).toBeUndefined();
    expect(other.lastAccount()).toBeUndefined();
  });

  it('drops an empty session but keeps the last account', () => {
    const storage = new FakeStorage();
    const s = new ReconSessions('space1', storage);
    s.save(A.checking, session);
    s.save(A.checking, { date: '2026-09-30', balance: ' ', checked: [] });
    expect(s.get(A.checking)).toBeUndefined();
    expect(s.lastAccount()).toBe(A.checking);
  });

  it('drops what it cannot read', () => {
    const storage = new FakeStorage();
    const s = new ReconSessions('space1', storage);
    storage.items.set('money.recon.space1', '{not json');
    expect(s.get(A.checking)).toBeUndefined();
    storage.items.set('money.recon.space1', JSON.stringify({ v: 2, account: A.checking, sessions: {} }));
    expect(s.lastAccount()).toBeUndefined();
    storage.items.set(
      'money.recon.space1',
      JSON.stringify({
        v: 1,
        account: 'nope',
        sessions: {
          [A.checking]: { date: '2026-09-30', balance: '1', checked: [msg('a'), 'junk', 7] },
          [A.visa]: { date: '2026-09-30', balance: 1, checked: [] },
          [A.groceries]: { date: '2026-09-30', balance: '', checked: [], supersedes: 'junk' },
          bogus: session,
        },
      }),
    );
    expect(s.lastAccount()).toBeUndefined();
    expect(s.get(A.checking)).toEqual({ date: '2026-09-30', balance: '1', checked: [msg('a')] });
    expect(s.get(A.visa)).toBeUndefined();
    expect(s.get(A.groceries)).toBeUndefined();
  });

  it('keeps nothing when storage fails, without throwing', () => {
    const storage = new FakeStorage();
    storage.failing = true;
    const s = new ReconSessions('space1', storage);
    expect(() => s.save(A.checking, session)).not.toThrow();
    expect(s.get(A.checking)).toBeUndefined();
    expect(s.lastAccount()).toBeUndefined();
  });
});

describe('clearReconSessions', () => {
  it("deletes the space's sessions and no other's", () => {
    const storage = new FakeStorage();
    new ReconSessions('space1', storage).save(A.checking, session);
    new ReconSessions('space2', storage).save(A.checking, session);
    clearReconSessions('space1', storage);
    expect(new ReconSessions('space1', storage).get(A.checking)).toBeUndefined();
    expect(new ReconSessions('space2', storage).get(A.checking)).toEqual(session);
  });
});
