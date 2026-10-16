import type { Socket } from "bun";

/**
 * Writes a byte stream to a Unix socket without ever blocking the event loop
 * (ADR-0020: the voice going into ffmpeg). Connects once the listener is up,
 * queues while it isn't or while the socket is full, and drops the oldest
 * data past `maxQueuedBytes` so a stuck encoder can't grow memory without bound.
 */
export interface SocketWriterOptions {
  maxQueuedBytes: number;
  /** How long to keep retrying the first connection. */
  connectTimeoutMs?: number;
  connect?: (path: string, handlers: { drain(): void; close(): void }) => Promise<Pick<Socket, "write" | "end">>;
  onError?: (message: string) => void;
}

export class SocketWriter {
  private socket: Pick<Socket, "write" | "end"> | null = null;
  private readonly queue: Uint8Array[] = [];
  private queued = 0;
  private closed = false;
  dropped = 0;

  constructor(
    private readonly path: string,
    private readonly options: SocketWriterOptions,
  ) {
    void this.connect();
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  write(chunk: Uint8Array): void {
    if (this.closed || chunk.byteLength === 0) return;
    if (this.socket && this.queue.length === 0) {
      const written = this.socket.write(chunk);
      if (written >= chunk.byteLength) return;
      chunk = chunk.subarray(Math.max(0, written));
    }
    // Copy: the caller may reuse its buffer.
    this.queue.push(chunk.slice());
    this.queued += chunk.byteLength;
    while (this.queued > this.options.maxQueuedBytes && this.queue.length > 1) {
      const oldest = this.queue.shift() as Uint8Array;
      this.queued -= oldest.byteLength;
      this.dropped += oldest.byteLength;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queued = 0;
    try {
      this.socket?.end();
    } catch {
      // already closed
    }
    this.socket = null;
  }

  private flush(): void {
    const socket = this.socket;
    if (!socket) return;
    while (this.queue.length > 0) {
      const head = this.queue[0] as Uint8Array;
      const written = socket.write(head);
      if (written < head.byteLength) {
        this.queue[0] = head.subarray(Math.max(0, written));
        this.queued -= Math.max(0, written);
        return;
      }
      this.queue.shift();
      this.queued -= head.byteLength;
    }
  }

  private async connect(): Promise<void> {
    const connect = this.options.connect ?? defaultConnect;
    const deadline = Date.now() + (this.options.connectTimeoutMs ?? 15_000);
    while (!this.closed && Date.now() < deadline) {
      try {
        const socket = await connect(this.path, {
          drain: () => this.flush(),
          close: () => {
            this.socket = null;
          },
        });
        if (this.closed) {
          socket.end();
          return;
        }
        this.socket = socket;
        this.flush();
        return;
      } catch {
        await Bun.sleep(50);
      }
    }
    if (!this.closed) this.options.onError?.("Couldn't connect to the encoder's audio input");
  }
}

function defaultConnect(path: string, handlers: { drain(): void; close(): void }) {
  return Bun.connect({
    unix: path,
    socket: {
      data() {},
      drain: () => handlers.drain(),
      close: () => handlers.close(),
      error: () => handlers.close(),
    },
  });
}
