import {
  fitLiveStudioProbe,
  LIVE_STUDIO_ACTIONS,
  LIVE_STUDIO_PORTS,
  type LiveStudioCameraEffects,
  type LiveStudioProbe,
  type LiveStudioSceneItem,
  type LiveStudioStreamStatus,
  type LiveStudioVibeItem,
} from "../broadcast";
import { StudioAuthError, StudioSocket, type StudioSettings } from "./socket";
import { injectStageIntoTikTokStore, readLocalTikTokStore } from "./store";
import { findLiveStudioExecutable, windowsStudioSystem, type StudioSystem } from "./system";

export interface LiveStudioResult {
  ok: boolean;
  detail: string;
}

export interface CameraEffectParams {
  cameraSource?: string;
  /** The category's name (what Studio matches on) or its key. */
  cameraEffectType: string;
  cameraEffectId: string;
}

/** Everything the agent can ask of TikTok LIVE Studio on this PC. */
export interface LocalStudioController {
  probe(): Promise<LiveStudioProbe>;
  launch(): Promise<LiveStudioResult>;
  start(): Promise<LiveStudioResult>;
  stop(): Promise<LiveStudioResult>;
  highlight?(): Promise<LiveStudioResult>;
  toggleRecording?(): Promise<LiveStudioResult>;
  switchScene?(scene: string): Promise<LiveStudioResult>;
  toggleSource?(sourceId: string, scene?: string): Promise<LiveStudioResult>;
  triggerVibe?(vibeId: string): Promise<LiveStudioResult>;
  setCameraEffect?(params: CameraEffectParams): Promise<LiveStudioResult>;
  injectStage?(stageUrl: string): Promise<LiveStudioResult>;
  /** Called when Studio's state changes, so the agent can report it right away. */
  onChange?(listener: () => void): () => void;
  close?(): void;
}

/** How long a start may take in total, launching Studio included. The server waits a little longer. */
export const LIVE_STUDIO_START_DEADLINE_MS = 120_000;

/** How long the controller waits for Studio; tests shorten them. */
export interface LiveStudioTimings {
  /** For Studio to open and answer. */
  launchMs: number;
  /** Re-join this often, so Studio's change pushes resume if another client's disconnect stopped them. */
  rejoinMs: number;
  /** For the first snapshot after joining. */
  firstSnapshotMs: number;
  /** For the live to start after pressing start, before giving up. */
  startWaitMs: number;
  /** For an open Studio that isn't answering yet, before refusing to call a live ended. */
  stopWaitMs: number;
}

const DEFAULT_TIMINGS: LiveStudioTimings = {
  launchMs: 60_000,
  rejoinMs: 20_000,
  firstSnapshotMs: 3_000,
  startWaitMs: 25_000,
  stopWaitMs: 12_000,
};

export const AUTH_REQUIRED_DETAIL =
  "O TikTok LIVE Studio passou a exigir autorização de Stream Deck e recusou o agente. Atualize o agente do Lantern quando houver uma versão nova.";
const NOT_OPEN_DETAIL = "O TikTok LIVE Studio não está aberto.";
const NOT_READY_DETAIL = "O TikTok LIVE Studio está aberto, mas ainda não está pronto (carregando ou fora da tela principal).";

export function toStreamStatus(code: number | undefined): LiveStudioStreamStatus | null {
  if (code === 2) return "live";
  if (code === 1) return "paused";
  if (code === 0) return "stopped";
  return null;
}

function parseSceneList(raw: StudioSettings["scene_list"]): LiveStudioSceneItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item.name === "string" && item.name.trim())
    .map((item) => {
      const visibleIds = new Set((item.visible_sources ?? []).map((s) => (s && typeof s.value === "string" ? s.value : "")).filter(Boolean));
      return {
        name: String(item.name),
        sources: (item.sources ?? [])
          .filter((s) => s && typeof s.value === "string" && s.value.trim())
          .map((s) => ({ id: String(s.value), label: String(s.label ?? s.value), visible: visibleIds.has(String(s.value)) })),
      };
    });
}

function parseVibeList(raw: StudioSettings["vibeList"]): LiveStudioVibeItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v) => v && typeof v.id === "string" && v.id.trim()).map((v) => ({ id: String(v.id), name: String(v.name ?? v.id) }));
}

