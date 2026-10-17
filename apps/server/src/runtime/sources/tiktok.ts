import {
  ControlEvent,
  TikTokLiveConnection,
  UserOfflineError,
  WebcastEvent,
} from "tiktok-live-connector";
import type { LiveEvent } from "@tik-live/shared";
import type { Logger } from "../../log";
import {
  normalizeChat,
  normalizeGift,
  normalizeLike,
  normalizeQuestion,
  normalizeSimple,
  normalizeViewerCount,
} from "./normalize";
import type { SignerClient } from "./signer-client";
import { useSigner } from "./signer-routes";
import type { EventListener, EventSource, SourceStatus } from "./types";

export interface TikTokSourceOptions {
  username: string;
  /** Optional Euler Stream key for the sign server (higher rate limits). */
  signApiKey?: string;
  /**
   * Our own signer (ADR-0023). When set it replaces Euler Stream: it says
   * whether the account is live, and signs the request that joins its room.
   */
  signer?: SignerClient;
  /** How long to wait between checks while the account is offline. */
  offlineRetryMs?: number;
  log: Logger;
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
  private live = false;
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
    this.live = false;
    this.detail = "stopped";
  }

  status(): SourceStatus {
    return { name: this.name, connected: this.connected, live: this.live, detail: this.detail };
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
      const state = await connection.connect(await this.resolveRoom());
      this.connected = true;
      this.live = true;
      this.failures = 0;
      this.detail = `live in room ${state.roomId}`;
      this.options.log.info(`connected to @${this.options.username} (room ${state.roomId})`);
    } catch (err) {
      this.connected = false;
      this.live = false;
      if (err instanceof UserOfflineError) {
        const wait = this.options.offlineRetryMs ?? 30_000;
        this.detail = `@${this.options.username} is offline; retrying in ${Math.round(wait / 1000)}s`;
        this.options.log.info(this.detail);
        this.scheduleRetry(wait);
      } else {
        this.failures += 1;
        const wait = Math.min(60_000, 2_000 * 2 ** Math.min(this.failures, 5));
        this.detail = `connect failed (${(err as Error).message}); retrying in ${Math.round(wait / 1000)}s`;
        this.options.log.warn(this.detail);
        this.scheduleRetry(wait);
      }
    }
  }

  /**
   * With our signer, asks it for the room first: the connector's own lookup
   * is another of the calls that needs Euler Stream. Without one the
   * connector finds the room itself, as before.
   */
  private async resolveRoom(): Promise<string | undefined> {
    const { signer, username } = this.options;
    if (!signer) return undefined;
    const room = await signer.lookupRoom(username);
    if (!room.found) throw new Error(`TikTok has no account called @${username}`);
    if (!room.isLive || !room.roomId) throw new UserOfflineError(`@${username} isn't live`);
    return room.roomId;
  }

  private createConnection(): TikTokLiveConnection {
    const { signer } = this.options;
    const connection = new TikTokLiveConnection(this.options.username, {
      processInitialData: false,
      // Our signer has just said the room is live; no need for the connector's own room-info call.
      ...(signer ? { fetchRoomInfoOnConnect: false } : {}),
      // No extended gift info: fetching the room's gift list on connect needs a
      // request signed by Euler Stream's Business plan, and its failure aborts
      // the whole connect. Gift events already carry their diamond count.
      enableExtendedGiftInfo: false,
      ...(this.options.signApiKey ? { signApiKey: this.options.signApiKey } : {}),
    });

    if (signer) useSigner(connection, signer);

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
      this.live = false;
      forward({ kind: "stream_end", at: Date.now(), reason: "stream ended" });
    });
    events.on(ControlEvent.ERROR, (err: unknown) => {
      this.options.log.warn("connection error", err instanceof Error ? err.message : err);
    });
    events.on(ControlEvent.DISCONNECTED, () => {
      if (this.connection !== connection) return;
      this.connected = false;
      this.live = false;
      if (this.stopped) return;
      this.failures += 1;
      const wait = Math.min(60_000, 2_000 * 2 ** Math.min(this.failures, 5));
      this.detail = `disconnected; reconnecting in ${Math.round(wait / 1000)}s`;
      this.options.log.warn(this.detail);
      this.scheduleRetry(wait);
    });

    return connection;
  }
}
