/**
 * The projection worker. SQLite runs here, never on the UI thread, in the `opfs-sahpool`
 * VFS: it needs no cross-origin isolation headers, but holds its files exclusively, so the
 * worker takes the tab lock first (tab-lock.ts).
 */

import init, { type Database, type SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import { Projection } from './projection.js';
import { METHODS, type FromWorker, type ToWorker } from './protocol.js';
import { holdLock, PROJECTION_LOCK } from './tab-lock.js';

const post = (m: FromWorker) => self.postMessage(m);

let pool: SAHPoolUtil | undefined;
let db: Database | undefined;
let projection: Projection | undefined;
let file = '';
let release: (() => void) | undefined;

async function open(name: string): Promise<void> {
  file = name;
  release = await holdLock(navigator.locks, PROJECTION_LOCK, () => post({ kind: 'waiting' }));
  const sqlite3 = await init();
  pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'absurd-money' });
  db = new pool.OpfsSAHPoolDb(file);
  projection = Projection.open(db);
}

function wipe(): void {
  db?.close();
  pool?.unlink(file);
  db = projection = undefined;
  release?.();
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.kind) {
    case 'open':
      try {
        await open(m.file);
        post({ kind: 'ready' });
      } catch (err) {
        post({ kind: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
      return;
    case 'call':
      try {
        if (!projection) throw new Error('the projection is not open');
        if (!METHODS.includes(m.method)) throw new Error(`no method ${m.method}`);
        const fn = projection[m.method] as (...args: unknown[]) => unknown;
        const value = fn.apply(projection, m.args);
        post({ kind: 'result', id: m.id, value });
        if (m.method === 'append' && (value as number) > 0) post({ kind: 'changed', topic: m.args[0] as string });
      } catch (err) {
        const { name, message } = err instanceof Error ? err : new Error(String(err));
        post({ kind: 'error', id: m.id, name, message });
      }
      return;
    case 'wipe':
      wipe();
      post({ kind: 'result', id: m.id, value: undefined });
      return;
  }
};