function parseCameraEffects(raw: StudioSettings["camera_effect"]): LiveStudioCameraEffects | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    sources: (raw.sourceList ?? [])
      .filter((s) => s && typeof s.value === "string" && s.value.trim())
      .map((s) => ({
        id: String(s.value),
        label: String(s.label ?? s.value),
        ...(s.isDefault !== undefined ? { isDefault: Boolean(s.isDefault) } : {}),
        effectId: typeof s.effectId === "string" && s.effectId ? s.effectId : null,
      })),
    types: Array.isArray(raw.typeList) ? raw.typeList.filter((t): t is string => typeof t === "string") : [],
    categories: (raw.effectList ?? [])
      .filter((c) => c && typeof c.key === "string" && c.key.trim())
      .map((c) => ({
        key: String(c.key),
        name: String(c.name ?? c.key),
        effects: (c.effects ?? [])
          .filter((e) => e && typeof e.value === "string" && e.value.trim())
          .map((e) => ({ id: String(e.value), label: String(e.label ?? e.value) })),
      })),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Drives TikTok LIVE Studio on this PC through its Stream Deck server
 * (docs/live-studio/stream-deck-protocol.md), over one long-lived socket.
 * Commands run one at a time, because start and stop press the same toggle;
 * a stop cancels a start that is still waiting.
 */
