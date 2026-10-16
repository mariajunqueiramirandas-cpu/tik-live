import {
  ControlEvent,
  TikTokLiveConnection,
  UserOfflineError,
  WebcastEvent,
} from "tiktok-live-connector";
import { createLogger } from "../log.js";
import {
  normalizeChat,
  normalizeGift,
  normalizeLike,
  normalizeQuestion,
  normalizeSimple,
  normalizeViewerCount,
} from "./normalize.js";
import type { EventListener, EventSource, LiveEvent, SourceStatus } from "./types.js";

const log = createLogger("tiktok");

export interface TikTokSourceOptions {
  username: string;
  /** Optional Euler Stream key for the sign server (higher rate limits). */
  signApiKey?: string;
  /** How long to wait between checks while the account is offline. */
  offlineRetryMs?: number;
}

/**
 * Reads chat, gifts, likes, follows, shares, joins and viewer counts from a
 * TikTok LIVE room via the unofficial tiktok-live-connector library.
 *
 * Runs forever: waits for the account to go live, reconnects with backoff
 * when the websocket drops, and resumes when a new stream starts.
 */
export class TikTokSource implements EventSource {
  readonly name = "tiktok";
  private connection: TikTokLiveConnection | undefined;
  private emit: EventListener | undefined;
  private stopped = false;
  private connected = false;
  private detail = "idle";
  private retryTimer: NodeJS.Timeout | undefined;
  private failures = 0;

  constructor(private readonly options: TikTokSourceOptions) {}

  async start(emit: EventListener): Promise<void> {
    this.emit = emit;
    this.stopped = false;
    void this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    await this.connection?.disconnect().catch(() => undefined);
    this.connection = undefined;
    this.connected = false;
    this.detail = "stopped";
  }

  status(): SourceStatus {
    return { name: this.name, connected: this.connected, detail: this.detail };
  }

  private scheduleRetry(ms: number): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connectLoop(), ms);
  }

  private async connectLoop(): Promise<void> {
    if (this.stopped) return;
    const connection = this.createConnection();
    this.connection = connection;
    this.detail = `connecting to @${this.options.username}`;
    try {
      const state = await connection.connect();
      this.connected = true;
      this.failures = 0;
      this.detail = `live in room ${state.roomId}`;
      log.info(`connected to @${this.options.username} (room ${state.roomId})`);
    } catch (err) {
      this.connected = false;
      if (err instanceof UserOfflineError) {
        const wait = this.options.offlineRetryMs ?? 30_000;
        this.detail = `@${this.options.username} is offline; retrying in ${Math.round(wait / 1000)}s`;
        log.info(this.detail);
        this.scheduleRetry(wait);
      } else {
        this.failures += 1;
        const wait = Math.min(60_000, 2_000 * 2 ** Math.min(this.failures, 5));
        this.detail = `connect failed (${(err as Error).message}); retrying in ${Math.round(wait / 1000)}s`;
        log.warn(this.detail);
        this.scheduleRetry(wait);
      }
    }
  }

  private createConnection(): TikTokLiveConnection {
    const connection = new TikTokLiveConnection(this.options.username, {
      processInitialData: false,
      enableExtendedGiftInfo: true,
      ...(this.options.signApiKey ? { signApiKey: this.options.signApiKey } : {}),
    });

    // The connector's typed-emitter typings don't resolve under NodeNext, so
    // listen through the plain EventEmitter interface it implements at runtime.
    const events = connection as unknown as NodeJS.EventEmitter;
    const forward = (event: LiveEvent | undefined) => {
      if (event && this.emit) this.emit(event);
    };

    events.on(WebcastEvent.CHAT, (data: unknown) => forward(normalizeChat(data)));
    events.on(WebcastEvent.QUESTION_NEW, (data: unknown) => forward(normalizeQuestion(data)));
    events.on(WebcastEvent.GIFT, (data: unknown) => forward(normalizeGift(data)));
    events.on(WebcastEvent.LIKE, (data: unknown) => forward(normalizeLike(data)));
    events.on(WebcastEvent.FOLLOW, (data: unknown) => forward(normalizeSimple("follow", data)));
    events.on(WebcastEvent.SHARE, (data: unknown) => forward(normalizeSimple("share", data)));
    events.on(WebcastEvent.MEMBER, (data: unknown) => forward(normalizeSimple("join", data)));
    events.on(WebcastEvent.ROOM_USER, (data: unknown) => forward(normalizeViewerCount(data)));
    events.on(WebcastEvent.STREAM_END, () => {
      forward({ kind: "stream_end", at: Date.now(), reason: "stream ended" });
    });
    events.on(ControlEvent.ERROR, (err: unknown) => {
      log.warn("connection error", err instanceof Error ? err.message : err);
    });
    events.on(ControlEvent.DISCONNECTED, () => {
      if (this.connection !== connection) return;
      this.connected = false;
      if (this.stopped) return;
      this.failures += 1;
      const wait = Math.min(60_000, 2_000 * 2 ** Math.min(this.failures, 5));
      this.detail = `disconnected; reconnecting in ${Math.round(wait / 1000)}s`;
      log.warn(this.detail);
      this.scheduleRetry(wait);
    });

    return connection;
  }
}
