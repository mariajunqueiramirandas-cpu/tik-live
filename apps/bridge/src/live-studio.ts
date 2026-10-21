import {
  LIVE_STUDIO_ACTIONS,
  LIVE_STUDIO_PORTS,
  LIVE_STUDIO_SUBPROTOCOL,
  type BridgeAction,
  type BridgeActionParams,
  type LiveStudioCameraEffects,
  type LiveStudioProbe,
  type LiveStudioSceneItem,
  type LiveStudioStreamStatus,
  type LiveStudioVibeItem,
} from "@tik-live/shared";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export interface LocalStudioController {
  probe(): Promise<LiveStudioProbe>;
  launch(timeoutMs?: number): Promise<{ ok: boolean; detail: string }>;
  start(): Promise<{ ok: boolean; detail: string }>;
  stop(): Promise<{ ok: boolean; detail: string }>;
  highlight?(): Promise<{ ok: boolean; detail: string }>;
  toggleRecording?(): Promise<{ ok: boolean; detail: string }>;
  switchScene?(scene: string): Promise<{ ok: boolean; detail: string }>;
  toggleSource?(sourceId: string, scene?: string): Promise<{ ok: boolean; detail: string }>;
  triggerVibe?(vibeId: string): Promise<{ ok: boolean; detail: string }>;
  setCameraEffect?(params: {
    cameraSource?: string;
    cameraEffectType: string;
    cameraEffectId: string;
  }): Promise<{ ok: boolean; detail: string }>;
  injectStage?(stageUrl: string): Promise<{ ok: boolean; detail: string }>;
}

interface SyncSettingsPayload {
  stream_status?: number;
  recording?: boolean;
  highlight_able?: boolean;
  scene?: string;
  scene_list?: Array<{
    name?: string;
    sources?: Array<{ label?: string; value?: string }>;
    visible_sources?: Array<{ label?: string; value?: string }>;
  }>;
  vibeList?: Array<{ id?: string; name?: string }>;
  playingVibe?: string;
  camera_effect?: {
    sourceList?: Array<{ label?: string; value?: string; isDefault?: boolean; effectId?: string }>;
    typeList?: string[];
    effectList?: Array<{
      key?: string;
      name?: string;
      effects?: Array<{ label?: string; value?: string }>;
    }>;
  };
}

function toStreamStatus(code: number | undefined): LiveStudioStreamStatus | null {
  if (code === 2) return "live";
  if (code === 1) return "paused";
  if (code === 0) return "stopped";
  return null;
}

function parseSceneList(raw: SyncSettingsPayload["scene_list"]): LiveStudioSceneItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item.name === "string" && item.name.trim())
    .map((item) => {
      const visibleIds = new Set(
        (item.visible_sources ?? [])
          .map((s) => (s && typeof s.value === "string" ? s.value : ""))
          .filter(Boolean),
      );
      const sources = (item.sources ?? [])
        .filter((s) => s && typeof s.value === "string" && s.value.trim())
        .map((s) => ({
          id: String(s.value),
          label: String(s.label ?? s.value),
          visible: visibleIds.has(String(s.value)),
        }));
      return {
        name: String(item.name),
        sources,
      };
    });
}

function parseVibeList(raw: SyncSettingsPayload["vibeList"]): LiveStudioVibeItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v) => v && typeof v.id === "string" && v.id.trim())
    .map((v) => ({
      id: String(v.id),
      name: String(v.name ?? v.id),
    }));
}

function parseCameraEffects(raw: SyncSettingsPayload["camera_effect"]): LiveStudioCameraEffects | null {
  if (!raw || typeof raw !== "object") return null;
  const sources = (raw.sourceList ?? [])
    .filter((s) => s && typeof s.value === "string" && s.value.trim())
    .map((s) => ({
      id: String(s.value),
      label: String(s.label ?? s.value),
      ...(s.isDefault !== undefined ? { isDefault: Boolean(s.isDefault) } : {}),
      effectId: typeof s.effectId === "string" && s.effectId ? s.effectId : null,
    }));
  const types = Array.isArray(raw.typeList) ? raw.typeList.filter((t): t is string => typeof t === "string") : [];
  const categories = (raw.effectList ?? [])
    .filter((c) => c && typeof c.key === "string" && c.key.trim())
    .map((c) => ({
      key: String(c.key),
      name: String(c.name ?? c.key),
      effects: (c.effects ?? [])
        .filter((e) => e && typeof e.value === "string" && e.value.trim())
        .map((e) => ({
          id: String(e.value),
          label: String(e.label ?? e.value),
        })),
    }));
  return { sources, types, categories };
}

