import {
  BRIDGE_CLOSE,
  bridgeClientMessageSchema,
  LIVE_STUDIO_ACTIONS,
  LIVE_STUDIO_PORTS,
  LIVE_STUDIO_SUBPROTOCOL,
  type BridgeAction,
  type BridgeActionParams,
  type BroadcastState,
  type LiveStudioActionRequest,
  type LiveStudioProbe,
  type LiveStudioStreamStatus,
} from "@tik-live/shared";
import { AUTH_REQUIRED_DETAIL, LIVE_STUDIO_START_DEADLINE_MS, type CameraEffectParams, type LiveStudioResult } from "@tik-live/shared/live-studio";
import crypto from "node:crypto";
import type { Logger } from "../log";
import type { ChannelRow } from "../repos/channels";
import type { Peer } from "../runtime/peer";

/** The server's own client, for when the server runs on the PC that has Studio (development). */
export { LocalLiveStudioController as LocalLiveStudioClient } from "@tik-live/shared/live-studio";

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
  probe?: LiveStudioProbe | null;
}

export interface LiveStudioClient {
  probe(): Promise<LiveStudioProbe>;
  start(): Promise<LiveStudioResult>;
  stop(): Promise<LiveStudioResult>;
  launch?(): Promise<LiveStudioResult>;
  highlight?(): Promise<LiveStudioResult>;
  toggleRecording?(): Promise<LiveStudioResult>;
  switchScene?(scene: string): Promise<LiveStudioResult>;
  toggleSource?(sourceId: string, scene?: string): Promise<LiveStudioResult>;
  triggerVibe?(vibeId: string): Promise<LiveStudioResult>;
  setCameraEffect?(params: CameraEffectParams): Promise<LiveStudioResult>;
  injectStage?(stageUrl: string): Promise<LiveStudioResult>;
}