export class LocalLiveStudioController implements LocalStudioController {
  private readonly host: string;
  private readonly ports: readonly number[];
  private readonly executablePath: string | null;
  private readonly ttStoreDir: string | null | undefined;
  private readonly system: StudioSystem;
  private readonly timings: LiveStudioTimings;
  private socket: StudioSocket | null = null;
  private connecting: Promise<StudioSocket | null> | null = null;
  private authRequired = false;
  private queue: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private startCancel: { cancelled: boolean } | null = null;
  /** A stage link to save into Studio's scenes once Studio is closed. */
  private pendingStageUrl: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    options: {
      host?: string;
      ports?: readonly number[];
      executablePath?: string | null;
      ttStoreDir?: string | null;
      system?: StudioSystem;
      timings?: Partial<LiveStudioTimings>;
    } = {},
  ) {
    this.host = options.host ?? "127.0.0.1";
    this.ports = options.ports ?? LIVE_STUDIO_PORTS;
    this.executablePath = options.executablePath !== undefined ? options.executablePath : findLiveStudioExecutable(process.env.TIKTOK_LIVE_STUDIO_PATH);
    this.ttStoreDir = options.ttStoreDir;
    this.system = options.system ?? windowsStudioSystem;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  // ---- state ----------------------------------------------------------------

  async probe(): Promise<LiveStudioProbe> {
    const socket = await this.ensureSocket();
    if (socket && socket.isReady && !this.busy && Date.now() - socket.joinedAt > this.timings.rejoinMs) {
      await this.exclusive(async () => {
        socket.rejoin();
        await socket.waitUntilReady(this.timings.firstSnapshotMs);
      });
    }
    const running = Boolean(socket) || this.authRequired || (await this.system.isStudioRunning());
    if (!running) this.savePendingStage();
    const store = readLocalTikTokStore(this.ttStoreDir);
    const base: LiveStudioProbe = {
      connected: false,
      port: socket?.port ?? null,
      streamStatus: null,
      scene: null,
      installed: Boolean(this.executablePath),
      executablePath: this.executablePath,
      running,
      ...(this.authRequired ? { authRequired: true } : {}),
      ...(store.tiktokUsername ? { tiktokUsername: store.tiktokUsername } : {}),
      ...(store.stageInjected ? { stageInjected: true } : {}),
      ...(store.stageSourceUrl ? { stageSourceUrl: store.stageSourceUrl } : {}),
      ...(this.pendingStageUrl ? { stagePending: true } : {}),
    };
    const settings = socket?.isReady ? socket.settings : null;
    if (!settings) return fitLiveStudioProbe(base);

    const sceneList = parseSceneList(settings.scene_list);
    const hasStageSource = sceneList.some((scene) => scene.sources.some((source) => source.label === "Vincular"));
    return fitLiveStudioProbe({
      ...base,
      connected: true,
      streamStatus: toStreamStatus(settings.stream_status),
      scene: settings.scene ?? null,
      recording: Boolean(settings.recording),
      highlightAble: Boolean(settings.highlight_able),
      sceneList,
      vibeList: parseVibeList(settings.vibeList),
      playingVibe: settings.playingVibe || null,
      cameraEffects: parseCameraEffects(settings.camera_effect),
      tiktokUsername: store.tiktokUsername,
      stageInjected: store.stageInjected || hasStageSource,
    });
  }

  /** The open, joined socket, connecting if needed; null when Studio isn't there or refuses us. */
  private async ensureSocket(): Promise<StudioSocket | null> {
    if (this.socket?.isOpen) return this.socket;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<StudioSocket | null> {
    this.socket = null;
    // Decided again on every attempt: a refusal from a Studio that has since closed means nothing.
    this.authRequired = false;
    const tried = new Set<number>();
    const attempt = async (port: number): Promise<StudioSocket | null | "refused"> => {
      tried.add(port);
      if (!(await this.system.isPortOpen(this.host, port))) return null;
      const socket = new StudioSocket({
        host: this.host,
        port,
        onSettings: () => this.notify(),
        onClose: () => {
          if (this.socket === socket) this.socket = null;
          this.notify();
        },
      });
      try {
        await socket.connect();
      } catch (err) {
        return err instanceof StudioAuthError ? "refused" : null;
      }
      return socket;
    };

    for (let round = 0; round < 2; round++) {
      // Studio takes the first free port of its list; when all are taken it picks a random one, found by asking Windows.
      const ports = round === 0 ? this.ports : (await this.system.studioPorts()).filter((port) => !tried.has(port));
      for (const port of ports) {
        const result = await attempt(port);
        if (result === "refused") {
          this.authRequired = true;
          return null;
        }
        if (result) {
          this.authRequired = false;
          this.socket = result;
          // The first snapshot after a join, so a probe right after connecting has state.
          await result.waitUntilReady(this.timings.firstSnapshotMs);
          return result;
        }
      }
    }
    return null;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener's problem isn't ours.
      }
    }
  }

  /** Runs commands one at a time. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.busy += 1;
      try {
        return await task();
      } finally {
        this.busy -= 1;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The ready socket for a command, or why there isn't one. */
  private async ready(): Promise<StudioSocket | LiveStudioResult> {
    const socket = await this.ensureSocket();
    if (!socket) {
      if (this.authRequired) return { ok: false, detail: AUTH_REQUIRED_DETAIL };
      return { ok: false, detail: NOT_OPEN_DETAIL };
    }
    if (!(await socket.waitUntilReady(this.timings.firstSnapshotMs))) return { ok: false, detail: NOT_READY_DETAIL };
    return socket;
  }

  // ---- launching, going live, ending ----------------------------------------

  launch(): Promise<LiveStudioResult> {
    return this.exclusive(() => this.launchNow(Date.now() + this.timings.launchMs));
  }

  /** Opens Studio unless it's already running, then waits until it answers. */
  private async launchNow(deadline: number, cancelled?: () => boolean): Promise<LiveStudioResult> {
    let probe = await this.probe();
    if (probe.connected) return { ok: true, detail: "O TikTok LIVE Studio já está aberto e conectado." };
    if (probe.authRequired) return { ok: false, detail: AUTH_REQUIRED_DETAIL };
    if (!probe.running) {
      if (!this.executablePath) {
        return { ok: false, detail: "O TikTok LIVE Studio não foi encontrado neste computador. Instale ou abra o aplicativo primeiro." };
      }
      try {
        this.system.launch(this.executablePath);
      } catch (err) {
        return { ok: false, detail: `Não foi possível abrir o TikTok LIVE Studio: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    while (Date.now() < deadline && !cancelled?.()) {
      await sleep(1_000);
      probe = await this.probe();
      if (probe.connected) return { ok: true, detail: "TikTok LIVE Studio aberto e pronto." };
      if (probe.authRequired) return { ok: false, detail: AUTH_REQUIRED_DETAIL };
    }
    return {
      ok: false,
      detail: "O TikTok LIVE Studio está aberto, mas não ficou pronto. Confira se você está logado e na tela principal do aplicativo.",
    };
  }

  start(): Promise<LiveStudioResult> {
    const cancel = { cancelled: false };
    this.startCancel = cancel;
    const cancelled: LiveStudioResult = { ok: false, detail: "Início cancelado: a live foi encerrada antes de começar." };
    return this.exclusive(async () => {
      if (cancel.cancelled) return cancelled;
      const deadline = Date.now() + LIVE_STUDIO_START_DEADLINE_MS;
      let socket = await this.ready();
      if (!(socket instanceof StudioSocket)) {
        if (this.authRequired) return socket;
        const launched = await this.launchNow(Math.min(deadline, Date.now() + this.timings.launchMs), () => cancel.cancelled);
        if (cancel.cancelled) return cancelled;
        if (!launched.ok) return launched;
        socket = await this.ready();
        if (!(socket instanceof StudioSocket)) return socket;
      }
      if (cancel.cancelled) return cancelled;
      const status = () => toStreamStatus(socket.settings?.stream_status);
      if (status() === "live") return { ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" };
      if (status() === "paused") {
        // Studio answers this one only once the live has resumed.
        const code = await socket.action(LIVE_STUDIO_ACTIONS.livePauseResume, {}, 10_000);
        return code === 0 ? { ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" } : { ok: false, detail: "Não foi possível retomar a live pausada no TikTok LIVE Studio." };
      }

      // Start/end is a toggle: press it again only when Studio rejected the press, never when the live is just slow to start.
      for (let attempt = 0; attempt < 2; attempt++) {
        const code = await socket.action(LIVE_STUDIO_ACTIONS.liveStartEnd, {}, 10_000);
        const reached = await socket.waitFor(
          (settings) => toStreamStatus(settings.stream_status) !== "stopped",
          Math.max(0, Math.min(this.timings.startWaitMs, deadline - Date.now())),
          () => cancel.cancelled,
        );
        if (reached) return { ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" };
        if (cancel.cancelled) return cancelled;
        if (code === 0 || !socket.isOpen || Date.now() >= deadline) break;
        await sleep(2_000);
      }
      return {
        ok: false,
        detail: "O TikTok LIVE Studio não conseguiu iniciar a live. Confira no aplicativo se sua conta está logada e com título e tema preenchidos.",
      };
    });
  }

  stop(): Promise<LiveStudioResult> {
    if (this.startCancel) this.startCancel.cancelled = true;
    return this.exclusive(async () => {
      const probe = await this.probe();
      // Studio closed means no live.
      if (!probe.running) return { ok: true, detail: "Desligada" };
      const socket = await this.ready();
      if (!(socket instanceof StudioSocket)) {
        // Open but not answering: give it a moment rather than claim the live ended.
        const settings = this.socket ? await this.socket.waitFor(() => true, this.timings.stopWaitMs) : null;
        if (!settings || !this.socket) {
          return { ok: false, detail: `Não foi possível encerrar a live. ${this.authRequired ? AUTH_REQUIRED_DETAIL : NOT_READY_DETAIL}` };
        }
      }
      const live = this.socket!;
      if (toStreamStatus(live.settings?.stream_status) === "stopped") return { ok: true, detail: "Desligada" };
      await live.action(LIVE_STUDIO_ACTIONS.liveStartEnd, {}, 10_000);
      const ended = await live.waitFor((settings) => toStreamStatus(settings.stream_status) === "stopped", 15_000);
      return ended ? { ok: true, detail: "Desligada" } : { ok: false, detail: "Não foi possível encerrar a live no TikTok LIVE Studio." };
    });
  }

  // ---- show controls ---------------------------------------------------------

  highlight(): Promise<LiveStudioResult> {
    return this.exclusive(async () => {
      const socket = await this.ready();
      if (!(socket instanceof StudioSocket)) return socket;
      if (socket.settings?.highlight_able === false) {
        return { ok: false, detail: "O clipe de destaque só fica disponível com a live no ar." };
      }
      const code = await socket.action(LIVE_STUDIO_ACTIONS.highlight, {}, 8_000);
      return code === 0
        ? { ok: true, detail: "Clipe de destaque (60s) salvo no TikTok LIVE Studio!" }
        : { ok: false, detail: "Não foi possível salvar o clipe agora. O destaque fica disponível enquanto a live está no ar." };
    });
  }

  toggleRecording(): Promise<LiveStudioResult> {
    return this.exclusive(async () => {
      const socket = await this.ready();
      if (!(socket instanceof StudioSocket)) return socket;
      const wasRecording = Boolean(socket.settings?.recording);
      // Studio answers once the recording changed, and may never answer: also watch the snapshot.
      const [code, changed] = await Promise.all([
        socket.action(LIVE_STUDIO_ACTIONS.recording, {}, 10_000),
        socket.waitFor((settings) => Boolean(settings.recording) !== wasRecording, 10_000),
      ]);
      if (code === 0 || changed) {
        return { ok: true, detail: wasRecording ? "Gravação local encerrada no TikTok LIVE Studio." : "Gravação local em MP4 iniciada no TikTok LIVE Studio." };
      }
      return { ok: false, detail: "Não foi possível alternar a gravação local no TikTok LIVE Studio." };
    });
  }

  switchScene(scene: string): Promise<LiveStudioResult> {
    return this.exclusive(async () => {
      const socket = await this.ready();
      if (!(socket instanceof StudioSocket)) return socket;
      // Studio answers 0 only once the scene has changed.
      const code = await socket.action(LIVE_STUDIO_ACTIONS.scene, { settings: { scene } }, 6_000);
      return code === 0 ? { ok: true, detail: `Cena alterada para "${scene}".` } : { ok: false, detail: `Não foi possível mudar para a cena "${scene}".` };
    });
  }

  toggleSource(sourceId: string, scene?: string): Promise<LiveStudioResult> {
    return this.exclusive(async () => {
      const socket = await this.ready();
      if (!(socket instanceof StudioSocket)) return socket;
      const current = socket.settings?.scene;
      if (!current) return { ok: false, detail: "Nenhuma cena ativa identificada no TikTok LIVE Studio." };
      if (scene && scene !== current) {
        return { ok: false, detail: `O TikTok LIVE Studio só alterna fontes da cena atual ("${current}").` };
      }
      const code = await socket.action(LIVE_STUDIO_ACTIONS.source, { settings: { scene: current, source: sourceId } }, 6_000);
      return code === 0
        ? { ok: true, detail: "Visibilidade da fonte atualizada no TikTok LIVE Studio." }
        : { ok: false, detail: "Não foi possível alternar a fonte (com a live pausada, o TikTok LIVE Studio não deixa)." };
    });
  }

  triggerVibe(vibeId: string): Promise<LiveStudioResult> {
    return this.exclusive(async () => {
      const socket = await this.ready();
      if (!(socket instanceof StudioSocket)) return socket;
      const vibes = parseVibeList(socket.settings?.vibeList);
      const match = vibes.find((v) => v.id === vibeId) ?? vibes.find((v) => v.name.toLowerCase() === vibeId.toLowerCase());
      const label = match?.name ?? vibeId;
      const code = await socket.action(LIVE_STUDIO_ACTIONS.vibe, { settings: { currentVibeId: match?.id ?? vibeId } }, 5_000);
      return code === 0 ? { ok: true, detail: `Vibe "${label}" acionada no TikTok LIVE Studio!` } : { ok: false, detail: `Não foi possível acionar a Vibe "${label}".` };
    });
  }

  setCameraEffect(params: CameraEffectParams): Promise<LiveStudioResult> {
    return this.exclusive(async () => {
      const socket = await this.ready();
      if (!(socket instanceof StudioSocket)) return socket;
      const effects = parseCameraEffects(socket.settings?.camera_effect);
      // Studio finds the category by its name; older dashboards sent the key.
      const category = effects?.categories.find((c) => c.name === params.cameraEffectType) ?? effects?.categories.find((c) => c.key === params.cameraEffectType);
      if (!category) return { ok: false, detail: "Essa categoria de efeitos não existe mais no TikTok LIVE Studio." };
      const cameraSource = params.cameraSource || effects?.sources.find((s) => s.isDefault)?.id || "default";
      const code = await socket.action(
        LIVE_STUDIO_ACTIONS.cameraEffects,
        { settings: { cameraSource, cameraEffectType: category.name, cameraEffectId: params.cameraEffectId } },
        6_000,
      );
      // The same effect again removes it: Studio's action is a toggle.
      return code === 0
        ? { ok: true, detail: "Efeito de câmera alternado no TikTok LIVE Studio." }
        : { ok: false, detail: "Não foi possível aplicar o efeito de câmera (é preciso uma câmera na cena atual)." };
    });
  }

  /**
   * Adds or updates the stage's Browser Source in Studio's saved scenes. Studio
   * overwrites that file while open, so with Studio open the change waits and
   * is saved as soon as Studio closes.
   */
  injectStage(stageUrl: string): Promise<LiveStudioResult> {
    return this.exclusive(async () => {
      const running = Boolean(await this.ensureSocket()) || this.authRequired || (await this.system.isStudioRunning());
      if (!running) {
        this.pendingStageUrl = null;
        return injectStageIntoTikTokStore(stageUrl, this.ttStoreDir);
      }
      this.pendingStageUrl = stageUrl;
      return {
        ok: true,
        detail: "Feche o TikTok LIVE Studio: a fonte do palco é gravada assim que ele fechar e aparece quando você abrir de novo. Deixe o agente aberto.",
      };
    });
  }

  private savePendingStage(): void {
    const stageUrl = this.pendingStageUrl;
    if (!stageUrl) return;
    this.pendingStageUrl = null;
    const result = injectStageIntoTikTokStore(stageUrl, this.ttStoreDir);
    if (!result.ok) this.pendingStageUrl = stageUrl;
  }
}
