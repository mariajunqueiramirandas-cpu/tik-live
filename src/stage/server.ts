import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { Persona, Segment } from "../config.js";
import type { StageNotifier, StreamStats } from "../brain/director.js";
import type { LiveEvent } from "../events/types.js";
import { createLogger } from "../log.js";
import type { SpeechCue, SpeechOutput } from "../voice/pipeline.js";

const log = createLogger("stage");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

const AUDIO_TTL_MS = 120_000;
/** Extra time a stage gets past the cue's estimated duration before we move on anyway. */
const PLAYBACK_GRACE_MS = 4_000;

export type ControlCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "skip" }
  | { type: "say"; text: string }
  | { type: "segment"; id: string }
  | { type: "inject"; event: { kind: "chat" | "gift" | "follow"; handle: string; text?: string; giftName?: string; count?: number; diamonds?: number } };

export interface StageServerOptions {
  host: string;
  port: number;
  publicDir: string;
  persona: Persona;
  controlToken?: string;
}

interface StageClient {
  socket: WebSocket;
  primary: boolean;
}

/**
 * Serves the stage page (an OBS browser source that renders the character,
 * captions and alerts, and plays the voice) and the operator control panel.
 * Implements SpeechOutput by sending cues to the stage and waiting for the
 * primary stage to report that playback finished.
 */
export class StageServer implements SpeechOutput, StageNotifier {
  private readonly server: Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly stages = new Set<StageClient>();
  private readonly controls = new Set<WebSocket>();
  private readonly audio = new Map<string, { data: Buffer; mime: string; expires: number }>();
  private readonly waiters = new Map<string, () => void>();
  private lastSegment: Segment | undefined;
  private lastStats: StreamStats | undefined;
  private controlHandler: ((command: ControlCommand) => void) | undefined;
  private stateProvider: (() => unknown) | undefined;

