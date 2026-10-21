import {
  bridgeClientMessageSchema,
  LIVE_STUDIO_ACTIONS,
  LIVE_STUDIO_PORTS,
  LIVE_STUDIO_SUBPROTOCOL,
  parseMessage,
  type BridgeAction,
  type BroadcastState,
  type LiveStudioProbe,
  type LiveStudioStreamStatus,
} from "@tik-live/shared";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Logger } from "../log";
import type { ChannelRow } from "../repos/channels";
import type { Peer } from "../runtime/peer";

export {
  LIVE_STUDIO_ACTIONS,
  LIVE_STUDIO_PORTS,
  LIVE_STUDIO_SUBPROTOCOL,
  type LiveStudioProbe,
  type LiveStudioStreamStatus,
};

export interface LiveStudioStatus {
  channelId: string;
  state: BroadcastState;
  detail: string;
  since: string;
  bridgeConnected: boolean;
}

export interface LiveStudioClient {
  probe(): Promise<LiveStudioProbe>;
  start(): Promise<{ ok: boolean; detail: string }>;
  stop(): Promise<{ ok: boolean; detail: string }>;
  launch?(): Promise<{ ok: boolean; detail: string }>;
}

interface SyncSettingsPayload {
  stream_status?: number;
  scene?: string;
}

function toStreamStatus(code: number | undefined): LiveStudioStreamStatus | null {
  if (code === 2) return "live";
  if (code === 1) return "paused";
  if (code === 0) return "stopped";
  return null;
}

/**
 * Resolves the TikTok LIVE Studio executable on Windows, checking
 * `TIKTOK_LIVE_STUDIO_PATH` first, then `launcher_config.json` and version
 * directories under `Program Files` and `LOCALAPPDATA`.
 */
export function findLiveStudioExecutable(customPath?: string): string | null {
  if (customPath && existsSync(customPath)) return customPath;
  const roots = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "TikTok LIVE Studio") : "C:\\Program Files\\TikTok LIVE Studio",
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Programs", "TikTok LIVE Studio")] : []),
  ];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const launcherConfig = path.join(root, "launcher_config.json");
    if (existsSync(launcherConfig)) {
      try {
        const parsed = JSON.parse(readFileSync(launcherConfig, "utf8")) as { cur_path?: string };
        if (parsed.cur_path) {
          const versionedExe = path.join(root, parsed.cur_path, "TikTok LIVE Studio.exe");
          if (existsSync(versionedExe)) return versionedExe;
        }
      } catch {
        // Fall through to directory scan.
      }
    }
    try {
      const entries = readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name, "TikTok LIVE Studio.exe");
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Ignore unreadable directories.
    }
    const launcherExe = path.join(root, "TikTok LIVE Studio Launcher.exe");
    if (existsSync(launcherExe)) return launcherExe;
    const directExe = path.join(root, "TikTok LIVE Studio.exe");
    if (existsSync(directExe)) return directExe;
  }
  return null;
}

