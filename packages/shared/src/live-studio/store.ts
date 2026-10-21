import crypto from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * TikTok LIVE Studio keeps its saved state, scenes included, in
 * `%APPDATA%\TikTok LIVE Studio\TTStore\services.json`. It reads the file once
 * when it starts and writes its whole in-memory state back over it later, so
 * an edit made while Studio is open is never seen and gets overwritten. Only
 * write it while Studio is closed.
 */
export function findDefaultTTStoreDir(customDir?: string | null): string | null {
  if (customDir !== undefined) return customDir;
  if (process.env.TIKTOK_LIVE_STUDIO_STORE_DIR) return process.env.TIKTOK_LIVE_STUDIO_STORE_DIR;
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "TikTok LIVE Studio", "TTStore");
  return null;
}

/** A stage link's path: `/s/<stage key>`. */
const STAGE_PATH = /\/s\/[A-Za-z0-9_-]{16,64}/;
/** The name we give the stage's Browser Source. */
const STAGE_SOURCE_NAME = "Vincular";

type SourceData = Record<string, unknown> & { type?: unknown; name?: unknown; payload?: unknown };

interface TTStoreServicesShape {
  UserService?: { state?: { userInfo?: { username?: string; display_id?: string } } };
  AccountService?: { state?: { accountList?: Array<{ displayId?: string }> } };
  SourceService?: {
    state?: {
      currentScene?: string;
      currentSceneNew?: string;
      scenes?: Array<{ id?: string; name?: string }>;
      sceneSource?: Record<string, { order?: string[]; data?: Record<string, SourceData>; theme?: string }>;
    };
  };
}

export interface LocalTikTokStore {
  tiktokUsername: string | null;
  /** Some scene has a Browser Source showing a stage link. */
  stageInjected: boolean;
  /** That source's URL, so a rotated stage key shows as stale. */
  stageSourceUrl: string | null;
}

const EMPTY_STORE: LocalTikTokStore = { tiktokUsername: null, stageInjected: false, stageSourceUrl: null };

function rootOf(parsed: TTStoreServicesShape & { services?: TTStoreServicesShape }): TTStoreServicesShape {
  return parsed.services ?? parsed;
}