  constructor(private readonly options: StageServerOptions) {
    this.server = createServer((req, res) => this.handleHttp(req, res));
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/ws/stage") {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.attachStage(ws, url));
      } else if (url.pathname === "/ws/control" && this.authorized(url)) {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.attachControl(ws));
      } else {
        socket.destroy();
      }
    });
    setInterval(() => this.expireAudio(), 30_000).unref();
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.options.port, this.options.host, () => {
        const base = `http://${this.options.host}:${this.options.port}`;
        log.info(`stage:   ${base}/stage/   (OBS browser source, 1080x1920)`);
        log.info(`control: ${base}/control/${this.options.controlToken ? "?token=…" : ""}`);
        resolve();
      });
    });
  }

  close(): void {
    for (const client of this.stages) client.socket.close();
    for (const socket of this.controls) socket.close();
    this.server.close();
  }

  onControl(handler: (command: ControlCommand) => void): void {
    this.controlHandler = handler;
  }

  /** Supplies the snapshot pushed to control panels. */
  setStateProvider(provider: () => unknown): void {
    this.stateProvider = provider;
  }

  pushControl(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const socket of this.controls) if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }

  stageCount(): { primary: number; preview: number } {
    let primary = 0;
    for (const client of this.stages) if (client.primary) primary += 1;
    return { primary, preview: this.stages.size - primary };
  }

  // ---- SpeechOutput -------------------------------------------------------

  play(cue: SpeechCue, signal: AbortSignal): Promise<void> {
    let audioUrl: string | null = null;
    if (cue.audio) {
      this.audio.set(cue.id, { data: cue.audio.data, mime: cue.audio.mime, expires: Date.now() + AUDIO_TTL_MS });
      audioUrl = `/audio/${cue.id}`;
    }
    this.broadcastStage({ type: "speak", id: cue.id, text: cue.text, emotion: cue.emotion, audioUrl, durationMs: cue.durationMs });
    this.pushControl({ type: "spoken", text: cue.text, emotion: cue.emotion, at: Date.now() });

    // With no primary stage connected (e.g. developing headless), pace speech
    // by its estimated duration so the show's rhythm stays realistic.
    const hasPrimary = this.stageCount().primary > 0;
    const timeoutMs = hasPrimary ? cue.durationMs + PLAYBACK_GRACE_MS : cue.durationMs;

    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        this.waiters.delete(cue.id);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      signal.addEventListener("abort", done, { once: true });
      this.waiters.set(cue.id, done);
    });
  }

  interrupt(): void {
    this.broadcastStage({ type: "stop" });
    for (const done of [...this.waiters.values()]) done();
  }

  // ---- StageNotifier ------------------------------------------------------

  alert(event: LiveEvent): void {
    if (!("viewer" in event)) return;
    const name = event.viewer.nickname || event.viewer.handle;
    if (event.kind === "gift") {
      this.broadcastStage({ type: "alert", kind: "gift", name, giftName: event.giftName, count: event.count, diamonds: event.diamonds });
    } else if (event.kind === "follow" || event.kind === "share") {
      this.broadcastStage({ type: "alert", kind: event.kind, name });
    }
  }

  segment(segment: Segment): void {
    this.lastSegment = segment;
    this.broadcastStage({ type: "segment", title: segment.title });
  }

  stats(stats: StreamStats): void {
    this.lastStats = stats;
    this.broadcastStage({ type: "stats", ...stats });
  }

  // ---- internals ----------------------------------------------------------

  private authorized(url: URL): boolean {
    return !this.options.controlToken || url.searchParams.get("token") === this.options.controlToken;
  }

  private broadcastStage(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const client of this.stages) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  }

  private attachStage(socket: WebSocket, url: URL): void {
    const client: StageClient = { socket, primary: url.searchParams.get("preview") !== "1" };
    this.stages.add(client);
    log.info(`${client.primary ? "primary" : "preview"} stage connected`);
    const { persona } = this.options;
    socket.send(JSON.stringify({ type: "config", name: persona.name, visual: persona.visual }));
    if (this.lastSegment) socket.send(JSON.stringify({ type: "segment", title: this.lastSegment.title }));
    if (this.lastStats) socket.send(JSON.stringify({ type: "stats", ...this.lastStats }));

    socket.on("message", (raw) => {
      let message: { type?: string; id?: string };
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.type === "spoken" && client.primary && message.id) this.waiters.get(message.id)?.();
    });
    socket.on("close", () => {
      this.stages.delete(client);
      log.warn(`${client.primary ? "primary" : "preview"} stage disconnected`);
    });
  }

  private attachControl(socket: WebSocket): void {
    this.controls.add(socket);
    if (this.stateProvider) socket.send(JSON.stringify({ type: "state", state: this.stateProvider() }));
    socket.on("message", (raw) => {
      try {
        const command = JSON.parse(String(raw)) as ControlCommand;
        this.controlHandler?.(command);
      } catch (err) {
        log.warn("bad control message", err);
      }
    });
    socket.on("close", () => this.controls.delete(socket));
  }

  private expireAudio(): void {
    const now = Date.now();
    for (const [id, clip] of this.audio) if (clip.expires < now) this.audio.delete(id);
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/") {
      res.writeHead(302, { location: "/control/" + url.search }).end();
      return;
    }

    const audioMatch = url.pathname.match(/^\/audio\/([\w-]+)$/);
    if (audioMatch) {
      const clip = this.audio.get(audioMatch[1] as string);
      if (!clip) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": clip.mime, "cache-control": "no-store" }).end(clip.data);
      return;
    }

    if (url.pathname === "/api/state") {
      if (!this.authorized(url)) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(this.stateProvider?.() ?? {}));
      return;
    }

    this.serveStatic(url.pathname, res);
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    const root = path.resolve(this.options.publicDir);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = path.resolve(root, "." + decoded);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    createReadStream(file).pipe(res);
  }
}
