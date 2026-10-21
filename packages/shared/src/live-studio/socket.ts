import { LIVE_STUDIO_SUBPROTOCOL } from "../broadcast";

/** The parts of Studio's `sync_settings` snapshot we read (docs/live-studio/stream-deck-protocol.md). */
export interface StudioSettings {
  stream_status?: number;
  recording?: boolean;
  highlight_able?: boolean;
  scene?: string;
  scene_list?: Array<{
    name?: string;
    sources?: Array<{ label?: string; value?: string }>;
    visible_sources?: Array<{ label?: string; value?: string }>;
  }>;
  vibeList?: Array<{ id?: string; name?: string }>;
  playingVibe?: string;
  camera_effect?: {
    sourceList?: Array<{ label?: string; value?: string; isDefault?: boolean; effectId?: string }>;
    typeList?: string[];
    effectList?: Array<{
      key?: string;
      name?: string;
      effects?: Array<{ label?: string; value?: string }>;
    }>;
  };
}

/** Studio turned the connection away: it wants Stream Deck token auth instead of the subprotocol. */
export class StudioAuthError extends Error {
  constructor() {
    super("TikTok LIVE Studio recusou a conexão do agente.");
    this.name = "StudioAuthError";
  }
}

const SYNC_RETRY_MS = 1_000;

function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

interface Waiter {
  test: (settings: StudioSettings) => boolean;
  resolve: (settings: StudioSettings | null) => void;
}

/**
 * One long-lived connection to TikTok LIVE Studio's Stream Deck server.
 *
 * Studio broadcasts its whole state on every change, so we stay joined and
 * keep the latest snapshot. Two of Studio's quirks shape this class:
 * - closing any socket stops Studio's change listeners for every client, so
 *   we don't open and close a socket per command;
 * - a second `join_room` on the same socket registers Studio's action handler
 *   again, so every later action would run twice. Re-joining always leaves
 *   the room first, which disposes the old handlers.
 * Studio only runs actions on a socket whose handlers are registered, and it
 * registers them asynchronously after the join, so actions wait for the first
 * snapshot after each join.
 */
export class StudioSocket {
  settings: StudioSettings | null = null;
  /** When the current join happened. */
  joinedAt = 0;
  private ws: WebSocket | null = null;
  private joined = false;
  /** A snapshot arrived since the last join. */
  private ready = false;
  private closed = false;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private readonly acks = new Map<string, (code: number) => void>();
  private readonly waiters = new Set<Waiter>();

  constructor(
    private readonly options: {
      host: string;
      port: number;
      /** Every snapshot Studio sends, pushed or asked for. */
      onSettings?: (settings: StudioSettings) => void;
      onClose?: () => void;
      now?: () => number;
    },
  ) {}

  get port(): number {
    return this.options.port;
  }

