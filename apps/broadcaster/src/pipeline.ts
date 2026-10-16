import { chromium, type Browser } from "playwright-core";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CaptureServer } from "./capture-server";
import { ffmpegArgs, ProgressParser } from "./ffmpeg";
import { FlvVideoMuxer, parseVideoMessage } from "./flv";
import type { Logger } from "./log";
import type { VideoSettings } from "@tik-live/shared";
import type { CaptureFormat, Encoder, EncoderEvents, PipelineFactory, StageCapture } from "./session";
import { SocketWriter } from "./socket-writer";

/** Frames waiting for ffmpeg before new ones are skipped (one second at 30 fps). */
const MAX_FRAMES_IN_FLIGHT = 30;
/** Voice queued for ffmpeg before the oldest is dropped (five seconds of 48 kHz stereo). */
const MAX_VOICE_BYTES = 48_000 * 4 * 5;

export type Renderer = "llvmpipe" | "lavapipe" | "swiftshader";

/** Flags every broadcast needs: audio without a user gesture, no throttling of pages nobody looks at. */
const BASE_ARGS = [
  "--ignore-gpu-blocklist",
  // Lets Chromium fall back to SwiftShader if Mesa can't start, instead of losing WebGL.
  "--enable-unsafe-swiftshader",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-dev-shm-usage",
];

/**
 * How Chromium renders WebGL with no GPU (ADR-0020). Mesa's llvmpipe
 * compiles each shader with LLVM into 8-wide AVX2 code and rasterizes on
 * every core: about 5x less CPU per frame than the SwiftShader bundled with
 * Chromium. lavapipe is the same rasterizer behind Vulkan.
 */
export function chromiumLaunch(
  renderer: Renderer,
  options: { threads?: number; stageOrigins?: readonly string[] } = {},
): { args: string[]; env: Record<string, string> } {
  const base = [...BASE_ARGS, ...secureContextArgs(options.stageOrigins ?? [])];
  const mesa: Record<string, string> = {
    // 256-bit vectors: AVX2. (Mesa would pick this itself on AVX2 hosts; pinning keeps AVX-512 hosts identical.)
    LP_NATIVE_VECTOR_WIDTH: "256",
    ...(options.threads ? { LP_NUM_THREADS: String(options.threads) } : {}),
  };
  switch (renderer) {
    case "llvmpipe":
      return {
        args: [...base, "--use-gl=angle", "--use-angle=gl-egl"],
        env: { ...mesa, EGL_PLATFORM: "surfaceless", GALLIUM_DRIVER: "llvmpipe", LIBGL_ALWAYS_SOFTWARE: "1" },
      };
    case "lavapipe":
      return {
        args: [...base, "--use-angle=vulkan", "--use-vulkan=native", "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan", "--disable-vulkan-surface"],
        env: { ...mesa, VK_ICD_FILENAMES: LAVAPIPE_ICD, VK_DRIVER_FILES: LAVAPIPE_ICD },
      };
    case "swiftshader":
      return { args: [...base, "--use-angle=swiftshader"], env: {} };
  }
}

const LAVAPIPE_ICD = "/usr/share/vulkan/icd.d/lvp_icd.json";

/**
 * The capture needs a secure context (AudioWorklet, WebCodecs). Inside
 * Compose the stage is served over plain HTTP on the private network
 * (http://lantern-app:8080), which Chrome doesn't count as secure, so the
 * configured stage origins, and only those, are treated as if they were.
 */
export function secureContextArgs(stageOrigins: readonly string[]): string[] {
  const insecure = stageOrigins.filter((origin) => {
    const url = new URL(origin);
    return url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  });
  return insecure.length > 0 ? [`--unsafely-treat-insecure-origin-as-secure=${insecure.join(",")}`] : [];
}

/**
 * One Chrome per broadcast, not one page each in a shared browser. Chrome
 * runs all of a browser's WebGL through a single GPU process, and llvmpipe
 * blocks that process whenever a frame reads back what it just drew; two
 * stages in one browser render one after the other, and two broadcasts on 4
 * vCPU managed 23 fps each with a core idle. A browser of their own lets
 * their frames overlap, and a crash takes down one broadcast, not all.
 */
export class ChromiumPipeline implements PipelineFactory {
  private readonly browsers = new Set<Browser>();
  private readonly capture = new CaptureServer();

  constructor(
    private readonly options: {
      chromiumPath?: string;
      ffmpegPath: string;
      log: Logger;
      renderer?: Renderer;
      renderThreads?: number;
      /** Origins stage pages load from; plain-HTTP ones are treated as secure contexts. */
      stageOrigins?: readonly string[];
      /** "auto": let the stage encode H.264 when the browser can; "x264": always raw frames. */
      videoEncoder?: "auto" | "x264";
      x264Preset?: string;
    },
  ) {}

  private async launchBrowser(): Promise<Browser> {
    const launch = chromiumLaunch(this.options.renderer ?? "llvmpipe", {
      threads: this.options.renderThreads,
      stageOrigins: this.options.stageOrigins ?? [],
    });
    const browser = await chromium.launch({
      headless: true,
      args: launch.args,
      env: { ...process.env, ...launch.env } as Record<string, string>,
      ...(this.options.chromiumPath ? { executablePath: this.options.chromiumPath } : {}),
    });
    this.browsers.add(browser);
    browser.on("disconnected", () => this.browsers.delete(browser));
    return browser;
  }

