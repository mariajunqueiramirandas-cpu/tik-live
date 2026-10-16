import { chromium, type Browser } from "playwright-core";
import { ffmpegArgs, ProgressParser, type EncoderStats } from "./ffmpeg";
import type { Logger } from "./log";
import type { VideoSettings } from "@tik-live/shared";
import type { Encoder, PipelineFactory, StageCapture } from "./session";

/**
 * Chromium flags for rendering in a container without a GPU: WebGL2 through
 * SwiftShader, audio that plays without a user gesture, and no throttling of
 * pages nobody is looking at.
 */
export const CHROMIUM_ARGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-dev-shm-usage",
];

/** Runs in the stage page: records the stage (video and voice) in 250 ms WebM chunks. */
const RECORDER = `async ({ fps, videoBitsPerSecond }) => {
  const handle = window.__lantern;
  if (!handle) throw new Error("This page isn't a stage in broadcast mode.");
  await handle.engine.audio.unlock();
  const stream = handle.captureStream(fps);
  const mimeType = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond, audioBitsPerSecond: 160000 });
  let chain = Promise.resolve();
  const encode = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    // The MIME type has a comma of its own ("codecs=vp8,opus"): split at the base64 marker.
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf("base64,") + 7));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    chain = chain.then(() => encode(event.data)).then((b64) => window.__lanternChunk(b64));
  };
  recorder.onerror = () => window.__lanternFailed("The recorder stopped");
  recorder.start(250);
  window.__lanternRecorder = recorder;
}`;

export class ChromiumPipeline implements PipelineFactory {
  private browser: Promise<Browser> | null = null;

  constructor(
    private readonly options: { chromiumPath?: string; ffmpegPath: string; log: Logger },
  ) {}

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const launching = chromium.launch({
        headless: true,
        args: CHROMIUM_ARGS,
        ...(this.options.chromiumPath ? { executablePath: this.options.chromiumPath } : {}),
      });
      this.browser = launching;
      launching
        .then((browser) =>
          browser.on("disconnected", () => {
            if (this.browser === launching) this.browser = null;
            this.options.log.warn("chromium disconnected");
          }),
        )
        .catch(() => {
          if (this.browser === launching) this.browser = null;
        });
    }
    return this.browser;
  }

  async openStage(stageUrl: string, video: VideoSettings): Promise<StageCapture> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({ viewport: { width: video.width, height: video.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    let onChunk: ((chunk: Uint8Array) => void) | null = null;
    let fail: (reason: string) => void = () => undefined;
    const closed = new Promise<string>((resolve) => {
      fail = resolve;
    });
    await page.exposeFunction("__lanternChunk", (b64: string) => {
      onChunk?.(Buffer.from(b64, "base64"));
    });
    await page.exposeFunction("__lanternFailed", (reason: string) => fail(String(reason).slice(0, 200)));
    page.on("crash", () => fail("The stage page crashed"));
    page.on("close", () => fail("The stage page closed"));
    browser.once("disconnected", () => fail("The browser stopped"));
    page.on("pageerror", (err) => this.options.log.warn("stage page error", { message: err.message.slice(0, 300) }));

    const url = new URL(stageUrl);
    url.searchParams.set("role", "broadcast");
    url.searchParams.set("fps", String(video.fps));
    const response = await page.goto(url.toString(), { waitUntil: "load", timeout: 30_000 });
    if (!response || !response.ok()) {
      await context.close().catch(() => undefined);
      throw new Error(response?.status() === 404 ? "The stage link no longer works" : `The stage page didn't load (${response?.status() ?? "no response"})`);
    }
    await page.waitForFunction(() => Boolean((window as unknown as { __lantern?: unknown }).__lantern), undefined, { timeout: 20_000 });

    return {
      closed,
      record: async (handler) => {
        onChunk = handler;
        await page.evaluate(`(${RECORDER})(${JSON.stringify({ fps: video.fps, videoBitsPerSecond: Math.max(4_000_000, video.bitrateKbps * 2000) })})`);
      },
      close: async () => {
        onChunk = null;
        await context.close().catch(() => undefined);
      },
    };
  }

  spawnEncoder(output: string, video: VideoSettings, events: { onStats: (s: EncoderStats) => void; onLog: (line: string) => void }): Encoder {
    const proc = Bun.spawn([this.options.ffmpegPath, ...ffmpegArgs(output, video)], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    void (async () => {
      const decoder = new TextDecoder();
      const progress = new ProgressParser();
      let buffer = "";
      for await (const chunk of proc.stderr) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r|\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          if (ProgressParser.isProgressLine(line)) {
            const stats = progress.feed(line);
            if (stats) events.onStats(stats);
          } else {
            events.onLog(line);
          }
        }
      }
    })().catch(() => undefined);
    let open = true;
    return {
      exited: proc.exited,
      write(chunk) {
        if (!open) return;
        try {
          proc.stdin.write(chunk);
          void proc.stdin.flush();
        } catch {
          open = false;
        }
      },
      kill() {
        open = false;
        try {
          void proc.stdin.end();
        } catch {
          // already closed
        }
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 3000).unref?.();
      },
    };
  }

  async close(): Promise<void> {
    const browser = await this.browser?.catch(() => null);
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }
}
