import { describe, expect, it } from 'vitest';
import { holdLock } from './tab-lock.js';

// Node implements the Web Locks API, so this runs against the real thing.
const locks = navigator.locks;

describe('holdLock', () => {
  it('lets a second tab wait, then take over when the first closes', async () => {
    const name = `test-${Math.random()}`;
    let firstWaited = false;
    const releaseFirst = await holdLock(locks, name, () => (firstWaited = true));
    expect(firstWaited).toBe(false);

    let secondWaited = false;
    let secondHolds = false;
    const second = holdLock(locks, name, () => (secondWaited = true)).then((release) => {
      secondHolds = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondWaited).toBe(true);
    expect(secondHolds).toBe(false);

    releaseFirst();
    const releaseSecond = await second;
    expect(secondHolds).toBe(true);
    expect((await locks.query()).held?.filter((l) => l.name === name)).toHaveLength(1);
    releaseSecond();
  });
});
