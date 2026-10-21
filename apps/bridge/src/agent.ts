import {
  bridgeServerMessageSchema,
  parseMessage,
  toBridgeWsUrl,
  type BridgeAction,
  type BridgeActionParams,
  type BridgeClientMessage,
  type LiveStudioProbe,
} from "@tik-live/shared";
import { LocalLiveStudioController, type LocalStudioController } from "./live-studio";

export interface BridgeAgentOptions {
  /** Stage URL (`https://.../s/<stageKey>`) or Bridge WS URL (`ws://.../ws/bridge/<stageKey>`). */
  url: string;
  controller?: LocalStudioController;
  pollMs?: number;
  reconnectMs?: number;
  onLog?: (msg: string) => void;
}

/**
 * Runs on the user's PC, connects outbound to the Lantern server over
 * `/ws/bridge/:stageKey`, reports local TikTok LIVE Studio state, and executes
 * `launch`, `start`, `stop`, `probe`, `highlight`, `recording`, `scene`,
 * `source`, `vibe`, `camera_effect`, and `inject_stage` commands on demand.
 */
export class BridgeAgent {
  private readonly wsUrl: string;
  private readonly stageUrl: string | null;
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

  constructor(options: BridgeAgentOptions) {
    this.wsUrl = toBridgeWsUrl(options.url);
    this.stageUrl = /\/s\/[A-Za-z0-9_-]{16,64}/.test(options.url) ? options.url.trim() : null;
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
    const ws = new WebSocket(this.wsUrl);
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
        this.log(`Conectado ao apresentador "${msg.channelName}". Aguardando comandos...`);
        return;
      }
      if (msg.t === "request") {
        void this.handleRequest(msg.id, msg.action, msg.params);
      }
    });

    ws.addEventListener("close", (event) => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.stopped) return;
      if (event.code === 4001 || event.code === 4004) {
        this.log(`Conexão encerrada pelo servidor (${event.reason || event.code}). Confira se o link do palco mudou.`);
        this.stopped = true;
        return;
      }
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // `close` event handles reconnection.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempts += 1;
    const delay = Math.min(30_000, this.reconnectMs * 1.5 ** Math.min(this.attempts - 1, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
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
