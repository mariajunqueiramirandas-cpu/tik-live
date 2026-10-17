import type { CaptureSink } from "./capture-server";
import type { EncoderStats } from "./ffmpeg";
import type { Logger } from "./log";
import { AvPacer, type AvTarget } from "./pacer";
import type { BroadcastState, BroadcastStatus, VideoSettings } from "@tik-live/shared";
import { redact } from "./rtmp";

/** The browser side: a stage page that streams its frames and voice once started (ADR-0020). */
/** What the stage sends: the voice's sample rate, and video as H.264 it encoded or raw I420 frames. */
export interface CaptureFormat {
  sampleRate: number;
  video: "h264" | "raw";
}

export interface StageCapture {
  /** Starts capturing; video and voice (16-bit stereo PCM) go to `sink`. */
  start(sink: CaptureSink): Promise<CaptureFormat>;
  /** Resolves with a reason when the page crashes, closes or the browser dies. */
  readonly closed: Promise<string>;
  close(): Promise<void>;
}

/** The ffmpeg side: raw frames and PCM in, FLV to the ingest server out. */
export interface Encoder extends AvTarget {
  /** Resolves with the exit code. */
  readonly exited: Promise<number>;
  kill(): void;
}

export interface EncoderEvents {
  onStats: (s: EncoderStats) => void;
  onLog: (line: string) => void;
}

export interface PipelineFactory {
  openStage(stageUrl: string, video: VideoSettings): Promise<StageCapture>;
  spawnEncoder(output: string, video: VideoSettings, format: CaptureFormat, events: EncoderEvents): Encoder;
}

/**
 * How much later voice is written than video, to keep lips and voice
 * together, measured on the reference setup. Voice reaches the encoder about
 * 15 ms after it was rendered (half a 20 ms packet, transit). Raw frames
 * arrive about 80 ms after they were drawn (29 ms asynchronous readback,
 * 48 ms in the pacer's queue, transit); H.264 from the stage about 60 ms
 * (readback, half a frame waiting for the page's encode tick, encoding).
 */
export const AUDIO_DELAY_MS: Record<CaptureFormat["video"], number> = { raw: 65, h264: 45 };

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
  private detail = "Abrindo o palco";
  private since = new Date();
  private restarts = 0;
  private streak = 0;
  private stats: EncoderStats | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  private current: { stage: StageCapture | null; encoder: Encoder | null; pacer: AvPacer | null } = { stage: null, encoder: null, pacer: null };
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
      // Frames the stage didn't deliver in time (repeated) count as dropped.
      stats: this.stats ? { ...this.stats, droppedFrames: (this.stats.droppedFrames ?? 0) + (this.current.pacer?.counters.repeated ?? 0) } : null,
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
      this.setState(this.streak >= FAILED_AFTER ? "failed" : "retrying", `${safe}. Tentando de novo em ${Math.round(delay / 1000)} s.`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
    this.setState("stopped", "Parada");
  }

  /** Runs until something breaks; returns why. */
  private async runOnce(): Promise<string> {
    if (this.state !== "failed" && this.state !== "retrying") this.setState("starting", "Abrindo o palco");
    const { video } = this.config;
    // Stage first: the encoder only starts once there's something to encode.
    const stage = await this.factory.openStage(this.config.stageUrl, video);
    this.current.stage = stage;
    if (this.stopped) return "stopped";
    // Frames can arrive before start() resolves. Until the pacer exists they're
    // held, so an encoded stream keeps its first keyframe.
    let pacer: AvPacer | null = null;
    const early: Uint8Array[] = [];
    const format = await stage.start({
      video: (frame) => (pacer ? pacer.video(frame) : early.length < 120 && early.push(frame)),
      audio: (pcm) => pacer?.audio(pcm),
    });
    if (this.stopped) return "stopped";
    pacer = new AvPacer({
      video: format.video === "h264" ? "stream" : "frames",
      fps: video.fps,
      frameBytes: (video.width * video.height * 3) / 2,
      sampleRate: format.sampleRate,
      channels: 2,
      audioDelayMs: AUDIO_DELAY_MS[format.video],
    });
    for (const frame of early.splice(0)) pacer.video(frame);
    this.current.pacer = pacer;
    this.log.info("capture started", { video: format.video === "h264" ? "H.264 from the stage" : "raw frames to x264", sampleRate: format.sampleRate });
    const encoder = this.factory.spawnEncoder(this.config.output, video, format, {
      onStats: (stats) => {
        this.stats = stats;
      },
      onLog: (line) => this.log.warn("ffmpeg", { line: redact(line, [this.config.streamKey]) }),
    });
    this.current.encoder = encoder;
    // Every 30 s: frames written, repeated (stage late), skipped (stage early), queue delay.
    const statsTimer = setInterval(() => this.log.info("pacing", { ...pacer.counters }), 30_000);
    void stage.closed.finally(() => clearInterval(statsTimer));
    void encoder.exited.finally(() => clearInterval(statsTimer));
    let first = true;
    pacer.attach({
      writeVideo: (frame) => {
        encoder.writeVideo(frame);
        if (first) {
          first = false;
          this.setState("live", "Transmitindo");
          this.log.info("broadcast live");
        }
      },
      writeAudio: (pcm) => encoder.writeAudio(pcm),
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
    const { stage, encoder, pacer } = this.current;
    this.current = { stage: null, encoder: null, pacer: null };
    this.stats = null;
    pacer?.stop();
    encoder?.kill();
    await stage?.close().catch(() => undefined);
  }
}