export function findDefaultTTStoreDir(customDir?: string | null): string | null {
  if (customDir !== undefined) return customDir;
  if (process.env.TIKTOK_LIVE_STUDIO_STORE_DIR) return process.env.TIKTOK_LIVE_STUDIO_STORE_DIR;
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "TikTok LIVE Studio", "TTStore");
  return null;
}

interface TTStoreServicesShape {
  UserService?: {
    state?: {
      userInfo?: {
        username?: string;
        display_id?: string;
      };
    };
  };
  AccountService?: {
    state?: {
      accountList?: Array<{
        displayId?: string;
      }>;
    };
  };
  SourceService?: {
    state?: {
      currentScene?: string;
      currentSceneNew?: string;
      scenes?: Array<{ id?: string; name?: string }>;
      sceneSource?: Record<
        string,
        {
          order?: string[];
          data?: Record<string, Record<string, unknown>>;
          theme?: string;
        }
      >;
    };
  };
}

export function readLocalTikTokStore(customDir?: string | null): {
  tiktokUsername: string | null;
  stageInjected: boolean;
} {
  const dir = findDefaultTTStoreDir(customDir);
  if (!dir) return { tiktokUsername: null, stageInjected: false };
  const servicesPath = path.join(dir, "services.json");
  if (!existsSync(servicesPath)) return { tiktokUsername: null, stageInjected: false };

  try {
    const raw = readFileSync(servicesPath, "utf8");
    const parsed = JSON.parse(raw) as TTStoreServicesShape & { services?: TTStoreServicesShape };
    const root: TTStoreServicesShape = parsed.services ?? parsed;

    const userInfo = root.UserService?.state?.userInfo;
    const accountDisplayId = root.AccountService?.state?.accountList?.[0]?.displayId;
    let tiktokUsername: string | null =
      (typeof userInfo?.username === "string" && userInfo.username.trim()) ||
      (typeof userInfo?.display_id === "string" && userInfo.display_id.trim()) ||
      (typeof accountDisplayId === "string" && accountDisplayId.trim()) ||
      null;

    let stageInjected = false;
    const sceneSource = root.SourceService?.state?.sceneSource ?? {};
    for (const sceneEntry of Object.values(sceneSource)) {
      const data = sceneEntry?.data ?? {};
      for (const source of Object.values(data)) {
        const payload = source?.payload as { url?: string } | undefined;
        const url = payload?.url;
        if (typeof url === "string") {
          if (/\/s\/[A-Za-z0-9_-]{16,64}/.test(url)) {
            stageInjected = true;
          }
          if (!tiktokUsername) {
            const match = url.match(/[?&]ttDisplayId=([A-Za-z0-9._-]+)/);
            if (match?.[1]) tiktokUsername = decodeURIComponent(match[1]);
          }
        }
      }
    }

    return { tiktokUsername, stageInjected };
  } catch {
    return { tiktokUsername: null, stageInjected: false };
  }
}

