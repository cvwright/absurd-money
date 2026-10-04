/**
 * One tab at a time. The projection's storage (`opfs-sahpool`) holds its files
 * exclusively, so a second tab can't open the database. Instead it waits for a Web Lock
 * and takes over when the tab holding it closes. Sending a second tab's queries to the
 * first is a later improvement; see issues/0012-projection.md.
 *
 * The worker holds the lock, not the page, so the lock is released exactly when the
 * worker, and with it the storage's file handles, goes away.
 */

export const PROJECTION_LOCK = 'absurd-money-projection';

/**
 * Takes the exclusive lock `name`, waiting as long as it takes. If another holder has it,
 * calls `onWaiting` once before waiting. Resolves to a function that releases it.
 */
export async function holdLock(locks: LockManager, name: string, onWaiting: () => void): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const acquire = (options: LockOptions) =>
    new Promise<boolean>((granted, failed) => {
      locks
        .request(name, options, (lock) => {
          granted(lock !== null);
          return lock === null ? undefined : held;
        })
        .catch(failed);
    });

  if (!(await acquire({ mode: 'exclusive', ifAvailable: true }))) {
    onWaiting();
    await acquire({ mode: 'exclusive' });
  }
  return release;
}
