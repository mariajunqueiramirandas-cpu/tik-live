import type { Logger } from "./log";
import { startBroadcastSchema, type BroadcasterList, type BroadcastStatus, type StartBroadcast } from "@tik-live/shared";
import { ingestUrl, RtmpUrlError, validateRtmpUrl, type RtmpCheckOptions } from "./rtmp";
import { BroadcastSession, type PipelineFactory } from "./session";

export class BroadcastError extends Error {
  constructor(
    readonly status: 400 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ManagerOptions {
  factory: PipelineFactory;
  log: Logger;
  maxConcurrent: number;
  /** Origins the stage page may come from (the app); anything else is refused. */
  stageOrigins: readonly string[];
  rtmp?: RtmpCheckOptions;
  /** Tests: faster restarts. */
  backoff?: (attempt: number) => number;
}

/** All broadcasts on this host, one session per channel, capped by capacity. */
export class BroadcastManager {
  private readonly sessions = new Map<string, { session: BroadcastSession; fingerprint: string }>();

  constructor(private readonly options: ManagerOptions) {}

  /**
   * Starts a channel's broadcast, or leaves it running when nothing changed,
   * or restarts it when the target or stage changed. Idempotent.
   */
  async ensure(input: StartBroadcast): Promise<BroadcastStatus> {
    const parsed = startBroadcastSchema.safeParse(input);
    if (!parsed.success) throw new BroadcastError(400, "invalid_input", parsed.error.issues[0]?.message ?? "Invalid broadcast request.");
    const req = parsed.data;

    const stage = new URL(req.stageUrl);
    if (!this.options.stageOrigins.includes(stage.origin) || !stage.pathname.startsWith("/s/")) {
      throw new BroadcastError(422, "stage_not_allowed", "That stage URL isn't on this app.");
    }
    let server: URL;
    try {
      server = await validateRtmpUrl(req.rtmpUrl, this.options.rtmp);
    } catch (err) {
      throw new BroadcastError(422, "bad_rtmp_url", err instanceof RtmpUrlError ? err.message : "That server URL isn't usable.");
    }

    const fingerprint = JSON.stringify([req.stageUrl, server.toString(), req.streamKey, req.video]);
    const existing = this.sessions.get(req.channelId);
    if (existing?.fingerprint === fingerprint && existing.session.active) return existing.session.status();

    const others = [...this.sessions.entries()].filter(([id, s]) => id !== req.channelId && s.session.active).length;
    if (others >= this.options.maxConcurrent) {
      throw new BroadcastError(409, "at_capacity", "Cloud broadcast is at capacity right now. Try again later, or stream from OBS.");
    }

    if (existing) await existing.session.stop();
    const log = this.options.log.child({ channelId: req.channelId });
    const session = new BroadcastSession(
      { channelId: req.channelId, stageUrl: req.stageUrl, output: ingestUrl(server, req.streamKey), streamKey: req.streamKey, video: req.video },
      this.options.factory,
      log,
      Date.now,
      this.options.backoff,
    );
    this.sessions.set(req.channelId, { session, fingerprint });
    log.info("broadcast requested", { server: server.host, video: req.video });
    return session.status();
  }

  async stop(channelId: string): Promise<boolean> {
    const entry = this.sessions.get(channelId);
    if (!entry) return false;
    this.sessions.delete(channelId);
    await entry.session.stop();
    this.options.log.info("broadcast stopped", { channelId });
    return true;
  }

  get(channelId: string): BroadcastStatus | null {
    return this.sessions.get(channelId)?.session.status() ?? null;
  }

  list(): BroadcasterList {
    const broadcasts = [...this.sessions.values()].map((s) => s.session.status());
    return { broadcasts, capacity: { max: this.options.maxConcurrent, used: broadcasts.length } };
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
