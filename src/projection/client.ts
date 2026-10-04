/**
 * The page's handle on the projection worker. Every call is async; the worker runs them
 * one at a time, in the order they were made.
 *
 * Fires `change` (a `CustomEvent<{ topic }>`) whenever an append changes the projection,
 * so views can query again.
 */

import { ChainBrokenError } from '@/core/chain.js';
import type { FromWorker, Method, ProjectionApi, ToWorker } from './protocol.js';

export type ChangeEvent = CustomEvent<{ topic: string }>;

export class ProjectionClient extends EventTarget {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(private readonly worker: Worker) {
    super();
  }

  /**
   * Opens the projection of `spaceId`. If another tab has it open, calls `onWaiting` and
   * resolves only once that tab closes.
   */
  static open(spaceId: string, onWaiting: () => void): Promise<ProjectionClient> {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'projection' });
    const client = new ProjectionClient(worker);
    return new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        switch (m.kind) {
          case 'waiting':
            onWaiting();
            return;
          case 'ready':
            worker.onmessage = (e: MessageEvent<FromWorker>) => client.receive(e.data);
            worker.onerror = () => client.close();
            resolve(client);
            return;
          case 'failed':
            worker.terminate();
            reject(new Error(`could not open the local database: ${m.error}`));
            return;
        }
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(new Error(`the projection worker failed: ${e.message}`));
      };
      // Space IDs are base64url, so safe as a file name.
      client.send({ kind: 'open', file: `/${spaceId}.sqlite3` });
    });
  }

  call<M extends Method>(method: M, ...args: Parameters<ProjectionApi[M]>): Promise<ReturnType<ProjectionApi[M]>> {
    return this.request((id) => ({ kind: 'call', id, method, args })) as Promise<ReturnType<ProjectionApi[M]>>;
  }

  /** Deletes the database from this device and shuts the worker down. */
  async wipe(): Promise<void> {
    await this.request((id) => ({ kind: 'wipe', id }));
    this.close();
  }

  close(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('the projection was closed'));
    this.pending.clear();
  }

  private request(msg: (id: number) => ToWorker): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(msg(id));
    });
  }

  private send(m: ToWorker): void {
    this.worker.postMessage(m);
  }

  private receive(m: FromWorker): void {
    switch (m.kind) {
      case 'result':
      case 'error': {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.kind === 'result') p?.resolve(m.value);
        else p?.reject(m.name === 'ChainBrokenError' ? new ChainBrokenError(m.message) : Object.assign(new Error(m.message), { name: m.name }));
        return;
      }
      case 'changed':
        this.dispatchEvent(new CustomEvent('change', { detail: { topic: m.topic } }));
        return;
    }
  }
}