  get isOpen(): boolean {
    return !this.closed && this.joined && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Joined, and Studio has answered since: actions will run. */
  get isReady(): boolean {
    return this.isOpen && this.ready && this.settings !== null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Connects and joins. Rejects with `StudioAuthError` when Studio refuses us. */
  connect(timeoutMs = 3_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.close();
          reject(err);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => settle(new Error("Tempo esgotado ao conectar ao TikTok LIVE Studio.")), timeoutMs);
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://${this.options.host}:${this.options.port}/socket.io/?EIO=4&transport=websocket`, [LIVE_STUDIO_SUBPROTOCOL]);
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      ws.addEventListener("message", (event) => {
        const data = String(event.data);
        if (data === "2") {
          this.send("3");
        } else if (data.startsWith("0")) {
          this.send("40");
        } else if (data.startsWith("44")) {
          settle(new StudioAuthError());
        } else if (data.startsWith("40")) {
          this.join();
          settle();
        } else if (data.startsWith("41")) {
          this.close();
        } else if (data.startsWith("42")) {
          this.handleEvent(data.slice(2));
        }
      });
      ws.addEventListener("close", () => {
        settle(new Error("O TikTok LIVE Studio fechou a conexão."));
        this.handleClosed();
      });
      ws.addEventListener("error", () => settle(new Error("Não foi possível conectar ao TikTok LIVE Studio.")));
    });
  }

  /** Leaves and joins again, which restarts Studio's change listeners if another client stopped them. */
  rejoin(): void {
    if (!this.isOpen) return;
    this.emit("stream_deck/leave_room");
    this.join();
  }

  /** Waits until Studio has answered since the last join. */
  async waitUntilReady(timeoutMs: number): Promise<boolean> {
    if (this.isReady) return true;
    if (timeoutMs <= 0) return false;
    return (await this.waitFor(() => this.ready, timeoutMs)) !== null;
  }

  /**
   * Resolves with the first snapshot that passes `test`, starting with the
   * current one, or null on timeout, close, or when `cancel` returns true.
   */
  waitFor(test: (settings: StudioSettings) => boolean, timeoutMs: number, cancel?: () => boolean): Promise<StudioSettings | null> {
    if (this.settings && this.ready && test(this.settings)) return Promise.resolve(this.settings);
    if (!this.isOpen || timeoutMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        test,
        resolve: (settings) => {
          clearTimeout(timer);
          if (poll) clearInterval(poll);
          this.waiters.delete(waiter);
          resolve(settings);
        },
      };
      const timer = setTimeout(() => waiter.resolve(null), timeoutMs);
      unref(timer);
      const poll = cancel
        ? setInterval(() => {
            if (cancel()) waiter.resolve(null);
          }, 250)
        : null;
      if (poll) unref(poll);
      this.waiters.add(waiter);
    });
  }

  /**
   * Runs a Stream Deck action and resolves with Studio's ack code (0 is
   * success), or -1 when Studio didn't answer in time or the socket closed.
   */
  action(action: string, payload: Record<string, unknown>, timeoutMs: number): Promise<number> {
    if (!this.isReady) return Promise.resolve(-1);
    const context = `lantern_${this.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const done = (code: number) => {
        clearTimeout(timer);
        this.acks.delete(context);
        resolve(code);
      };
      const timer = setTimeout(() => done(-1), timeoutMs);
      unref(timer);
      this.acks.set(context, done);
      this.emit("stream_deck/action_emit", JSON.stringify({ action, context, payload }));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // Ignore close errors.
    }
    this.handleClosed();
  }

  private join(): void {
    this.joined = true;
    this.ready = false;
    this.joinedAt = this.now();
    this.emit("stream_deck/join_room");
    // Studio drops a sync request that lands before its handlers exist, and
    // answers with an empty snapshot while it starts up: ask until it answers.
    this.requestSync();
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => {
      if (this.ready || !this.isOpen) {
        if (this.syncTimer) clearInterval(this.syncTimer);
        this.syncTimer = null;
        return;
      }
      this.requestSync();
    }, SYNC_RETRY_MS);
    unref(this.syncTimer);
  }

  private requestSync(): void {
    this.emit("stream_deck/sync_settings");
  }

  private emit(event: string, payload?: string): void {
    this.send(`42${JSON.stringify(payload === undefined ? [event] : [event, payload])}`);
  }

  private send(frame: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(frame);
    } catch {
      // A closing socket; the close handler cleans up.
    }
  }

  private handleEvent(raw: string): void {
    let name: unknown;
    let payload: unknown;
    try {
      [name, payload] = JSON.parse(raw) as [unknown, unknown];
    } catch {
      return;
    }
    if (typeof name !== "string") return;
    if (name === "stream_deck/sync_settings") {
      // No payload: Studio is still starting. The retry timer asks again.
      if (typeof payload !== "string") return;
      let settings: StudioSettings;
      try {
        settings = JSON.parse(payload) as StudioSettings;
      } catch {
        return;
      }
      if (!settings || typeof settings !== "object") return;
      this.settings = settings;
      this.ready = true;
      this.options.onSettings?.(settings);
      for (const waiter of [...this.waiters]) {
        if (waiter.test(settings)) waiter.resolve(settings);
      }
      return;
    }
    const context = name.startsWith("stream_deck/") ? name.slice("stream_deck/".length) : "";
    const ack = this.acks.get(context);
    if (!ack) return;
    let code = -1;
    try {
      const parsed = (typeof payload === "string" ? JSON.parse(payload) : payload) as { code?: unknown } | null;
      if (typeof parsed?.code === "number") code = parsed.code;
    } catch {
      // Malformed ack: treat as failed.
    }
    ack(code);
  }

  private handleClosed(): void {
    const wasOpen = !this.closed || this.joined;
    this.closed = true;
    this.joined = false;
    this.ready = false;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    for (const ack of [...this.acks.values()]) ack(-1);
    for (const waiter of [...this.waiters]) waiter.resolve(null);
    if (wasOpen) this.options.onClose?.();
  }
}
