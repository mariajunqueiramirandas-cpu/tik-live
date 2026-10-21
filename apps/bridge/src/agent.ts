import {
  BRIDGE_CLOSE,
  bridgeDeviceWsUrl,
  bridgeServerMessageSchema,
  parseMessage,
  toBridgeWsUrl,
  type BridgeClientMessage,
  type LiveStudioProbe,
} from "@tik-live/shared";
import { LocalLiveStudioController, type LocalStudioController } from "./live-studio";

const BUSY_RETRY_MS = 30_000;

/** Bun's WebSocket takes request headers; the DOM typings don't know. */
type BunWebSocket = new (url: string, options: { headers: Record<string, string> }) => WebSocket;

/** A paired device (ADR-0047), or the stage link agents used before pairing. */
export type BridgeConnection = { server: string; token: string } | { url: string };

export type BridgeAgentOptions = BridgeConnection & {
  controller?: LocalStudioController;
  pollMs?: number;
  reconnectMs?: number;
  onLog?: (msg: string) => void;
  /** The server closed the connection for good (unpaired, stage link changed, host deleted); the agent has stopped. */
  onEnded?: (code: number, reason: string) => void;
};

/**
 * Runs on the user's PC, connects outbound to the Lantern server over
 * `/ws/bridge` (paired) or `/ws/bridge/:stageKey` (stage link), reports local
 * TikTok LIVE Studio state, and executes `launch`, `start`, `stop`, and
 * `probe` commands on demand.
 */
export class BridgeAgent {
  private readonly wsUrl: string;
  private readonly token: string | null;
  private readonly onEnded: ((code: number, reason: string) => void) | undefined;
  private readonly controller: LocalStudioController;
  private readonly pollMs: number;
  private readonly reconnectMs: number;
  private readonly log: (msg: string) => void;
  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private attempts = 0;
  private lastProbeJson = "";
  /** Another PC holds this host; we retry quietly until it lets go. */
  private waitingTurn = false;

  constructor(options: BridgeAgentOptions) {
    if ("token" in options) {
      this.wsUrl = bridgeDeviceWsUrl(options.server);
      this.token = options.token;
    } else {
      this.wsUrl = toBridgeWsUrl(options.url);
      this.token = null;
    }
    this.onEnded = options.onEnded;
    this.controller = options.controller ?? new LocalLiveStudioController();
    this.pollMs = options.pollMs ?? 3_000;
    this.reconnectMs = options.reconnectMs ?? 2_000;
    this.log = options.onLog ?? ((msg) => console.log(`[lantern-bridge] ${msg}`));
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "agent stopped");
      } catch {
        // Ignore close errors.
      }
      this.ws = null;
    }
  }

  private send(msg: BridgeClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Ignore send errors on closing sockets.
    }
  }

  private async pushStatus(force = false): Promise<LiveStudioProbe> {
    const probe = await this.controller.probe();
    const serialized = JSON.stringify(probe);
    if (force || serialized !== this.lastProbeJson) {
      this.lastProbeJson = serialized;
      this.send({ v: 1, t: "status", probe });
    }
    return probe;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = this.token ? new (WebSocket as unknown as BunWebSocket)(this.wsUrl, { headers: { authorization: `Bearer ${this.token}` } }) : new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.attempts = 0;
      this.lastProbeJson = "";
      void this.pushStatus(true);
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => void this.pushStatus(false), this.pollMs);
      (this.pollTimer as { unref?: () => void }).unref?.();
    });

    ws.addEventListener("message", (event) => {
      const msg = parseMessage(bridgeServerMessageSchema, String(event.data));
      if (!msg) return;
      if (msg.t === "hello") {
        this.waitingTurn = false;
        this.log(`Conectado ao apresentador "${msg.channelName}". Aguardando comandos...`);
        return;
      }
      if (msg.t === "request") {
        void this.handleRequest(msg.id, msg.action);
      }
    });

    ws.addEventListener("close", (event) => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.stopped) return;
      if (event.code === BRIDGE_CLOSE.unpaired || event.code === BRIDGE_CLOSE.stageKeyRotated || event.code === BRIDGE_CLOSE.channelDeleted) {
        this.stopped = true;
        this.ws = null;
        if (this.onEnded) this.onEnded(event.code, event.reason);
        else this.log(`Conexão encerrada pelo servidor (${event.reason || event.code}).`);
        return;
      }
      if (event.code === BRIDGE_CLOSE.busy) {
        if (!this.waitingTurn) this.log("Outro computador pareado já está conectado a este apresentador. Este fica de reserva e tenta de novo a cada 30 s.");
        this.waitingTurn = true;
        this.scheduleReconnect(BUSY_RETRY_MS);
        return;
      }
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // `close` event handles reconnection.
    });
  }

  private scheduleReconnect(fixedDelay?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempts += 1;
    const delay = fixedDelay ?? Math.min(30_000, this.reconnectMs * 1.5 ** Math.min(this.attempts - 1, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // Not unref'd: between attempts this timer is all that keeps the agent's process running.
  }

  private async handleRequest(id: string, action: "probe" | "launch" | "start" | "stop"): Promise<void> {
    try {
      if (action === "probe") {
        const probe = await this.pushStatus(true);
        this.send({ v: 1, t: "response", id, probe });
        return;
      }
      if (action === "launch") {
        this.log("Abrindo TikTok LIVE Studio...");
        const result = await this.controller.launch();
        const probe = await this.pushStatus(true);
        this.send({ v: 1, t: "response", id, result, probe });
        return;
      }
      if (action === "start") {
        this.log("Iniciando transmissão no TikTok LIVE Studio...");
        const result = await this.controller.start();
        const probe = await this.pushStatus(true);
        this.log(result.detail);
        this.send({ v: 1, t: "response", id, result, probe });
        return;
      }
      if (action === "stop") {
        this.log("Encerrando transmissão no TikTok LIVE Studio...");
        const result = await this.controller.stop();
        const probe = await this.pushStatus(true);
        this.log(result.detail);
        this.send({ v: 1, t: "response", id, result, probe });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.send({
        v: 1,
        t: "response",
        id,
        result: { ok: false, detail },
      });
    }
  }
}