  async openStage(stageUrl: string, video: VideoSettings): Promise<StageCapture> {
    const browser = await this.launchBrowser();
    try {
      return await this.loadStage(browser, stageUrl, video);
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  private async loadStage(browser: Browser, stageUrl: string, video: VideoSettings): Promise<StageCapture> {
    // The stage's CSP only allows its own origin; capture goes to our loopback endpoint.
    const context = await browser.newContext({ viewport: { width: video.width, height: video.height }, deviceScaleFactor: 1, bypassCSP: true });
    // The stage reaches the capture endpoint on loopback. Chrome blocks that
    // from any other address (Local Network Access) unless the page has the
    // permission; inside Compose the stage is on the private network.
    await context.grantPermissions(["local-network-access"], { origin: new URL(stageUrl).origin }).catch((error: unknown) => {
      this.options.log.warn("couldn't allow the stage to reach the capture endpoint", { message: String(error).slice(0, 200) });
    });
    const page = await context.newPage();
    let fail: (reason: string) => void = () => undefined;
    const closed = new Promise<string>((resolve) => {
      fail = resolve;
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
      throw new Error(response?.status() === 404 ? "The stage link no longer works" : `The stage page didn't load (${response?.status() ?? "no response"})`);
    }
    await page.waitForFunction(() => Boolean((window as unknown as { __lantern?: unknown }).__lantern), undefined, { timeout: 20_000 });

    const token = crypto.randomUUID().replaceAll("-", "");
    let statsTimer: ReturnType<typeof setInterval> | null = null;
    const renderer = await page.evaluate(() => (window as unknown as { __lantern: { engine: { telemetry(): { renderer: string | null } } } }).__lantern.engine.telemetry().renderer);
    const wanted = this.options.renderer ?? "llvmpipe";
    if (wanted !== "swiftshader" && !/llvmpipe/i.test(renderer ?? "")) {
      this.options.log.warn("stage isn't rendering with Mesa llvmpipe; expect several times the CPU", { requested: wanted, renderer });
    }
    return {
      closed,
      start: async (sink) => {
        const endpoint = this.capture.register(token, sink);
        const encode = (this.options.videoEncoder ?? "auto") === "auto" ? { bitrate: video.bitrateKbps * 1000, keyframeInterval: video.fps * 2 } : undefined;
        const ready = await page.evaluate(
          (request) =>
            (
              window as unknown as { __lantern: { startCapture(r: typeof request): Promise<{ sampleRate: number; video: "h264" | "raw" }> } }
            ).__lantern.startCapture(request),
          { endpoint, width: video.width, height: video.height, fps: video.fps, ...(encode ? { encode } : {}) },
        );
        // What the page produced: frames read back, skipped (readback busy) or held back (socket full).
        statsTimer = setInterval(() => {
          page
            .evaluate(() => (window as unknown as { __lantern: { captureStats(): Promise<unknown> } }).__lantern.captureStats())
            .then((stats) => this.options.log.info("capture", stats as Record<string, unknown>))
            .catch(() => undefined);
        }, 30_000);
        return { sampleRate: ready.sampleRate, video: ready.video === "h264" ? "h264" : "raw" };
      },
      close: async () => {
        if (statsTimer) clearInterval(statsTimer);
        this.capture.unregister(token);
        await browser.close().catch(() => undefined);
      },
    };
  }

  spawnEncoder(output: string, video: VideoSettings, format: CaptureFormat, events: EncoderEvents): Encoder {
    const socketPath = path.join(tmpdir(), `lantern-voice-${crypto.randomUUID()}.sock`);
    const args = ffmpegArgs(output, video, { socketPath, sampleRate: format.sampleRate }, { video: format.video, ...(this.options.x264Preset ? { x264Preset: this.options.x264Preset } : {}) });
    const proc = Bun.spawn([this.options.ffmpegPath, ...args], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
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
          } else if (!ProgressParser.isNoise(line)) {
            events.onLog(line);
          }
        }
      }
    })().catch(() => undefined);
    // ffmpeg opens the voice socket as its second input; connect once it listens.
    const voice = new SocketWriter(socketPath, { maxQueuedBytes: MAX_VOICE_BYTES, onError: (message) => events.onLog(message) });
    let open = true;
    let inFlight = 0;
    // H.264 from the stage goes in as FLV, so ffmpeg gets the stage's timestamps.
    const muxer = format.video === "h264" ? new FlvVideoMuxer({ width: video.width, height: video.height, fps: video.fps }) : null;
    return {
      exited: proc.exited,
      writeVideo(chunk) {
        if (!open) return;
        let frame = chunk;
        if (muxer) {
          const message = parseVideoMessage(chunk);
          const bytes = message ? muxer.push(message) : null;
          if (!bytes) return;
          frame = bytes;
        }
        // ffmpeg fell behind: skip raw frames rather than buffer without limit
        // (never encoded ones: every chunk matters to the decoder).
        if (format.video === "raw" && inFlight >= MAX_FRAMES_IN_FLIGHT) return;
        try {
          proc.stdin.write(frame);
          const flushed = proc.stdin.flush();
          if (flushed instanceof Promise) {
            inFlight += 1;
            flushed.then(
              () => {
                inFlight -= 1;
              },
              () => {
                open = false;
              },
            );
          }
        } catch {
          open = false;
        }
      },
      writeAudio(pcm) {
        if (open) voice.write(pcm);
      },
      kill() {
        open = false;
        voice.close();
        try {
          void proc.stdin.end();
        } catch {
          // already closed
        }
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 3000).unref?.();
        void proc.exited.then(() => unlink(socketPath).catch(() => undefined));
      },
    };
  }

  async close(): Promise<void> {
    this.capture.stop();
    await Promise.all([...this.browsers].map((browser) => browser.close().catch(() => undefined)));
    this.browsers.clear();
  }
}