/**
 * A remote Bridge Agent running on the user's Windows PC, connected over
 * `/ws/bridge` with a paired device token (ADR-0047) or, for older agents,
 * `/ws/bridge/:stageKey`. Forwards `probe`, `launch`, `start`, `stop`,
 * `highlight`, `recording`, `scene`, `source`, `vibe`, `camera_effect`, and
 * `inject_stage` commands to the user's PC.
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

  private request(
    action: BridgeAction,
    timeoutMs: number,
    params?: BridgeActionParams,
  ): Promise<{ probe?: LiveStudioProbe; result?: { ok: boolean; detail: string } }> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("O agente local no seu computador não respondeu a tempo."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.peer.send(JSON.stringify({ v: 1, t: "request", id, action, ...(params ? { params } : {}) }));
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
    const res = await this.request("launch", 70_000);
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao abrir o TikTok LIVE Studio." };
  }

  async start(): Promise<{ ok: boolean; detail: string }> {
    // A little longer than the agent's own deadline, so its answer, not our timeout, decides.
    const res = await this.request("start", LIVE_STUDIO_START_DEADLINE_MS + 15_000);
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao iniciar a live." };
  }

  async stop(): Promise<{ ok: boolean; detail: string }> {
    const res = await this.request("stop", 45_000);
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao encerrar a live." };
  }

  async highlight(): Promise<{ ok: boolean; detail: string }> {
    const res = await this.request("highlight", 12_000);
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao salvar o clipe." };
  }

  async toggleRecording(): Promise<{ ok: boolean; detail: string }> {
    const res = await this.request("recording", 12_000);
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao alternar a gravação." };
  }

  async switchScene(scene: string): Promise<{ ok: boolean; detail: string }> {
    const res = await this.request("scene", 10_000, { scene });
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao trocar de cena." };
  }

  async toggleSource(sourceId: string, scene?: string): Promise<{ ok: boolean; detail: string }> {
    const res = await this.request("source", 10_000, { sourceId, ...(scene ? { scene } : {}) });
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao alternar a fonte." };
  }

  async triggerVibe(vibeId: string): Promise<{ ok: boolean; detail: string }> {
    const res = await this.request("vibe", 10_000, { vibeId });
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao acionar a Vibe." };
  }

  async setCameraEffect(params: CameraEffectParams): Promise<{ ok: boolean; detail: string }> {
    const res = await this.request("camera_effect", 10_000, params);
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao aplicar efeito de câmera." };
  }

  async injectStage(stageUrl: string): Promise<{ ok: boolean; detail: string }> {
    const res = await this.request("inject_stage", 15_000, { stageUrl });
    return res.result ?? { ok: false, detail: "Sem resposta do agente local ao configurar a cena." };
  }
}

const AUTO_HIGHLIGHT_COOLDOWN_MS = 60_000;
/** After a failed automatic highlight, try again this soon instead of waiting the whole minute. */
const AUTO_HIGHLIGHT_RETRY_MS = 15_000;
const AUTO_VIBE_COOLDOWN_MS = 20_000;
/** How often to retry ending a live the agent hasn't confirmed ending. */
const OWED_STOP_RETRY_MS = 30_000;
const DROPPED_LOG_EVERY_MS = 60_000;

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
  private readonly lastProbes = new Map<string, LiveStudioProbe>();
  private readonly inflight = new Set<string>();
  private readonly bridges = new Map<string, RemoteBridgeSession>();
  private readonly lastAutoHighlightAt = new Map<string, number>();
  private readonly lastAutoVibeAt = new Map<string, number>();
  /** Channels whose PC live we were told to end without the agent confirming it, with the last try. */
  private readonly owedStops = new Map<string, number>();
  private readonly lastDroppedLogAt = new Map<string, number>();
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

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
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

  latestProbe(channelId: string): LiveStudioProbe | null {
    return this.bridges.get(channelId)?.lastProbe ?? this.lastProbes.get(channelId) ?? null;
  }

  /** The paired device whose agent is connected for this channel, if any. */
  connectedDevice(channelId: string): string | null {
    return this.bridges.get(channelId)?.deviceId ?? null;
  }

  /**
   * One agent per channel. The same PC reconnecting replaces its old socket,
   * and a paired PC replaces a stage-link agent. While a paired PC is
   * connected, anything else is turned away: another PC, so two PCs left open
   * don't keep kicking each other off, and a stage-link agent, because the
   * stage link sits in OBS and must not be enough to take over the live.
   */
  attachBridge(channel: ChannelRow, peer: Peer, deviceId: string | null = null): boolean {
    const existing = this.bridges.get(channel.id);
    if (existing && existing.deviceId !== null && existing.deviceId !== deviceId) return false;
    if (existing && existing.peer.id !== peer.id) {
      existing.close(BRIDGE_CLOSE.replaced, "replaced by new bridge connection");
    }
    const session = new RemoteBridgeSession(peer, deviceId);
    this.bridges.set(channel.id, session);
    try {
      peer.send(JSON.stringify({ v: 1, t: "hello", channelId: channel.id, channelName: channel.name }));
    } catch {
      // Ignore send errors on races.
    }
    // The agent is back: an owed stop goes out with its first status, not 30 s later.
    if (this.owedStops.has(channel.id)) this.owedStops.set(channel.id, -Infinity);
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

  /** Logs, at most once a minute per channel, an agent message we had to throw away. */
  noteDroppedMessage(channelId: string, reason: string): void {
    const now = this.nowMs();
    if (now - (this.lastDroppedLogAt.get(channelId) ?? -Infinity) < DROPPED_LOG_EVERY_MS) return;
    this.lastDroppedLogAt.set(channelId, now);
    this.options.log.warn("dropped a message from the Local Bridge Agent", { channelId, reason });
  }

  handleBridgeMessage(channelId: string, peerId: string, raw: string): void {
    const session = this.bridges.get(channelId);
    if (!session || session.peer.id !== peerId) return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      this.noteDroppedMessage(channelId, "not JSON");
      return;
    }
    const parsed = bridgeClientMessageSchema.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.noteDroppedMessage(channelId, issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid");
      return;
    }
    const message = parsed.data;
    if (message.t === "response") {
      if (message.probe) this.lastProbes.set(channelId, message.probe);
      session.handleResponse(message.id, {
        ...(message.probe ? { probe: message.probe } : {}),
        ...(message.result ? { result: message.result } : {}),
      });
      return;
    }
    if (message.t === "status") {
      session.lastProbe = message.probe;
      this.lastProbes.set(channelId, message.probe);
      this.settleOwedStop(channelId, message.probe);
      this.applyProbeToChannel(channelId, message.probe);
    }
  }

  /** The agent reported Studio's state: clear an owed stop it shows done, or try it again. */
  private settleOwedStop(channelId: string, probe: LiveStudioProbe): void {
    const lastTry = this.owedStops.get(channelId);
    if (lastTry === undefined || this.wanted.has(channelId)) return;
    const ended = probe.connected ? probe.streamStatus === "stopped" : probe.running === false;
    if (ended) {
      this.owedStops.delete(channelId);
      return;
    }
    if (probe.connected && this.nowMs() - lastTry >= OWED_STOP_RETRY_MS) void this.deliverStop(channelId);
  }

  private applyProbeToChannel(channelId: string, probe: LiveStudioProbe): void {
    this.lastProbes.set(channelId, probe);
    if (!this.wanted.has(channelId) || this.inflight.has(channelId)) return;
    const bridgeConnected = this.bridges.has(channelId);
    if (probe.connected && probe.streamStatus === "live") {
      this.statuses.set(channelId, {
        channelId,
        state: "live",
        detail: "Transmitindo pelo TikTok LIVE Studio",
        since: this.statuses.get(channelId)?.since ?? this.nowIso(),
        bridgeConnected,
        probe,
      });
    } else if (probe.connected && probe.streamStatus === "paused") {
      this.statuses.set(channelId, {
        channelId,
        state: "retrying",
        detail: "Live pausada no TikTok LIVE Studio",
        since: this.statuses.get(channelId)?.since ?? this.nowIso(),
        bridgeConnected,
        probe,
      });
    } else {
      void this.ensure(channelId);
    }
  }

  /**
   * Follows the show: wants the PC live while the host is on air. Going live
   * can take two minutes, so it runs in the background rather than holding up
   * whoever turned the host on; its progress shows in `current()`.
   */
  async sync(channel: ChannelRow, shouldBroadcast: boolean): Promise<void> {
    const wants = shouldBroadcast && Boolean(channel.broadcast.liveStudio);
    if (!wants) {
      if (this.wanted.has(channel.id)) await this.stop(channel.id);
      return;
    }
    this.owedStops.delete(channel.id);
    const alreadyWanted = this.wanted.has(channel.id);
    this.wanted.set(channel.id, channel);
    const current = this.statuses.get(channel.id);
    if (alreadyWanted && (current?.state === "live" || current?.state === "starting")) return;
    void this.ensure(channel.id);
  }

  async stop(channelId: string): Promise<void> {
    const wasWanted = this.wanted.delete(channelId);
    this.statuses.delete(channelId);
    if (!wasWanted) return;
    await this.deliverStop(channelId);
  }

  /**
   * Ends the live on the PC. Until the agent confirms it, the stop stays owed
   * and is tried again when the agent reports Studio still live, including
   * after it reconnects.
   */
  private async deliverStop(channelId: string): Promise<boolean> {
    this.owedStops.set(channelId, this.nowMs());
    let client: LiveStudioClient | null = this.bridges.get(channelId) ?? null;
    if (!client) {
      // No agent connected: the server's own client only reaches a Studio running on this machine.
      const local = await this.options.client.probe().catch(() => null);
      if (local?.connected) client = this.options.client;
    }
    if (!client) {
      this.options.log.info("TikTok LIVE Studio stop owed until the agent reconnects", { channelId });
      return false;
    }
    try {
      const result = await client.stop();
      if (result.ok) {
        this.owedStops.delete(channelId);
        return true;
      }
      this.options.log.warn("could not stop TikTok LIVE Studio stream", { channelId, detail: result.detail });
    } catch (err) {
      this.options.log.warn("could not stop TikTok LIVE Studio stream", { channelId, error: String(err) });
    }
    return false;
  }

  /** A stop is still owed to this channel's PC. */
  isStopOwed(channelId: string): boolean {
    return this.owedStops.has(channelId);
  }

  current(channelId: string): LiveStudioStatus | null {
    const probe = this.latestProbe(channelId);
    if (!this.wanted.has(channelId)) return null;
    const status = this.statuses.get(channelId);
    if (!status) return null;
    return { ...status, bridgeConnected: this.bridges.has(channelId), probe };
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
    probe: LiveStudioProbe;
  }> {
    const client = this.clientFor(options.channelId);
    const bridgeConnected = options.channelId ? this.bridges.has(options.channelId) : false;

    if (options.launch && client.launch) {
      const launched = await client.launch();
      if (!launched.ok) {
        const probe = await client.probe();
        if (options.channelId) this.lastProbes.set(options.channelId, probe);
        return {
          ok: false,
          detail: launched.detail,
          connected: probe.connected,
          installed: probe.installed,
          streamStatus: probe.streamStatus,
          bridgeConnected,
          probe,
        };
      }
    }
    const probe = await client.probe();
    if (options.channelId) this.lastProbes.set(options.channelId, probe);
    if (probe.authRequired) {
      return { ok: false, detail: AUTH_REQUIRED_DETAIL, connected: false, installed: probe.installed, streamStatus: null, bridgeConnected, probe };
    }
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
        probe,
      };
    }
    if (probe.running) {
      return {
        ok: true,
        detail: "O TikTok LIVE Studio está aberto, mas ainda não respondeu: espere carregar e deixe-o na tela principal.",
        connected: false,
        installed: probe.installed,
        streamStatus: null,
        bridgeConnected,
        probe,
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
        probe,
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
      probe,
    };
  }

  async executeAction(
    channelId: string,
    req: Exclude<LiveStudioActionRequest, { action: "sync_handle" }>,
    stageUrl?: string,
  ): Promise<{ ok: boolean; detail: string; probe: LiveStudioProbe }> {
    const client = this.clientFor(channelId);
    let result: { ok: boolean; detail: string };

    switch (req.action) {
      case "highlight":
        result = client.highlight
          ? await client.highlight()
          : { ok: false, detail: "Ação de destaque não disponível neste cliente." };
        break;
      case "recording":
        result = client.toggleRecording
          ? await client.toggleRecording()
          : { ok: false, detail: "Controle de gravação não disponível neste cliente." };
        break;
      case "scene":
        result = client.switchScene
          ? await client.switchScene(req.scene)
          : { ok: false, detail: "Troca de cena não disponível neste cliente." };
        break;
      case "source":
        result = client.toggleSource
          ? await client.toggleSource(req.sourceId, req.scene)
          : { ok: false, detail: "Controle de fonte não disponível neste cliente." };
        break;
      case "vibe":
        result = client.triggerVibe
          ? await client.triggerVibe(req.vibeId)
          : { ok: false, detail: "Vibes não disponíveis neste cliente." };
        break;
      case "camera_effect":
        result = client.setCameraEffect
          ? await client.setCameraEffect({
              ...(req.cameraSource ? { cameraSource: req.cameraSource } : {}),
              cameraEffectType: req.cameraEffectType,
              cameraEffectId: req.cameraEffectId,
            })
          : { ok: false, detail: "Efeitos de câmera não disponíveis neste cliente." };
        break;
      case "inject_stage":
        if (!stageUrl) {
          result = { ok: false, detail: "Link do palco não disponível." };
          break;
        }
        result = client.injectStage
          ? await client.injectStage(stageUrl)
          : { ok: false, detail: "Configuração automática de cena não disponível neste cliente." };
        break;
    }

    const probe = await client.probe();
    this.lastProbes.set(channelId, probe);
    return { ok: result.ok, detail: result.detail, probe };
  }

  /**
   * Automatically triggers a 60-second highlight clip in TikTok LIVE Studio
   * when a peak moment happens (big gift, minigame win, or spicy roast),
   * rate-limited to once per minute per channel.
   */
  async autoHighlight(channelId: string, reason: string): Promise<boolean> {
    if (!this.wanted.has(channelId) && !this.bridges.has(channelId)) return false;
    const now = this.nowMs();
    const last = this.lastAutoHighlightAt.get(channelId) ?? -Infinity;
    if (now - last < AUTO_HIGHLIGHT_COOLDOWN_MS) return false;
    const client = this.clientFor(channelId);
    if (!client.highlight) return false;
    // Studio only saves clips while it allows them (live on air); don't spend the minute on a sure "no".
    if (this.latestProbe(channelId)?.highlightAble === false) return false;

    this.lastAutoHighlightAt.set(channelId, now);
    let ok = false;
    try {
      ok = (await client.highlight()).ok;
    } catch {
      ok = false;
    }
    if (ok) this.options.log.info("saved TikTok LIVE Studio highlight clip", { channelId, reason });
    // A failed try may come back sooner than the full cooldown.
    else this.lastAutoHighlightAt.set(channelId, now - AUTO_HIGHLIGHT_COOLDOWN_MS + AUTO_HIGHLIGHT_RETRY_MS);
    return ok;
  }

  /**
   * Automatically fires a matching visual Vibe macro in TikTok LIVE Studio
   * (`"Vitória!"` on wins, `"Essa doeu!"` on roasts, `"Como assim?"` on surprises),
   * rate-limited to once every 20 seconds per channel.
   */
  async autoVibe(channelId: string, kind: "victory" | "roast" | "surprise"): Promise<boolean> {
    if (!this.wanted.has(channelId) && !this.bridges.has(channelId)) return false;
    const now = this.nowMs();
    const last = this.lastAutoVibeAt.get(channelId) ?? -Infinity;
    if (now - last < AUTO_VIBE_COOLDOWN_MS) return false;
    const client = this.clientFor(channelId);
    if (!client.triggerVibe) return false;

    const probe = this.latestProbe(channelId) ?? (await client.probe().catch(() => null));
    const vibes = probe?.vibeList ?? [];
    let targetId: string | null = null;
    if (vibes.length > 0) {
      const patterns =
        kind === "victory"
          ? ["vitória", "vitoria", "victory", "win"]
          : kind === "roast"
            ? ["doeu", "ouch", "roast"]
            : ["como assim", "what", "surprise"];
      const matched = vibes.find((v) => patterns.some((p) => v.name.toLowerCase().includes(p)));
      if (matched) targetId = matched.id;
    } else {
      targetId = kind === "victory" ? "Vitória!" : kind === "roast" ? "Essa doeu!" : "Como assim?";
    }
    if (!targetId) return false;

    this.lastAutoVibeAt.set(channelId, now);
    try {
      const res = await client.triggerVibe(targetId);
      if (res.ok) {
        this.options.log.info("triggered TikTok LIVE Studio vibe", { channelId, kind, vibeId: targetId });
      }
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * The stage key changed: point Studio's stage source at the new link, if
   * this channel's PC has one pointing elsewhere. Best effort.
   */
  async refreshStageSource(channelId: string, stageUrl: string): Promise<void> {
    const bridge = this.bridges.get(channelId);
    const sourceUrl = this.latestProbe(channelId)?.stageSourceUrl;
    if (!bridge || !sourceUrl || sourceUrl === stageUrl) return;
    const result = await bridge.injectStage(stageUrl).catch((err: unknown) => ({ ok: false, detail: String(err) }));
    if (!result.ok) this.options.log.warn("could not update the stage source in TikTok LIVE Studio", { channelId, detail: result.detail });
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
      probe: this.latestProbe(channelId),
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
        probe: this.latestProbe(channelId),
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
          probe: this.latestProbe(channelId),
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
