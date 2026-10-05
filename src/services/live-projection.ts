/**
 * The projection kept live: the worker-backed database (projection/client.ts), caught up
 * from the server and then fed from the WebSocket stream (sync.ts, stream.ts).
 *
 * Fires `status` (a `CustomEvent<SyncStatus>`) as the sync state changes. Views listen
 * for `change` on `projection` to query again.
 */

import { ProjectionClient } from '@/projection/client.js';
import type { LedgerSpace } from './ledger-space.js';
import { SpaceStream } from './stream.js';
import { Sync } from './sync.js';

export type SyncStatus =
  | { readonly kind: 'syncing' }
  | { readonly kind: 'live' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'failed'; readonly error: string };

export type StatusEvent = CustomEvent<SyncStatus>;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class LiveProjection extends EventTarget {
  status: SyncStatus = { kind: 'syncing' };
  private readonly sync: Sync;
  private readonly stream: SpaceStream;

  private constructor(
    readonly projection: ProjectionClient,
    private readonly ledger: LedgerSpace,
  ) {
    super();
    this.sync = new Sync(ledger, {
      watermark: (t) => projection.call('watermark', t),
      append: (t, ms) => projection.call('append', t, ms),
      years: () => projection.call('years'),
    });
    this.stream = new SpaceStream(() => ledger.streamUrl(), {
      onOpen: () => void this.catchUp(),
      onMessage: (m) => {
        this.ledger
          .verify(m)
          .then(() => this.sync.live(m))
          .catch((err: unknown) => console.warn('[sync] live message not applied:', err));
      },
      onClose: () => this.setStatus({ kind: 'offline' }),
    });
  }

  /**
   * Opens the projection of `ledger`'s space and starts syncing it. If another tab has
   * the projection open, calls `onWaiting` and resolves only once that tab closes.
   */
  static async start(ledger: LedgerSpace, onWaiting: () => void): Promise<LiveProjection> {
    const projection = await ProjectionClient.open(ledger.spaceId, onWaiting);
    const live = new LiveProjection(projection, ledger);
    // Catch up right away, without waiting for the stream, which may be slow or blocked.
    void live.catchUp();
    void live.stream.connect();
    return live;
  }

  stop(): void {
    this.stream.close();
    this.projection.close();
  }

  /**
   * Deletes the projection of `spaceId` from this device when it isn't open, as after
   * locking. Waits like `start` if another tab has it open.
   */
  static async wipe(spaceId: string, onWaiting: () => void): Promise<void> {
    const projection = await ProjectionClient.open(spaceId, onWaiting);
    await projection.wipe();
  }

  /** Stops, and deletes the projection from this device. */
  async wipe(): Promise<void> {
    this.stream.close();
    await this.projection.wipe();
  }

  /** Catches every topic up. Called on start and on every (re)connection of the stream. */
  private async catchUp(): Promise<void> {
    this.setStatus({ kind: 'syncing' });
    try {
      await this.sync.catchUpAll();
      this.setStatus({ kind: 'live' });
    } catch (err) {
      this.setStatus({ kind: 'failed', error: message(err) });
    }
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }
}
