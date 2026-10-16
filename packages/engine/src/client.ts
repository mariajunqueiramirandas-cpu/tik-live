import { parseMessage, PROTOCOL_VERSION, stageServerMessageSchema, type StageRole, type StageServerPayload } from "@tik-live/shared";
import { ENGINE_VERSION, type StageEngine, type Telemetry } from "./engine";

/**
 * The stage's connection to the server (ADR-0008): announces itself, feeds
 * protocol messages to the engine, reports `spoken` and telemetry back, and
 * reconnects with exponential backoff and jitter. While disconnected the
 * engine keeps its idle animation running; nothing broken shows on screen.
 */
export type StageConnectionState =
  /** First connection attempt. */
  | "connecting"
  | "connected"
  /** Lost the connection (or the server is restarting); retrying. */
  | "reconnecting"
  /** The stage link was replaced in the dashboard (close code 4001). */
  | "revoked"
  /** The channel was deleted (close code 4004). */
  | "gone"
  | "closed";

export interface StageConnectionOptions {
  engine: StageEngine;
  /** Full WebSocket URL, e.g. from `stageSocketUrl`. */
  url: string;
  role: StageRole;
  onState?: (state: StageConnectionState) => void;
  /** Injected for tests. */
  WebSocket?: new (url: string) => WebSocket;
  random?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Reloads the page when the server asks (new deploy, protocol change). */
  reload?: () => void;
}

export interface StageConnection {
  readonly state: StageConnectionState;
  close(): void;
}

export const CLOSE_REVOKED = 4001;
export const CLOSE_GONE = 4004;

const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;
const RELOAD_GUARD_KEY = "lantern.stage.reloadedAt";

/** `wss://host/ws/stage/<key>?role=program` from the page's own location. */
export function stageSocketUrl(location: { protocol: string; host: string }, stageKey: string, role: StageRole): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws/stage/${encodeURIComponent(stageKey)}?role=${role}`;
}

/** Backoff for attempt n (0-based): 0.5 s doubling to 10 s, with jitter in [50%, 100%]. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

export function connectStage(options: StageConnectionOptions): StageConnection {
  const { engine, role } = options;
  const Socket = options.WebSocket ?? WebSocket;
  const random = options.random ?? Math.random;
  const schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const reload = options.reload ?? defaultReload;

  let socket: WebSocket | null = null;
  let state: StageConnectionState = "connecting";
  let attempt = 0;
  let timer: unknown = null;
  let holding = false;
  let stopped = false;

  const setState = (next: StageConnectionState) => {
    if (next === state) return;
    state = next;
    options.onState?.(next);
  };

  const send = (payload: Record<string, unknown>) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...payload }));
  };

  const sendTelemetry = (t: Telemetry) => {
    send({
      t: "telemetry",
      fps: Math.max(0, Math.min(1000, t.fps)),
      frameP95: Math.max(0, Math.min(10_000, t.frameP95)),
      quality: t.quality,
      ...(t.renderer ? { renderer: t.renderer.slice(0, 200) } : {}),
      ...(t.error ? { error: t.error.slice(0, 500) } : {}),
    });
  };

  const offSpoken = engine.on("spoken", (id) => send({ t: "spoken", id }));
  const offTelemetry = engine.on("telemetry", sendTelemetry);

  const handle = (raw: unknown) => {
    if (typeof raw !== "string") return;
    // Version check first: a newer server's hello may not match our schema.
    let loose: { t?: unknown; v?: unknown; reload?: unknown } | null;
    try {
      loose = JSON.parse(raw) as { t?: unknown; v?: unknown; reload?: unknown } | null;
    } catch {
      return;
    }
    if (loose?.t === "hello" && (loose.reload === true || (typeof loose.v === "number" && loose.v > PROTOCOL_VERSION))) {
      reload();
      return;
    }
    const message = parseMessage(stageServerMessageSchema, loose);
    if (!message) return;
    if (message.t === "hold") holding = true;
    const { v: _v, ...payload } = message;
    engine.apply(payload as StageServerPayload);
  };

  const open = () => {
    if (stopped) return;
    timer = null;
    holding = false;
    let ws: WebSocket;
    try {
      ws = new Socket(options.url);
    } catch {
      retry();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      setState("connected");
      send({
        t: "ready",
        role,
        engine: ENGINE_VERSION,
        caps: { webgl2: engine.failed !== "webgl2-unavailable", audio: engine.audio.state !== "unavailable" },
      });
      sendTelemetry(engine.telemetry());
    };
    ws.onmessage = (event) => handle(event.data);
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      if (stopped) return;
      if (event.code === CLOSE_REVOKED) return setState("revoked");
      if (event.code === CLOSE_GONE) return setState("gone");
      retry();
    };
    ws.onerror = () => {
      // onclose follows and handles the retry.
    };
  };

  const retry = () => {
    if (stopped) return;
    setState(state === "connecting" && attempt === 0 ? "connecting" : "reconnecting");
    // A server restart (hold) comes back in a second or two: retry promptly.
    const delay = holding ? 800 + random() * 700 : reconnectDelay(attempt, random);
    attempt += 1;
    timer = schedule(open, delay);
  };

  open();

  return {
    get state() {
      return state;
    },
    close() {
      stopped = true;
      if (timer !== null) cancel(timer);
      offSpoken();
      offTelemetry();
      const ws = socket;
      socket = null;
      ws?.close(1000, "stage closed");
      setState("closed");
    },
  };
}

/** Reloads at most once a minute, so a broken deploy can't cause a reload loop in OBS. */
function defaultReload(): void {
  if (typeof location === "undefined") return;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // No storage: reload anyway.
  }
  location.reload();
}
