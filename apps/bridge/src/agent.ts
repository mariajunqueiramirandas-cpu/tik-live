import {
  BRIDGE_CLOSE,
  bridgeDeviceWsUrl,
  bridgeServerMessageSchema,
  parseMessage,
  toBridgeWsUrl,
  type BridgeAction,
  type BridgeActionParams,
  type BridgeClientMessage,
  type LiveStudioProbe,
} from "@tik-live/shared";
import { LocalLiveStudioController, type LocalStudioController } from "@tik-live/shared/live-studio";

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
  /** The server closed the connection for good (unpaired, stage link changed, host deleted, replaced); the agent has stopped. */
  onEnded?: (code: number, reason: string) => void;
};

/**
 * Runs on the user's PC, connects outbound to the Lantern server over
 * `/ws/bridge` (paired) or `/ws/bridge/:stageKey` (stage link), reports local
 * TikTok LIVE Studio state, and executes `launch`, `start`, `stop`, `probe`,
 * `highlight`, `recording`, `scene`, `source`, `vibe`, `camera_effect`, and
 * `inject_stage` commands on demand.
 */
export class BridgeAgent {
  private readonly wsUrl: string;
  private readonly token: string | null;
  private readonly stageUrl: string | null;
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
  /** A status probe is running; the poll skips a beat instead of piling up. */
  private probing: Promise<LiveStudioProbe> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeChange: (() => void) | null = null;

  constructor(options: BridgeAgentOptions) {
    if ("token" in options) {
      this.wsUrl = bridgeDeviceWsUrl(options.server);
      this.token = options.token;
      this.stageUrl = null;
    } else {
      this.wsUrl = toBridgeWsUrl(options.url);
      this.token = null;
      this.stageUrl = /\/s\/[A-Za-z0-9_-]{16,64}/.test(options.url) ? options.url.trim() : null;
    }
    this.onEnded = options.onEnded;
    this.controller = options.controller ?? new LocalLiveStudioController();
    this.pollMs = options.pollMs ?? 3_000;
    this.reconnectMs = options.reconnectMs ?? 2_000;
    this.log = options.onLog ?? ((msg) => console.log(`[lantern-bridge] ${msg}`));
  }