export function injectStageIntoTikTokStore(
  stageUrl: string,
  customDir?: string | null,
): { ok: boolean; detail: string; sceneName?: string; updatedExisting?: boolean } {
  const dir = findDefaultTTStoreDir(customDir);
  if (!dir) {
    return {
      ok: false,
      detail: "A pasta de configuração do TikTok LIVE Studio (TTStore) não foi localizada neste computador.",
    };
  }
  const servicesPath = path.join(dir, "services.json");
  if (!existsSync(servicesPath)) {
    return {
      ok: false,
      detail: "O arquivo TTStore/services.json do TikTok LIVE Studio não foi encontrado. Abra o TikTok LIVE Studio pelo menos uma vez.",
    };
  }

  try {
    const raw = readFileSync(servicesPath, "utf8");
    const parsed = JSON.parse(raw) as TTStoreServicesShape & { services?: TTStoreServicesShape };
    const root: TTStoreServicesShape = parsed.services ?? parsed;

    const state = root.SourceService?.state;
    if (!state) {
      return {
        ok: false,
        detail: "A estrutura de cenas do TikTok LIVE Studio não foi encontrada em services.json.",
      };
    }

    const sceneId = state.currentSceneNew || state.currentScene || state.scenes?.[0]?.id;
    if (!sceneId) {
      return {
        ok: false,
        detail: "Nenhuma cena ativa foi encontrada no TikTok LIVE Studio.",
      };
    }

    const sceneObj = state.scenes?.find((s) => s.id === sceneId);
    const sceneName = sceneObj?.name ?? "Cena atual";

    if (!state.sceneSource) state.sceneSource = {};
    if (!state.sceneSource[sceneId]) {
      state.sceneSource[sceneId] = { order: [], data: {}, theme: "Default" };
    }
    const sceneData = state.sceneSource[sceneId]!;
    if (!Array.isArray(sceneData.order)) sceneData.order = [];
    if (!sceneData.data || typeof sceneData.data !== "object") sceneData.data = {};

    let targetSourceId: string | null = null;
    for (const [id, src] of Object.entries(sceneData.data)) {
      if (!src || typeof src !== "object") continue;
      const type = src.type;
      const name = typeof src.name === "string" ? src.name.toLowerCase() : "";
      const payload = src.payload as { url?: string } | undefined;
      const url = typeof payload?.url === "string" ? payload.url : "";
      if (type === "browser" && (/\/s\/[A-Za-z0-9_-]{16,64}/.test(url) || name === "vincular" || name.includes("lantern"))) {
        targetSourceId = id;
        break;
      }
    }

    const updatedExisting = Boolean(targetSourceId);
    if (targetSourceId) {
      const existing = sceneData.data[targetSourceId]!;
      const existingPayload = (existing.payload as Record<string, unknown> | undefined) ?? {};
      existing.visible = true;
      existing.payload = {
        ...existingPayload,
        url: stageUrl,
        cx: 1080,
        cy: 1920,
        enableAudio: true,
        enableCustomResolution: true,
      };
      if (!sceneData.order.includes(targetSourceId)) {
        sceneData.order.push(targetSourceId);
      }
    } else {
      const newId = crypto.randomUUID();
      const visualId = crypto.randomUUID();
      sceneData.data[newId] = {
        id: newId,
        name: "Vincular",
        type: "browser",
        track: 0,
        lock: false,
        visualId,
        visible: true,
        payload: {
          url: stageUrl,
          cx: 1080,
          cy: 1920,
          enableAudio: true,
          enableCustomResolution: true,
          zoom: 3.8017840169239308,
        },
        clip: { x: 0, y: 0, z: 0, w: 0 },
        alwaysTop: false,
        advancedFilters: [],
        sourceId: `${Date.now()}${Math.floor(Math.random() * 900000 + 100000)}`,
        transform: {
          translateX: 0,
          translateY: 0,
          rotateAngle: 0,
          scaleX: 0.42500001192092896,
          scaleY: 0.42500001192092896,
          flipH: false,
          flipV: false,
          size: { cx: 1080, cy: 1920 },
          preview_cx: 459,
          preview_cy: 816,
          layout: 1,
        },
        schemaVersion: 1,
        effectiveClip: { x: 0, y: 0, z: 0, w: 0 },
        deactiveWhenNotShow: true,
        stateData: {
          isPlaceholder: false,
          state: true,
          bizState: true,
          bizStateErrType: "none",
        },
      };
      sceneData.order.push(newId);
    }

    writeFileSync(servicesPath, JSON.stringify(parsed, null, 2), "utf8");
    return {
      ok: true,
      detail: updatedExisting
        ? `Fonte "Vincular" (1080×1920, com áudio) atualizada na cena "${sceneName}".`
        : `Fonte "Vincular" (1080×1920, com áudio) adicionada na cena "${sceneName}".`,
      sceneName,
      updatedExisting,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `Não foi possível atualizar a cena no TikTok LIVE Studio: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

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

export class LocalLiveStudioController implements LocalStudioController {
  private readonly ports: readonly number[];
  private readonly host: string;
  private readonly executablePath: string | null;
  private readonly ttStoreDir: string | null | undefined;

  constructor(
    options: {
      host?: string;
      ports?: readonly number[];
      executablePath?: string | null;
      ttStoreDir?: string | null;
    } = {},
  ) {
    this.host = options.host ?? "127.0.0.1";
    this.ports = options.ports ?? LIVE_STUDIO_PORTS;
    this.executablePath = options.executablePath !== undefined ? options.executablePath : findLiveStudioExecutable(process.env.TIKTOK_LIVE_STUDIO_PATH);
    this.ttStoreDir = options.ttStoreDir;
  }

  private async findOpenPort(): Promise<number | null> {
    for (const port of this.ports) {
      if (await isTcpPortOpen(this.host, port)) return port;
    }
    return null;
  }

  async probe(): Promise<LiveStudioProbe> {
    const installed = Boolean(this.executablePath);
    const localStore = readLocalTikTokStore(this.ttStoreDir);
    const port = await this.findOpenPort();
    if (!port) {
      return {
        connected: false,
        port: null,
        streamStatus: null,
        scene: null,
        installed,
        executablePath: this.executablePath,
        ...(localStore.tiktokUsername ? { tiktokUsername: localStore.tiktokUsername } : {}),
        ...(localStore.stageInjected ? { stageInjected: true } : {}),
      };
    }

    try {
      const settings = await this.readSettings(port, 3_000);
      const sceneList = parseSceneList(settings.scene_list);
      const vibeList = parseVibeList(settings.vibeList);
      const cameraEffects = parseCameraEffects(settings.camera_effect);
      const hasVincularSource = sceneList.some((sc) =>
        sc.sources.some((src) => src.label.toLowerCase() === "vincular" || src.label.toLowerCase().includes("lantern")),
      );
      return {
        connected: true,
        port,
        streamStatus: toStreamStatus(settings.stream_status),
        scene: settings.scene ?? null,
        installed,
        executablePath: this.executablePath,
        recording: Boolean(settings.recording),
        highlightAble: Boolean(settings.highlight_able),
        sceneList,
        vibeList,
        playingVibe: settings.playingVibe ?? null,
        cameraEffects,
        tiktokUsername: localStore.tiktokUsername,
        stageInjected: localStore.stageInjected || hasVincularSource,
      };
    } catch {
      return {
        connected: false,
        port,
        streamStatus: null,
        scene: null,
        installed,
        executablePath: this.executablePath,
        ...(localStore.tiktokUsername ? { tiktokUsername: localStore.tiktokUsername } : {}),
        ...(localStore.stageInjected ? { stageInjected: true } : {}),
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

  async highlight(): Promise<{ ok: boolean; detail: string }> {
    const port = await this.findOpenPort();
    if (!port) return { ok: false, detail: "O TikTok LIVE Studio não está aberto." };
    const res = await this.emitCommand(port, LIVE_STUDIO_ACTIONS.highlight, {}, 8_000);
    if (res.ok) {
      return { ok: true, detail: "Clipe de destaque (60s) salvo no TikTok LIVE Studio!" };
    }
    return {
      ok: false,
      detail: "Não foi possível salvar o clipe agora. O destaque fica disponível enquanto a live está no ar.",
    };
  }

  async toggleRecording(): Promise<{ ok: boolean; detail: string }> {
    const probe = await this.probe();
    if (!probe.connected || !probe.port) {
      return { ok: false, detail: "O TikTok LIVE Studio não está aberto." };
    }
    const wasRecording = Boolean(probe.recording);
    const res = await this.emitCommand(probe.port, LIVE_STUDIO_ACTIONS.recording, {}, 10_000);
    if (res.ok) {
      return {
        ok: true,
        detail: wasRecording ? "Gravação local encerrada no TikTok LIVE Studio." : "Gravação local em MP4 iniciada no TikTok LIVE Studio.",
      };
    }
    return { ok: false, detail: "Não foi possível alternar a gravação local no TikTok LIVE Studio." };
  }

  async switchScene(scene: string): Promise<{ ok: boolean; detail: string }> {
    const port = await this.findOpenPort();
    if (!port) return { ok: false, detail: "O TikTok LIVE Studio não está aberto." };
    const res = await this.emitCommand(port, LIVE_STUDIO_ACTIONS.scene, { settings: { scene } }, 6_000);
    if (res.ok) {
      return { ok: true, detail: `Cena alterada para "${scene}".` };
    }
    return { ok: false, detail: `Não foi possível mudar para a cena "${scene}".` };
  }

  async toggleSource(sourceId: string, scene?: string): Promise<{ ok: boolean; detail: string }> {
    const probe = await this.probe();
    if (!probe.connected || !probe.port) {
      return { ok: false, detail: "O TikTok LIVE Studio não está aberto." };
    }
    const targetScene = scene || probe.scene;
    if (!targetScene) {
      return { ok: false, detail: "Nenhuma cena ativa identificada no TikTok LIVE Studio." };
    }
    const res = await this.emitCommand(
      probe.port,
      LIVE_STUDIO_ACTIONS.source,
      { settings: { scene: targetScene, source: sourceId } },
      6_000,
    );
    if (res.ok) {
      return { ok: true, detail: "Visibilidade da fonte atualizada no TikTok LIVE Studio." };
    }
    return { ok: false, detail: "Não foi possível alternar a fonte na cena atual." };
  }

  async triggerVibe(vibeId: string): Promise<{ ok: boolean; detail: string }> {
    const probe = await this.probe();
    if (!probe.connected || !probe.port) {
      return { ok: false, detail: "O TikTok LIVE Studio não está aberto." };
    }
    let resolvedId = vibeId;
    const matchByName = probe.vibeList?.find(
      (v) => v.id === vibeId || v.name.toLowerCase() === vibeId.toLowerCase(),
    );
    if (matchByName) resolvedId = matchByName.id;
    const label = matchByName?.name ?? vibeId;

    const res = await this.emitCommand(
      probe.port,
      LIVE_STUDIO_ACTIONS.vibe,
      { settings: { currentVibeId: resolvedId } },
      5_000,
      true,
    );
    if (res.ok) {
      return { ok: true, detail: `Vibe "${label}" acionada no TikTok LIVE Studio!` };
    }
    return { ok: false, detail: `Não foi possível acionar a Vibe "${label}".` };
  }

  async setCameraEffect(params: {
    cameraSource?: string;
    cameraEffectType: string;
    cameraEffectId: string;
  }): Promise<{ ok: boolean; detail: string }> {
    const probe = await this.probe();
    if (!probe.connected || !probe.port) {
      return { ok: false, detail: "O TikTok LIVE Studio não está aberto." };
    }
    const defaultSource =
      params.cameraSource ||
      probe.cameraEffects?.sources.find((s) => s.isDefault)?.id ||
      probe.cameraEffects?.sources[0]?.id ||
      "all";
    const res = await this.emitCommand(
      probe.port,
      LIVE_STUDIO_ACTIONS.cameraEffects,
      {
        settings: {
          cameraSource: defaultSource,
          cameraEffectType: params.cameraEffectType,
          cameraEffectId: params.cameraEffectId,
        },
      },
      6_000,
    );
    if (res.ok) {
      return { ok: true, detail: "Efeito de câmera aplicado no TikTok LIVE Studio." };
    }
    return { ok: false, detail: "Não foi possível aplicar o efeito de câmera." };
  }

  async injectStage(stageUrl: string): Promise<{ ok: boolean; detail: string }> {
    return injectStageIntoTikTokStore(stageUrl, this.ttStoreDir);
  }

  async executeAction(action: BridgeAction, params?: BridgeActionParams): Promise<{ ok: boolean; detail: string }> {
    switch (action) {
      case "probe":
        await this.probe();
        return { ok: true, detail: "Status atualizado." };
      case "launch":
        return this.launch();
      case "start":
        return this.start();
      case "stop":
        return this.stop();
      case "highlight":
        return this.highlight();
      case "recording":
        return this.toggleRecording();
      case "scene":
        if (!params?.scene) return { ok: false, detail: "Informe o nome da cena." };
        return this.switchScene(params.scene);
      case "source":
        if (!params?.sourceId) return { ok: false, detail: "Informe a fonte da cena." };
        return this.toggleSource(params.sourceId, params.scene);
      case "vibe":
        if (!params?.vibeId) return { ok: false, detail: "Informe a Vibe desejada." };
        return this.triggerVibe(params.vibeId);
      case "camera_effect":
        if (!params?.cameraEffectType || !params?.cameraEffectId) {
          return { ok: false, detail: "Informe a categoria e o efeito de câmera." };
        }
        return this.setCameraEffect({
          ...(params.cameraSource ? { cameraSource: params.cameraSource } : {}),
          cameraEffectType: params.cameraEffectType,
          cameraEffectId: params.cameraEffectId,
        });
      case "inject_stage":
        if (!params?.stageUrl) return { ok: false, detail: "Informe o link do palco." };
        return this.injectStage(params.stageUrl);
    }
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

  private emitCommand(
    port: number,
    action: string,
    actionPayload: Record<string, unknown>,
    timeoutMs: number,
    resolveWithoutAck = false,
  ): Promise<{ ok: boolean; code: number }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://${this.host}:${port}/socket.io/?EIO=4&transport=websocket`, [LIVE_STUDIO_SUBPROTOCOL]);
      const contextId = `lantern_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let settled = false;
      let actionSent = false;
      let ackFallbackTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = (result: { ok: boolean; code: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ackFallbackTimer) clearTimeout(ackFallbackTimer);
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
              if (!actionSent) {
                actionSent = true;
                const packet = JSON.stringify({ action, context: contextId, payload: actionPayload });
                ws.send(`42${JSON.stringify(["stream_deck/action_emit", packet])}`);
                if (resolveWithoutAck) {
                  ackFallbackTimer = setTimeout(() => finish({ ok: true, code: 0 }), 300);
                }
              } else if (resolveWithoutAck) {
                finish({ ok: true, code: 0 });
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