function urlOf(source: SourceData | undefined): string {
  const url = (source?.payload as { url?: unknown } | undefined)?.url;
  return typeof url === "string" ? url : "";
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

let cache: { file: string; stamp: string; value: LocalTikTokStore } | null = null;

/** The logged-in account and our stage source, read from Studio's saved state (cached until the file changes). */
export function readLocalTikTokStore(customDir?: string | null): LocalTikTokStore {
  const dir = findDefaultTTStoreDir(customDir);
  if (!dir) return EMPTY_STORE;
  const file = path.join(dir, "services.json");
  let stamp: string;
  try {
    const stat = statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return EMPTY_STORE;
  }
  if (cache && cache.file === file && cache.stamp === stamp) return cache.value;

  let value: LocalTikTokStore = EMPTY_STORE;
  try {
    const root = rootOf(JSON.parse(readFileSync(file, "utf8")) as TTStoreServicesShape);
    const userInfo = root.UserService?.state?.userInfo;
    const accountDisplayId = root.AccountService?.state?.accountList?.[0]?.displayId;
    let tiktokUsername: string | null =
      (typeof userInfo?.username === "string" && userInfo.username.trim()) ||
      (typeof userInfo?.display_id === "string" && userInfo.display_id.trim()) ||
      (typeof accountDisplayId === "string" && accountDisplayId.trim()) ||
      null;

    // The current scene's stage source wins: that's the one the live shows.
    const state = root.SourceService?.state;
    const currentId = state?.currentSceneNew || state?.currentScene;
    const scenes = Object.entries(state?.sceneSource ?? {}).sort(([a], [b]) => Number(b === currentId) - Number(a === currentId));
    let stageSourceUrl: string | null = null;
    for (const [, sceneEntry] of scenes) {
      for (const source of Object.values(sceneEntry?.data ?? {})) {
        const url = urlOf(source);
        if (!url) continue;
        if (STAGE_PATH.test(url) && !stageSourceUrl) stageSourceUrl = url;
        if (!tiktokUsername) {
          const match = url.match(/[?&]ttDisplayId=([A-Za-z0-9._-]+)/);
          if (match?.[1]) tiktokUsername = decodeURIComponent(match[1]);
        }
      }
    }
    value = { tiktokUsername, stageInjected: stageSourceUrl !== null, stageSourceUrl };
  } catch {
    value = EMPTY_STORE;
  }
  cache = { file, stamp, value };
  return value;
}

/**
 * Finds the source to point at the stage in a scene: the one already showing
 * this stage, else our "Vincular" source or any source showing a stage link
 * from the same app (an older stage key). A user's own sources are left alone.
 */
function findStageSource(data: Record<string, SourceData>, stageUrl: string): string | null {
  const origin = originOf(stageUrl);
  let named: string | null = null;
  let sameApp: string | null = null;
  for (const [id, source] of Object.entries(data)) {
    if (!source || typeof source !== "object" || source.type !== "browser") continue;
    const url = urlOf(source);
    if (url === stageUrl) return id;
    if (!STAGE_PATH.test(url) || originOf(url) !== origin) continue;
    if (source.name === STAGE_SOURCE_NAME) named ??= id;
    else sameApp ??= id;
  }
  return named ?? sameApp;
}

/** Writes through a temporary file and a rename, so a crash never leaves Studio a half-written file. */
function writeAtomically(file: string, text: string): void {
  const temp = `${file}.lantern-${process.pid}.tmp`;
  writeFileSync(temp, text, "utf8");
  renameSync(temp, file);
}

/**
 * Points the current scene's "Vincular" Browser Source at the stage (adding
 * it if needed). Call only while Studio is closed (see the note at the top).
 * Keeps a copy of the previous file as `services.json.lantern-backup`.
 */
export function injectStageIntoTikTokStore(
  stageUrl: string,
  customDir?: string | null,
): { ok: boolean; detail: string; sceneName?: string; updatedExisting?: boolean } {
  const dir = findDefaultTTStoreDir(customDir);
  if (!dir) {
    return { ok: false, detail: "A pasta de configuração do TikTok LIVE Studio (TTStore) não foi localizada neste computador." };
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
    const state = rootOf(parsed).SourceService?.state;
    if (!state) {
      return { ok: false, detail: "A estrutura de cenas do TikTok LIVE Studio não foi encontrada em services.json." };
    }

    const sceneId = state.currentSceneNew || state.currentScene || state.scenes?.[0]?.id;
    if (!sceneId) return { ok: false, detail: "Nenhuma cena ativa foi encontrada no TikTok LIVE Studio." };
    const sceneName = state.scenes?.find((s) => s.id === sceneId)?.name ?? "Cena atual";

    state.sceneSource ??= {};
    const sceneData = (state.sceneSource[sceneId] ??= { order: [], data: {}, theme: "Default" });
    if (!Array.isArray(sceneData.order)) sceneData.order = [];
    if (!sceneData.data || typeof sceneData.data !== "object") sceneData.data = {};

    const targetSourceId = findStageSource(sceneData.data, stageUrl);
    const updatedExisting = targetSourceId !== null;
    if (targetSourceId) {
      const existing = sceneData.data[targetSourceId]!;
      existing.visible = true;
      existing.payload = {
        ...((existing.payload as Record<string, unknown> | undefined) ?? {}),
        url: stageUrl,
        cx: 1080,
        cy: 1920,
        enableAudio: true,
        enableCustomResolution: true,
      };
      if (!sceneData.order.includes(targetSourceId)) sceneData.order.push(targetSourceId);
    } else {
      const newId = crypto.randomUUID();
      // A 1080×1920 source scaled to fill a portrait canvas, as Studio 1.38 saves one added by hand.
      sceneData.data[newId] = {
        id: newId,
        name: STAGE_SOURCE_NAME,
        type: "browser",
        track: 0,
        lock: false,
        visualId: crypto.randomUUID(),
        visible: true,
        payload: { url: stageUrl, cx: 1080, cy: 1920, enableAudio: true, enableCustomResolution: true, zoom: 3.8017840169239308 },
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
        stateData: { isPlaceholder: false, state: true, bizState: true, bizStateErrType: "none" },
      };
      sceneData.order.push(newId);
    }

    copyFileSync(servicesPath, `${servicesPath}.lantern-backup`);
    writeAtomically(servicesPath, JSON.stringify(parsed, null, 2));
    const written = rootOf(JSON.parse(readFileSync(servicesPath, "utf8")) as TTStoreServicesShape).SourceService?.state?.sceneSource?.[sceneId]?.data ?? {};
    if (!Object.values(written).some((source) => urlOf(source) === stageUrl)) {
      return { ok: false, detail: "A cena foi gravada, mas a fonte do palco não aparece no arquivo do TikTok LIVE Studio. Tente de novo." };
    }
    return {
      ok: true,
      detail: updatedExisting
        ? `Fonte "${STAGE_SOURCE_NAME}" (1080×1920, com áudio) atualizada na cena "${sceneName}".`
        : `Fonte "${STAGE_SOURCE_NAME}" (1080×1920, com áudio) adicionada na cena "${sceneName}".`,
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
