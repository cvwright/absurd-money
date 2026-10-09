/**
 * Against a real reeeductio server: `npm run test:e2e`, with the local server on
 * localhost:8000 or at `E2E_SERVER_URL`. Each test makes a fresh space.
 */

import { describe, expect, it } from 'vitest';
import { generateCredentials, unlockWithPassword } from './credentials.js';
import { LedgerSpace } from './ledger-space.js';

const SERVER: string = import.meta.env.E2E_SERVER_URL ?? 'http://localhost:8000';
const PASSWORD = 'correct horse battery';

// The services bind fetch to `window`.
(globalThis as { window?: unknown }).window ??= globalThis;

/** `setPassword`, retried once: a server clock ahead of ours makes the SDK's second State write 409 (0052). */
async function setPassword(ledger: LedgerSpace, password: string) {
  try {
    await ledger.setPassword(password);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    await ledger.setPassword(password);
  }
}

describe('the owner password', () => {
  it('is seen by hasPassword, from a new session with the same keys too', async () => {
    const creds = await generateCredentials(SERVER);
    const ledger = new LedgerSpace(creds);
    expect(await ledger.hasPassword()).toBe(false);

    await setPassword(ledger, PASSWORD);
    expect(await ledger.hasPassword()).toBe(true);
    // As after connecting with the recovery key.
    expect(await new LedgerSpace(creds).hasPassword()).toBe(true);

    const unlocked = await unlockWithPassword(creds.spaceId, SERVER, PASSWORD);
    expect(unlocked.symmetricRoot).toEqual(creds.symmetricRoot);
  });

  it('cannot be replaced yet (0051)', async () => {
    const ledger = new LedgerSpace(await generateCredentials(SERVER));
    await setPassword(ledger, PASSWORD);
    await expect(ledger.setPassword('a different password')).rejects.toThrow();
  });
});