  start(): void {
    this.stopped = false;
    // Studio pushes every change: report it right away instead of waiting for the next poll.
    this.unsubscribeChange ??= this.controller.onChange?.(() => {
      if (this.changeTimer) return;
      this.changeTimer = setTimeout(() => {
        this.changeTimer = null;
        void this.pushStatus(false);
      }, 200);
    }) ?? null;
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
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    this.unsubscribeChange?.();
    this.unsubscribeChange = null;
    this.controller.close?.();
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
    if (this.probing && !force) return this.probing;
    const probing = this.controller.probe().finally(() => {
      if (this.probing === probing) this.probing = null;
    });
    this.probing = probing;
    const probe = await probing;
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
      if (ws !== this.ws) return;
      this.attempts = 0;
      this.lastProbeJson = "";
      void this.pushStatus(true);
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => void this.pushStatus(false), this.pollMs);
      (this.pollTimer as { unref?: () => void }).unref?.();
    });

    ws.addEventListener("message", (event) => {
      if (ws !== this.ws) return;
      const msg = parseMessage(bridgeServerMessageSchema, String(event.data));
      if (!msg) return;
      if (msg.t === "hello") {
        this.waitingTurn = false;
        this.log(`Conectado ao apresentador "${msg.channelName}". Aguardando comandos...`);
        return;
      }
      if (msg.t === "request") {
        void this.handleRequest(msg.id, msg.action, msg.params);
      }
    });

    ws.addEventListener("close", (event) => {
      // A socket we already replaced: the server closing it (4000) is about that old connection, not this agent.
      if (ws !== this.ws) return;
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.stopped) return;
      if (
        event.code === BRIDGE_CLOSE.unpaired ||
        event.code === BRIDGE_CLOSE.stageKeyRotated ||
        event.code === BRIDGE_CLOSE.channelDeleted ||
        event.code === BRIDGE_CLOSE.replaced
      ) {
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

  private async handleRequest(id: string, action: BridgeAction, params?: BridgeActionParams): Promise<void> {
    try {
      if (action === "probe") {
        const probe = await this.pushStatus(true);
        this.send({ v: 1, t: "response", id, probe });
        return;
      }
      let result: { ok: boolean; detail: string };
      switch (action) {
        case "launch":
          this.log("Abrindo TikTok LIVE Studio...");
          result = await this.controller.launch();
          break;
        case "start":
          this.log("Iniciando transmissão no TikTok LIVE Studio...");
          result = await this.controller.start();
          this.log(result.detail);
          break;
        case "stop":
          this.log("Encerrando transmissão no TikTok LIVE Studio...");
          result = await this.controller.stop();
          this.log(result.detail);
          break;
        case "highlight":
          this.log("Salvando clipe de destaque (60s) no TikTok LIVE Studio...");
          result = this.controller.highlight
            ? await this.controller.highlight()
            : { ok: false, detail: "Ação de destaque não suportada nesta versão do agente." };
          this.log(result.detail);
          break;
        case "recording":
          this.log("Alternando gravação local em MP4 no TikTok LIVE Studio...");
          result = this.controller.toggleRecording
            ? await this.controller.toggleRecording()
            : { ok: false, detail: "Gravação não suportada nesta versão do agente." };
          this.log(result.detail);
          break;
        case "scene":
          if (!params?.scene) {
            result = { ok: false, detail: "Nome da cena não informado." };
            break;
          }
          this.log(`Mudando para a cena "${params.scene}"...`);
          result = this.controller.switchScene
            ? await this.controller.switchScene(params.scene)
            : { ok: false, detail: "Troca de cena não suportada nesta versão do agente." };
          this.log(result.detail);
          break;
        case "source":
          if (!params?.sourceId) {
            result = { ok: false, detail: "Fonte não informada." };
            break;
          }
          this.log(`Alternando visibilidade da fonte "${params.sourceId}"...`);
          result = this.controller.toggleSource
            ? await this.controller.toggleSource(params.sourceId, params.scene)
            : { ok: false, detail: "Controle de fonte não suportado nesta versão do agente." };
          this.log(result.detail);
          break;
        case "vibe":
          if (!params?.vibeId) {
            result = { ok: false, detail: "Vibe não informada." };
            break;
          }
          this.log(`Acionando Vibe "${params.vibeId}"...`);
          result = this.controller.triggerVibe
            ? await this.controller.triggerVibe(params.vibeId)
            : { ok: false, detail: "Vibes não suportadas nesta versão do agente." };
          this.log(result.detail);
          break;
        case "camera_effect":
          if (!params?.cameraEffectType || !params?.cameraEffectId) {
            result = { ok: false, detail: "Efeito de câmera não informado." };
            break;
          }
          this.log(`Aplicando efeito de câmera "${params.cameraEffectId}"...`);
          result = this.controller.setCameraEffect
            ? await this.controller.setCameraEffect({
                ...(params.cameraSource ? { cameraSource: params.cameraSource } : {}),
                cameraEffectType: params.cameraEffectType,
                cameraEffectId: params.cameraEffectId,
              })
            : { ok: false, detail: "Efeitos de câmera não suportados nesta versão do agente." };
          this.log(result.detail);
          break;
        case "inject_stage": {
          const stageUrl = params?.stageUrl ?? this.stageUrl;
          if (!stageUrl) {
            result = { ok: false, detail: "Link do palco não informado." };
            break;
          }
          this.log("Configurando fonte de Navegador (Vincular) no TikTok LIVE Studio...");
          result = this.controller.injectStage
            ? await this.controller.injectStage(stageUrl)
            : { ok: false, detail: "Injeção de cena não suportada nesta versão do agente." };
          this.log(result.detail);
          break;
        }
        default:
          result = { ok: false, detail: "Esta versão do agente não conhece esse comando. Baixe o agente de novo no painel." };
      }
      const probe = await this.pushStatus(true);
      this.send({ v: 1, t: "response", id, result, probe });
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
