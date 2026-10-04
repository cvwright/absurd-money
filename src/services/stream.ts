/**
 * The space's WebSocket stream at `/spaces/{id}/stream`, which carries every message
 * committed to the space, on every topic. Reconnects with exponential backoff, and calls
 * `onOpen` on every connection, so the caller can catch up on what it missed while
 * disconnected before trusting live messages again.
 */

import type { Message } from 'reeeductio';

export interface StreamHandlers {
  onOpen(): void;
  onMessage(m: Message): void;
  onClose(): void;
}

const MIN_DELAY = 1000;
const MAX_DELAY = 30_000;

export class SpaceStream {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay = MIN_DELAY;
  private closed = false;

  /** `url` is asked for again on every connection, since the token in it expires. */
  constructor(
    private readonly url: () => Promise<string>,
    private readonly handlers: StreamHandlers,
  ) {}

  async connect(): Promise<void> {
    if (this.ws || this.closed) return;
    let url: string;
    try {
      url = await this.url();
    } catch {
      this.retry();
      return;
    }
    if (this.closed) return;
    const ws = new WebSocket(url);
    ws.onopen = () => {
      this.delay = MIN_DELAY;
      this.handlers.onOpen();
    };
    ws.onmessage = (e: MessageEvent<string>) => {
      let data: unknown;
      try {
        data = JSON.parse(e.data);
      } catch {
        return; // "pong"
      }
      // Keep-alives are {"type": "ping"}; messages have a hash.
      if (typeof data === 'object' && data !== null && 'message_hash' in data) this.handlers.onMessage(data as Message);
    };
    ws.onclose = () => {
      this.ws = null;
      this.handlers.onClose();
      this.retry();
    };
    this.ws = ws;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private retry(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, this.delay);
    this.delay = Math.min(this.delay * 2, MAX_DELAY);
  }
}
