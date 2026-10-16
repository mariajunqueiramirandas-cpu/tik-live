import type { EncoderStats } from "../src/ffmpeg";
import { createLogger } from "../src/log";
import type { Encoder, PipelineFactory, StageCapture } from "../src/session";
import type { VideoSettings } from "@tik-live/shared";

export const quietLog = createLogger({ level: "error", sink: () => undefined });

export class FakeEncoder implements Encoder {
  readonly chunks: Uint8Array[] = [];
  killed = false;
  private resolveExit!: (code: number) => void;
  readonly exited = new Promise<number>((resolve) => {
    this.resolveExit = resolve;
  });
  constructor(
    readonly output: string,
    readonly events: { onStats: (s: EncoderStats) => void; onLog: (line: string) => void },
  ) {}
  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  kill(): void {
    this.killed = true;
    this.resolveExit(255);
  }
  crash(code = 1): void {
    this.resolveExit(code);
  }
}

export class FakeStage implements StageCapture {
  onChunk: ((chunk: Uint8Array) => void) | null = null;
  closedCount = 0;
  private resolveClosed!: (reason: string) => void;
  readonly closed = new Promise<string>((resolve) => {
    this.resolveClosed = resolve;
  });
  constructor(readonly url: string) {}
  async record(onChunk: (chunk: Uint8Array) => void): Promise<void> {
    this.onChunk = onChunk;
    onChunk(new Uint8Array([1, 2, 3]));
  }
  async close(): Promise<void> {
    this.closedCount += 1;
  }
  crash(reason: string): void {
    this.resolveClosed(reason);
  }
}

export class FakeFactory implements PipelineFactory {
  readonly encoders: FakeEncoder[] = [];
  readonly stages: FakeStage[] = [];
  failOpen: string | null = null;
  async openStage(stageUrl: string, _video: VideoSettings): Promise<StageCapture> {
    if (this.failOpen) throw new Error(this.failOpen);
    const stage = new FakeStage(stageUrl);
    this.stages.push(stage);
    return stage;
  }
  spawnEncoder(output: string, _video: VideoSettings, events: { onStats: (s: EncoderStats) => void; onLog: (line: string) => void }): Encoder {
    const encoder = new FakeEncoder(output, events);
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