function isTcpPortOpen(host: string, port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

/**
 * Talks to the local TikTok LIVE Studio desktop app over its built-in
 * Socket.IO server (`127.0.0.1:28189` / `LIVE_STUDIO_PORTS`).
 */
export class LocalLiveStudioClient implements LiveStudioClient {
  private readonly ports: readonly number[];
  private readonly host: string;
  private readonly executablePath: string | null;

  constructor(
    options: {
      host?: string;
      ports?: readonly number[];
      executablePath?: string | null;
    } = {},
  ) {
    this.host = options.host ?? "127.0.0.1";
    this.ports = options.ports ?? LIVE_STUDIO_PORTS;
    this.executablePath = options.executablePath !== undefined ? options.executablePath : findLiveStudioExecutable(process.env.TIKTOK_LIVE_STUDIO_PATH);
  }

  private async findOpenPort(): Promise<number | null> {
    for (const port of this.ports) {
      if (await isTcpPortOpen(this.host, port)) return port;
    }
    return null;
  }

  async probe(): Promise<LiveStudioProbe> {
    const installed = Boolean(this.executablePath);
    const port = await this.findOpenPort();
    if (!port) {
      return {
        connected: false,
        port: null,
        streamStatus: null,
        scene: null,
        installed,
        executablePath: this.executablePath,
      };
    }

    try {
      const settings = await this.readSettings(port, 3_000);
      return {
        connected: true,
        port,
        streamStatus: toStreamStatus(settings.stream_status),
        scene: settings.scene ?? null,
        installed,
        executablePath: this.executablePath,
      };
    } catch {
      return {
        connected: false,
        port,
        streamStatus: null,
        scene: null,
        installed,
        executablePath: this.executablePath,
      };
    }
  }

  async launch(timeoutMs = 45_000): Promise<{ ok: boolean; detail: string }> {
    const initial = await this.probe();
    if (initial.connected && initial.streamStatus !== null) {
      return { ok: true, detail: "O TikTok LIVE Studio já está aberto e conectado." };
    }
    if (!initial.connected) {
      if (!this.executablePath) {
        return {
          ok: false,
          detail: "O TikTok LIVE Studio não foi encontrado neste computador. Instale ou abra o aplicativo primeiro.",
        };
      }
      try {
        const child = spawn(this.executablePath, [], {
          cwd: path.dirname(this.executablePath),
          detached: true,
          stdio: "ignore",
          windowsHide: false,
          env: { ...process.env, DEVTOOLS_MCP: "1" },
        });
        child.unref();
      } catch (err) {
        return {
          ok: false,
          detail: `Não foi possível abrir o TikTok LIVE Studio: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.probe();
      if (current.connected && current.streamStatus !== null) {
        return { ok: true, detail: "TikTok LIVE Studio aberto e pronto." };
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return {
      ok: false,
      detail: "O TikTok LIVE Studio abriu, mas ainda não terminou de carregar. Confira se você está logado no aplicativo.",
    };
  }

  async start(): Promise<{ ok: boolean; detail: string }> {
    let probe = await this.probe();
    if (!probe.connected || probe.streamStatus === null) {
      const launched = await this.launch();
      if (!launched.ok) return launched;
      probe = await this.probe();
    }
    if (!probe.connected || !probe.port) {
      return { ok: false, detail: "Não foi possível conectar ao TikTok LIVE Studio." };
    }
    if (probe.streamStatus === "live") {
      return { ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" };
    }

    const action = probe.streamStatus === "paused" ? LIVE_STUDIO_ACTIONS.livePauseResume : LIVE_STUDIO_ACTIONS.liveStartEnd;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.emitAction(probe.port, action, "live", 25_000);
      if (result.ok) {
        return { ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" };
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2_000));
        const check = await this.probe();
        if (check.streamStatus === "live") {
          return { ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" };
        }
      }
    }

    return {
      ok: false,
      detail: "O TikTok LIVE Studio não conseguiu iniciar a live. Confira no aplicativo se sua conta está logada e com título e tema preenchidos.",
    };
  }

  async stop(): Promise<{ ok: boolean; detail: string }> {
    const probe = await this.probe();
    if (!probe.connected || !probe.port || probe.streamStatus === "stopped" || probe.streamStatus === null) {
      return { ok: true, detail: "Desligada" };
    }
    const result = await this.emitAction(probe.port, LIVE_STUDIO_ACTIONS.liveStartEnd, "stopped", 15_000);
    if (result.ok) return { ok: true, detail: "Desligada" };
    const after = await this.probe();
    if (!after.connected || after.streamStatus === "stopped") {
      return { ok: true, detail: "Desligada" };
    }
    return { ok: false, detail: "Não foi possível encerrar a live no TikTok LIVE Studio." };
  }

  private readSettings(port: number, timeoutMs: number): Promise<SyncSettingsPayload> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.host}:${port}/socket.io/?EIO=4&transport=websocket`, [LIVE_STUDIO_SUBPROTOCOL]);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // Ignore close errors.
        }
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error("Timed out reading TikTok LIVE Studio settings"))), timeoutMs);

      ws.addEventListener("message", (event) => {
        const data = String(event.data);
        if (data.startsWith("0")) {
          ws.send("40");
          return;
        }
        if (data === "2") {
          ws.send("3");
          return;
        }
        if (data.startsWith("40")) {
          ws.send('42["stream_deck/join_room"]');
          ws.send('42["stream_deck/sync_settings"]');
          return;
        }
        if (data.startsWith("42")) {
          try {
            const [name, rawPayload] = JSON.parse(data.slice(2)) as [string, unknown];
            if (name === "stream_deck/sync_settings" && typeof rawPayload === "string") {
              const parsed = JSON.parse(rawPayload) as SyncSettingsPayload;
              finish(() => resolve(parsed));
            }
          } catch {
            // Ignore malformed messages.
          }
        }
      });

      ws.addEventListener("error", () => finish(() => reject(new Error("Could not connect to TikTok LIVE Studio"))));
      ws.addEventListener("close", () => finish(() => reject(new Error("Connection closed before settings arrived"))));
    });
  }

  private emitAction(
    port: number,
    action: string,
    targetStatus: LiveStudioStreamStatus,
    timeoutMs: number,
  ): Promise<{ ok: boolean; code: number }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://${this.host}:${port}/socket.io/?EIO=4&transport=websocket`, [LIVE_STUDIO_SUBPROTOCOL]);
      const contextId = `lantern_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let settled = false;
      let actionSent = false;

      const finish = (result: { ok: boolean; code: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // Ignore close errors.
        }
        resolve(result);
      };

      const timer = setTimeout(() => finish({ ok: false, code: -1 }), timeoutMs);

      ws.addEventListener("message", (event) => {
        const data = String(event.data);
        if (data.startsWith("0")) {
          ws.send("40");
          return;
        }
        if (data === "2") {
          ws.send("3");
          return;
        }
        if (data.startsWith("40")) {
          ws.send('42["stream_deck/join_room"]');
          ws.send('42["stream_deck/sync_settings"]');
          return;
        }
        if (data.startsWith("42")) {
          try {
            const [name, rawPayload] = JSON.parse(data.slice(2)) as [string, unknown];
            if (name === "stream_deck/sync_settings" && typeof rawPayload === "string") {
              const parsed = JSON.parse(rawPayload) as SyncSettingsPayload;
              const status = toStreamStatus(parsed.stream_status);
              if (status === targetStatus) {
                finish({ ok: true, code: 0 });
                return;
              }
              if (!actionSent && status !== null) {
                actionSent = true;
                const payload = JSON.stringify({ action, context: contextId, payload: {} });
                ws.send(`42${JSON.stringify(["stream_deck/action_emit", payload])}`);
              }
              return;
            }
            if (name === `stream_deck/${contextId}` && typeof rawPayload === "string") {
              const parsed = JSON.parse(rawPayload) as { code?: number };
              const code = typeof parsed.code === "number" ? parsed.code : -1;
              finish({ ok: code === 0, code });
            }
          } catch {
            // Ignore malformed packets.
          }
        }
      });

      ws.addEventListener("error", () => finish({ ok: false, code: -1 }));
      ws.addEventListener("close", () => finish({ ok: false, code: -1 }));
    });
  }
}

/**
 * A remote Bridge Agent running on the user's Windows PC, connected over
 * `/ws/bridge` with a paired device token (ADR-0047) or, for older agents,
 * `/ws/bridge/:stageKey`. Forwards `probe`, `launch`, `start`, and `stop`
 * commands to the user's PC.
 */
class RemoteBridgeSession implements LiveStudioClient {
  lastProbe: LiveStudioProbe | null = null;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: { probe?: LiveStudioProbe; result?: { ok: boolean; detail: string } }) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    readonly peer: Peer,
    /** The paired device, or null for a stage-link agent. */
    readonly deviceId: string | null,
  ) {}

  private request(action: BridgeAction, timeoutMs: number): Promise<{ probe?: LiveStudioProbe; result?: { ok: boolean; detail: string } }> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("O agente local no seu computador não respondeu a tempo."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.peer.send(JSON.stringify({ v: 1, t: "request", id, action }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  handleResponse(id: string, payload: { probe?: LiveStudioProbe; result?: { ok: boolean; detail: string } }): void {
    if (payload.probe) this.lastProbe = payload.probe;
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(payload);
  }

  close(code?: number, reason?: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Agente desconectado."));
    }
    this.pending.clear();
    try {
      this.peer.close(code, reason);
    } catch {
      // Ignore close errors.
    }
  }

  async probe(): Promise<LiveStudioProbe> {
    try {
      const res = await this.request("probe", 8_000);
      if (res.probe) return res.probe;
    } catch {
      if (this.lastProbe) return this.lastProbe;
    }
    return (
      this.lastProbe ?? {
        connected: false,
        port: null,
        streamStatus: null,
        scene: null,
        installed: false,
        executablePath: null,
      }
    );
  }

  async launch(): Promise<{ ok: boolean; detail: string }> {
    const res = await this.request("launch", 55_000);
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao abrir o TikTok LIVE Studio." };
  }

  async start(): Promise<{ ok: boolean; detail: string }> {
    const res = await this.request("start", 60_000);
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao iniciar a live." };
  }

  async stop(): Promise<{ ok: boolean; detail: string }> {
    const res = await this.request("stop", 25_000);
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao encerrar a live." };
  }
}

/**
 * Supervises automatic TikTok LIVE Studio streaming for channels that have
 * `channel.broadcast.liveStudio` enabled: starts the live in TikTok LIVE Studio
 * when the host goes on air, monitors its status, and ends the live when the
 * host stops. Prefers a connected Local Bridge Agent (`lantern-bridge.exe`) for
 * the channel, falling back to the local machine's `LiveStudioClient`.
 */
export class LiveStudioSupervisor {
  private readonly wanted = new Map<string, ChannelRow>();
  private readonly statuses = new Map<string, LiveStudioStatus>();
  private readonly inflight = new Set<string>();
  private readonly bridges = new Map<string, RemoteBridgeSession>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: {
      client: LiveStudioClient;
      log: Logger;
      pollMs?: number;
      now?: () => number;
    },
  ) {
    this.timer = setInterval(() => void this.poll(), options.pollMs ?? 10_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private nowIso(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }

  private clientFor(channelId?: string): LiveStudioClient {
    if (channelId) {
      const bridge = this.bridges.get(channelId);
      if (bridge) return bridge;
    }
    return this.options.client;
  }

  isBridgeConnected(channelId: string): boolean {
    return this.bridges.has(channelId);
  }

  /** The paired device whose agent is connected for this channel, if any. */
  connectedDevice(channelId: string): string | null {
    return this.bridges.get(channelId)?.deviceId ?? null;
  }

  /**
   * One agent per channel. The same PC reconnecting (or a stage-link agent)
   * replaces the old socket; a different paired PC is turned away while one
   * is connected, so two PCs left open don't keep kicking each other off.
   */
  attachBridge(channel: ChannelRow, peer: Peer, deviceId: string | null = null): boolean {
    const existing = this.bridges.get(channel.id);
    if (existing && existing.deviceId !== null && deviceId !== null && existing.deviceId !== deviceId) return false;
    if (existing && existing.peer.id !== peer.id) {
      existing.close(4000, "replaced by new bridge connection");
    }
    const session = new RemoteBridgeSession(peer, deviceId);
    this.bridges.set(channel.id, session);
    try {
      peer.send(JSON.stringify({ v: 1, t: "hello", channelId: channel.id, channelName: channel.name }));
    } catch {
      // Ignore send errors on races.
    }
    const status = this.statuses.get(channel.id);
    if (status) {
      this.statuses.set(channel.id, { ...status, bridgeConnected: true });
    }
    if (this.wanted.has(channel.id) && status?.state !== "live") {
      void this.ensure(channel.id);
    }
    return true;
  }

  detachBridge(channelId: string, peerId: string): void {
    const existing = this.bridges.get(channelId);
    if (!existing || existing.peer.id !== peerId) return;
    existing.close();
    this.bridges.delete(channelId);
    const status = this.statuses.get(channelId);
    if (status) {
      this.statuses.set(channelId, { ...status, bridgeConnected: false });
    }
  }

  closeBridge(channelId: string, code: number, reason: string): void {
    const existing = this.bridges.get(channelId);
    if (!existing) return;
    existing.close(code, reason);
    this.bridges.delete(channelId);
  }

  /** Disconnects a stage-link agent only: paired agents don't use the stage key. */
  closeStageLinkBridge(channelId: string, code: number, reason: string): void {
    if (this.bridges.get(channelId)?.deviceId === null) this.closeBridge(channelId, code, reason);
  }

  closeBridgeDevice(channelId: string, deviceId: string, code: number, reason: string): void {
    if (this.bridges.get(channelId)?.deviceId === deviceId) this.closeBridge(channelId, code, reason);
  }

  handleBridgeMessage(channelId: string, peerId: string, raw: string): void {
    const session = this.bridges.get(channelId);
    if (!session || session.peer.id !== peerId) return;
    const message = parseMessage(bridgeClientMessageSchema, raw);
    if (!message) return;
    if (message.t === "response") {
      session.handleResponse(message.id, {
        ...(message.probe ? { probe: message.probe } : {}),
        ...(message.result ? { result: message.result } : {}),
      });
      return;
    }
    if (message.t === "status") {
      session.lastProbe = message.probe;
      this.applyProbeToChannel(channelId, message.probe);
    }
  }

  private applyProbeToChannel(channelId: string, probe: LiveStudioProbe): void {
    if (!this.wanted.has(channelId) || this.inflight.has(channelId)) return;
    const bridgeConnected = this.bridges.has(channelId);
    if (probe.connected && probe.streamStatus === "live") {
      this.statuses.set(channelId, {
        channelId,
        state: "live",
        detail: "Transmitindo pelo TikTok LIVE Studio",
        since: this.statuses.get(channelId)?.since ?? this.nowIso(),
        bridgeConnected,
      });
    } else if (probe.connected && probe.streamStatus === "paused") {
      this.statuses.set(channelId, {
        channelId,
        state: "retrying",
        detail: "Live pausada no TikTok LIVE Studio",
        since: this.statuses.get(channelId)?.since ?? this.nowIso(),
        bridgeConnected,
      });
    } else {
      void this.ensure(channelId);
    }
  }

  async sync(channel: ChannelRow, shouldBroadcast: boolean): Promise<void> {
    const wants = shouldBroadcast && Boolean(channel.broadcast.liveStudio);
    if (!wants) {
      if (this.wanted.has(channel.id)) await this.stop(channel.id);
      return;
    }
    const alreadyWanted = this.wanted.has(channel.id);
    this.wanted.set(channel.id, channel);
    const current = this.statuses.get(channel.id);
    if (alreadyWanted && (current?.state === "live" || current?.state === "starting")) return;
    await this.ensure(channel.id);
  }

  async stop(channelId: string): Promise<void> {
    const wasWanted = this.wanted.delete(channelId);
    this.statuses.delete(channelId);
    if (!wasWanted) return;
    await this.clientFor(channelId).stop().catch((err: unknown) => {
      this.options.log.warn("could not stop TikTok LIVE Studio stream", { channelId, error: String(err) });
    });
  }

  current(channelId: string): LiveStudioStatus | null {
    if (!this.wanted.has(channelId)) return null;
    const status = this.statuses.get(channelId);
    if (!status) return null;
    return { ...status, bridgeConnected: this.bridges.has(channelId) };
  }

  isLive(channelId: string): boolean {
    return this.current(channelId)?.state === "live";
  }

  close(): void {
    clearInterval(this.timer);
    for (const [, session] of this.bridges) session.close(1001, "server shutting down");
    this.bridges.clear();
  }

  async check(options: { channelId?: string; launch?: boolean } = {}): Promise<{
    ok: boolean;
    detail: string;
    connected: boolean;
    installed: boolean;
    streamStatus: LiveStudioStreamStatus | null;
    bridgeConnected: boolean;
  }> {
    const client = this.clientFor(options.channelId);
    const bridgeConnected = options.channelId ? this.bridges.has(options.channelId) : false;

    if (options.launch && client.launch) {
      const launched = await client.launch();
      if (!launched.ok) {
        const probe = await client.probe();
        return {
          ok: false,
          detail: launched.detail,
          connected: probe.connected,
          installed: probe.installed,
          streamStatus: probe.streamStatus,
          bridgeConnected,
        };
      }
    }
    const probe = await client.probe();
    if (probe.connected) {
      const statusText =
        probe.streamStatus === "live"
          ? "já está ao vivo"
          : probe.streamStatus === "paused"
            ? "está com a live pausada"
            : probe.streamStatus === "stopped"
              ? "está pronto para entrar ao vivo"
              : "está carregando";
      return {
        ok: true,
        detail: bridgeConnected
          ? `Agente conectado ao TikTok LIVE Studio no seu PC (${statusText}).`
          : `Conectado ao TikTok LIVE Studio (${statusText}).`,
        connected: true,
        installed: probe.installed,
        streamStatus: probe.streamStatus,
        bridgeConnected,
      };
    }
    if (probe.installed) {
      return {
        ok: true,
        detail: bridgeConnected
          ? "Agente conectado ao seu PC. O TikTok LIVE Studio está instalado e será aberto automaticamente quando o apresentador entrar ao vivo."
          : "O TikTok LIVE Studio está instalado, mas fechado. Ele será aberto automaticamente quando o apresentador entrar ao vivo.",
        connected: false,
        installed: true,
        streamStatus: null,
        bridgeConnected,
      };
    }
    return {
      ok: false,
      detail: bridgeConnected
        ? "O agente está rodando no seu PC, mas o TikTok LIVE Studio não foi encontrado instalado nele."
        : "Abra o agente local (lantern-bridge.exe) no seu computador com o link do palco, ou instale o TikTok LIVE Studio.",
      connected: false,
      installed: false,
      streamStatus: null,
      bridgeConnected,
    };
  }

  private async ensure(channelId: string): Promise<void> {
    if (!this.wanted.has(channelId) || this.inflight.has(channelId)) return;
    this.inflight.add(channelId);
    this.statuses.set(channelId, {
      channelId,
      state: "starting",
      detail: "Iniciando a live no TikTok LIVE Studio",
      since: this.nowIso(),
      bridgeConnected: this.bridges.has(channelId),
    });
    try {
      const result = await this.clientFor(channelId).start();
      if (!this.wanted.has(channelId)) return;
      this.statuses.set(channelId, {
        channelId,
        state: result.ok ? "live" : "failed",
        detail: result.detail,
        since: this.nowIso(),
        bridgeConnected: this.bridges.has(channelId),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Não foi possível iniciar o TikTok LIVE Studio.";
      this.options.log.warn("TikTok LIVE Studio start failed", { channelId, error: detail });
      if (this.wanted.has(channelId)) {
        this.statuses.set(channelId, {
          channelId,
          state: "failed",
          detail,
          since: this.nowIso(),
          bridgeConnected: this.bridges.has(channelId),
        });
      }
    } finally {
      this.inflight.delete(channelId);
    }
  }

  async poll(): Promise<void> {
    if (this.wanted.size === 0) return;
    for (const id of this.wanted.keys()) {
      if (this.inflight.has(id)) continue;
      let probe: LiveStudioProbe;
      try {
        probe = await this.clientFor(id).probe();
      } catch {
        continue;
      }
      this.applyProbeToChannel(id, probe);
    }
  }
}
