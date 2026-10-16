import type { CaptureSink } from "../src/capture-server";
import { createLogger } from "../src/log";
import type { CaptureFormat, Encoder, EncoderEvents, PipelineFactory, StageCapture } from "../src/session";
import type { VideoSettings } from "@tik-live/shared";

export const quietLog = createLogger({ level: "error", sink: () => undefined });

export class FakeEncoder implements Encoder {
  readonly frames: Uint8Array[] = [];
  readonly audio: Uint8Array[] = [];
  killed = false;
  private resolveExit!: (code: number) => void;
  readonly exited = new Promise<number>((resolve) => {
    this.resolveExit = resolve;
  });
  constructor(
    readonly output: string,
    readonly format: CaptureFormat,
    readonly events: EncoderEvents,
  ) {}
  get sampleRate(): number {
    return this.format.sampleRate;
  }
  writeVideo(frame: Uint8Array): void {
    this.frames.push(frame);
  }
  writeAudio(pcm: Uint8Array): void {
    this.audio.push(pcm);
  }
  kill(): void {
    this.killed = true;
    this.resolveExit(255);
  }
  crash(code = 1): void {
    this.resolveExit(code);
  }
}

/**
 * A stage that, once started, streams video and voice packets like the page:
 * raw frames of the right size, or (h264) small numbered chunks.
 */
export class FakeStage implements StageCapture {
  sink: CaptureSink | null = null;
  closedCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private resolveClosed!: (reason: string) => void;
  readonly closed = new Promise<string>((resolve) => {
    this.resolveClosed = resolve;
  });
  constructor(
    readonly url: string,
    private readonly video: VideoSettings,
    private readonly kind: CaptureFormat["video"] = "raw",
  ) {}
  async start(sink: CaptureSink): Promise<CaptureFormat> {
    this.sink = sink;
    const frame = new Uint8Array((this.video.width * this.video.height * 3) / 2);
    const voice = new Uint8Array(960 * 4);
    let n = 0;
    // Encoded chunks start right away, before start() resolves, like the page's first keyframe.
    const sendVideo = () => sink.video(this.kind === "h264" ? new Uint8Array([0, 0, 0, 1, n++ & 255]) : frame);
    if (this.kind === "h264") sendVideo();
    this.timer = setInterval(() => {
      sendVideo();
      sink.audio(voice);
    }, 10);
    return { sampleRate: 48_000, video: this.kind };
  }
  async close(): Promise<void> {
    this.closedCount += 1;
    if (this.timer) clearInterval(this.timer);
  }
  crash(reason: string): void {
    if (this.timer) clearInterval(this.timer);
    this.resolveClosed(reason);
  }
}

export class FakeFactory implements PipelineFactory {
  readonly encoders: FakeEncoder[] = [];
  readonly stages: FakeStage[] = [];
  failOpen: string | null = null;
  /** What the next stages send. */
  kind: CaptureFormat["video"] = "raw";
  async openStage(stageUrl: string, video: VideoSettings): Promise<StageCapture> {
    if (this.failOpen) throw new Error(this.failOpen);
    const stage = new FakeStage(stageUrl, video, this.kind);
    this.stages.push(stage);
    return stage;
  }
  spawnEncoder(output: string, _video: VideoSettings, format: CaptureFormat, events: EncoderEvents): Encoder {
    const encoder = new FakeEncoder(output, format, events);
    this.encoders.push(encoder);
    return encoder;
  }
}

export async function eventually(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}
