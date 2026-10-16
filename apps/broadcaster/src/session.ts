import type { EncoderStats } from "./ffmpeg";
import type { Logger } from "./log";
import type { BroadcastState, BroadcastStatus, VideoSettings } from "@tik-live/shared";
import { redact } from "./rtmp";

/** The browser side: a stage page recording itself. */
export interface StageCapture {
  /** Starts MediaRecorder; chunks of WebM arrive through `onChunk`. */
  record(onChunk: (chunk: Uint8Array) => void): Promise<void>;
  /** Resolves with a reason when the page crashes, closes or the browser dies. */
  readonly closed: Promise<string>;
  close(): Promise<void>;
}

/** The ffmpeg side. */
export interface Encoder {
  write(chunk: Uint8Array): void;
  /** Resolves with the exit code. */
  readonly exited: Promise<number>;
  kill(): void;
}

export interface PipelineFactory {
  openStage(stageUrl: string, video: VideoSettings): Promise<StageCapture>;
  spawnEncoder(output: string, video: VideoSettings, events: { onStats: (s: EncoderStats) => void; onLog: (line: string) => void }): Encoder;
}

export interface SessionConfig {
  channelId: string;
  stageUrl: string;
  /** Full ingest URL including the stream key. Never logged. */
  output: string;
  streamKey: string;
  video: VideoSettings;
}

const MAX_BACKOFF_MS = 30_000;
/** A run this long counts as healthy and resets the failure streak. */
const HEALTHY_RUN_MS = 60_000;
const FAILED_AFTER = 5;

export function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * One channel's broadcast: keeps a stage page and an encoder running,
 * restarting both with backoff whenever either dies (ADR-0014). Viewers
 * see continuity because the stage's state lives in the app, not here.
 */
export class BroadcastSession {
  private state: BroadcastState = "starting";
  private detail = "Opening the stage";
  private since = new Date();
  private restarts = 0;
  private streak = 0;
  private stats: EncoderStats | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  private current: { stage: StageCapture | null; encoder: Encoder | null } = { stage: null, encoder: null };
  private readonly done: Promise<void>;

  constructor(
    readonly config: SessionConfig,
    private readonly factory: PipelineFactory,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    private readonly backoff: (attempt: number) => number = backoffMs,
  ) {
    this.done = this.loop();
  }

  status(): BroadcastStatus {
    return {
      channelId: this.config.channelId,
      state: this.state,
      detail: this.detail,
      since: this.since.toISOString(),
      restarts: this.restarts,
      stats: this.stats,
    };
  }

  get active(): boolean {
    return !this.stopped;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.teardown();
    await this.done;
  }

  private setState(state: BroadcastState, detail: string): void {
    if (state !== this.state) this.since = new Date(this.now());
    this.state = state;
    this.detail = redact(detail, [this.config.streamKey]);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const startedAt = this.now();
      let reason: string;
      try {
        reason = await this.runOnce();
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
      await this.teardown();
      if (this.stopped) break;
      if (this.now() - startedAt >= HEALTHY_RUN_MS) this.streak = 0;
      this.streak += 1;
      this.restarts += 1;
      const delay = this.backoff(this.streak);
      const safe = redact(reason, [this.config.streamKey]);
      this.log.warn("broadcast interrupted; restarting", { reason: safe, attempt: this.streak, delayMs: delay });
      this.setState(this.streak >= FAILED_AFTER ? "failed" : "retrying", `${safe}. Retrying in ${Math.round(delay / 1000)} s.`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
    this.setState("stopped", "Stopped");
  }

  /** Runs until something breaks; returns why. */
  private async runOnce(): Promise<string> {
    if (this.state !== "failed" && this.state !== "retrying") this.setState("starting", "Opening the stage");
    let firstChunk = true;
    // Stage first: the encoder only starts once there's something to encode.
    const stage = await this.factory.openStage(this.config.stageUrl, this.config.video);
    this.current.stage = stage;
    if (this.stopped) return "stopped";
    const encoder = this.factory.spawnEncoder(this.config.output, this.config.video, {
      onStats: (stats) => {
        this.stats = stats;
      },
      onLog: (line) => this.log.warn("ffmpeg", { line: redact(line, [this.config.streamKey]) }),
    });
    this.current.encoder = encoder;
    await stage.record((chunk) => {
      encoder.write(chunk);
      if (firstChunk) {
        firstChunk = false;
        this.setState("live", "Streaming");
        this.log.info("broadcast live");
      }
    });
    return Promise.race([
      encoder.exited.then((code) => `The encoder stopped (exit ${code})`),
      stage.closed,
      new Promise<string>((resolve) => {
        this.wake = () => resolve("stopped");
      }),
    ]);
  }

  private async teardown(): Promise<void> {
    const { stage, encoder } = this.current;
    this.current = { stage: null, encoder: null };
    this.stats = null;
    encoder?.kill();
    await stage?.close().catch(() => undefined);
  }
}
