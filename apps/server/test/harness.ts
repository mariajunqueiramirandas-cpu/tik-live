import type { LiveEvent, StageServerMessage, StudioServerMessage } from "@tik-live/shared";
import { websocket } from "hono/bun";
import path from "node:path";
import { createApp } from "../src/app";
import type { MercadoPagoClient } from "../src/billing/mercadopago";
import { testConfig } from "../src/config";
import { openDatabase } from "../src/db/client";
import type { BroadcasterClient } from "../src/broadcast/client";
import type { LiveStudioClient } from "../src/broadcast/live-studio";
import { createDeps, type AppDeps } from "../src/deps";
import type { IdentityProvider } from "../src/identity/types";
import { configureLogging } from "../src/log";
import { ScriptedHost } from "../src/runtime/brain/host";
import type { EventListener, EventSource } from "../src/runtime/sources/types";
import { NoTts, type TtsProvider } from "../src/runtime/voice/tts";

const MIGRATIONS = path.resolve(import.meta.dir, "../drizzle");
configureLogging({ level: (process.env.TEST_LOG_LEVEL as "debug" | undefined) ?? "error" });

/** An event source the test drives by hand. */
export class ManualSource implements EventSource {
  readonly name = "simulator";
  private emit: EventListener | undefined;
  async start(emit: EventListener): Promise<void> {
    this.emit = emit;
  }
  async stop(): Promise<void> {
    this.emit = undefined;
  }
  status() {
    return { name: this.name, connected: true, live: true, detail: "manual" };
  }
  push(event: LiveEvent): void {
    this.emit?.(event);
  }
}

export interface TestServer {
  deps: AppDeps;
  base: string;
  sources: Map<string, ManualSource>;
  api(pathname: string, init?: RequestInit & { user?: string; json?: unknown }): Promise<Response>;
  json<T = any>(pathname: string, init?: RequestInit & { user?: string; json?: unknown }): Promise<{ status: number; body: T }>;
  socket(pathname: string, user?: string, headers?: Record<string, string>): Promise<TestSocket>;
  close(): Promise<void>;
}

export async function startTestServer(
  options: {
    env?: Record<string, string>;
    mercadoPago?: MercadoPagoClient;
    identity?: IdentityProvider;
    database?: Awaited<ReturnType<typeof openDatabase>>;
    broadcaster?: BroadcasterClient;
    liveStudio?: LiveStudioClient;
    /** Every host's voice; captions only by default. */
    tts?: () => TtsProvider;
  } = {},
): Promise<TestServer> {
  const config = testConfig({ PUBLIC_URL: "http://localhost:9999", ...options.env });
  const database = options.database ?? (await openDatabase("pglite://memory", MIGRATIONS));
  await database.migrate();
  const sources = new Map<string, ManualSource>();
  const deps = await createDeps(config, database, {
    anthropic: null,
    ...(options.mercadoPago ? { mercadoPago: options.mercadoPago } : {}),
    ...(options.identity ? { identity: options.identity } : {}),
    ...(options.broadcaster ? { broadcaster: options.broadcaster } : {}),
    ...(options.liveStudio ? { liveStudio: options.liveStudio } : {}),
    runtimeOverrides: {
      makeSource: (channel) => {
        const source = new ManualSource();
        sources.set(channel.id, source);
        return source;
      },
      makeHost: (channel) => new ScriptedHost(channel.persona),
      makeTts: options.tts ?? (() => new NoTts()),
    },
  });
  const app = createApp(deps);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket });
  const base = `http://127.0.0.1:${server.port}`;

  const api: TestServer["api"] = (pathname, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.user) headers.set("x-dev-user", init.user);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    return fetch(`${base}${pathname}`, { ...init, headers, body: body ?? null });
  };

  return {
    deps,
    base,
    sources,
    api,
    async json(pathname, init) {
      const res = await api(pathname, init);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    socket: (pathname, user, headers) =>
      openSocket(`${base.replace("http", "ws")}${pathname}${user ? `${pathname.includes("?") ? "&" : "?"}devUser=${user}` : ""}`, headers),
    async close() {
      await deps.manager.shutdown();
      server.stop(true);
      deps.audio.close();
      if (!options.database) await database.close();
    },
  };
}

/** A WebSocket client that buffers messages so tests can await specific ones. */
export class TestSocket {
  readonly messages: any[] = [];
  private waiters: Array<{ match: (m: any) => boolean; resolve: (m: any) => void }> = [];
  closed: { code: number; reason: string } | null = null;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      this.messages.push(message);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(message)) return true;
        w.resolve(message);
        return false;
      });
    });
    ws.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
    });
  }

  next<T = StageServerMessage | StudioServerMessage>(match: (m: any) => boolean, timeoutMs = 5_000): Promise<T> {
    const existing = this.messages.find(match);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for a message; got ${JSON.stringify(this.messages.map((m) => m.t))}`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          this.messages.splice(this.messages.indexOf(m), 1);
          resolve(m);
        },
      });
    });
  }

  send(data: unknown): void {
    this.ws.send(typeof data === "string" ? data : JSON.stringify(data));
  }

  close(): void {
    this.ws.close();
  }
}

function openSocket(url: string, headers?: Record<string, string>): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
    const socket = new TestSocket(ws);
    ws.addEventListener("open", () => resolve(socket), { once: true });
    ws.addEventListener("error", () => reject(new Error(`could not open ${url}`)), { once: true });
  });
}

export function stageKeyFrom(stageUrl: string): string {
  return stageUrl.split("/s/")[1] as string;
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` passes or the timeout expires. */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(25);
  }
  throw new Error("condition never became true");
}
