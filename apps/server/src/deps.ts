import { tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Entitlements } from "./billing/entitlements";
import type { MercadoPagoClient } from "./billing/mercadopago";
import { BillingService } from "./billing/service";
import { HttpBroadcasterClient, type BroadcasterClient } from "./broadcast/client";
import { LiveStudioSupervisor, LocalLiveStudioClient, type LiveStudioClient } from "./broadcast/live-studio";
import { inertStudioSystem } from "@tik-live/shared/live-studio";
import { BROADCAST_VIDEO, BroadcastSupervisor } from "./broadcast/supervisor";
import type { AppConfig } from "./config";
import { Secrets } from "./crypto/secrets";
import type { Database, Db } from "./db/client";
import { DevIdentityProvider } from "./identity/dev";
import type { IdentityProvider } from "./identity/types";
import { createLogger, type Logger } from "./log";
import { listChannels } from "./repos/channels";
import { AudioStore } from "./runtime/audio-store";
import { DjCache } from "./runtime/dj-cache";
import type { ChannelRuntimeOptions } from "./runtime/channel-runtime";
import { RuntimeManager } from "./runtime/manager";
import { VoiceCatalog } from "./voices/catalog";

export interface AppDeps {
  config: AppConfig;
  database: Database;
  db: Db;
  log: Logger;
  secrets: Secrets;
  identity: IdentityProvider;
  entitlements: Entitlements;
  billing: BillingService;
  voices: VoiceCatalog;
  audio: AudioStore;
  /** The automatic DJ's tracks on disk (ADR-0045). */
  djCache: DjCache;
  manager: RuntimeManager;
  /** Present when cloud broadcast is on for this server. */
  broadcasts: BroadcastSupervisor | null;
  /** Controls the local TikTok LIVE Studio desktop app on this machine. */
  liveStudio: LiveStudioSupervisor;
  now: () => number;
}

export interface DepsOverrides {
  identity?: IdentityProvider;
  anthropic?: Anthropic | null;
  mercadoPago?: MercadoPagoClient;
  fetch?: typeof fetch;
  runtimeOverrides?: Pick<ChannelRuntimeOptions, "makeSource" | "makeHost" | "makeTts">;
  /** Tests: a fake broadcaster (turns cloud broadcast on). */
  broadcaster?: BroadcasterClient;
  /** Tests: a fake TikTok LIVE Studio client. */
  liveStudio?: LiveStudioClient;
  now?: () => number;
}

export async function createDeps(config: AppConfig, database: Database, overrides: DepsOverrides = {}): Promise<AppDeps> {
  const log = createLogger("app");
  const now = overrides.now ?? Date.now;
  const db = database.db;
  const secrets = new Secrets(config.APP_SECRET);
  // The identity provider can delete accounts (Clerk webhook), which must stop their hosts first.
  let managerRef: RuntimeManager | null = null;
  const identity =
    overrides.identity ??
    (await createIdentityProvider(config, {
      db,
      log: createLogger("identity"),
      onUserDeleted: async (userId) => {
        for (const channel of await listChannels(db, userId)) await managerRef?.remove(channel.id);
      },
    }));
  const entitlements = new Entitlements(db, config, now);
  const billing = new BillingService(db, config, entitlements, createLogger("billing"), overrides.mercadoPago, now);
  const voices = new VoiceCatalog(
    config.ELEVENLABS_API_KEY,
    createLogger("voices"),
    overrides.fetch,
    config.pocketEnabled ? { url: config.POCKET_TTS_URL!, secret: config.POCKET_TTS_SECRET! } : null,
    config.fishEnabled
      ? { apiKey: config.OPENROUTER_API_KEY!, baseUrl: config.OPENROUTER_BASE_URL, model: config.FISH_TTS_MODEL, voices: config.fishVoices }
      : null,
  );
  const audio = new AudioStore(undefined, undefined, now);
  const djCache = new DjCache({
    dir: config.DJ_CACHE_DIR ?? path.join(tmpdir(), "lantern-dj"),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    log: createLogger("dj"),
    now,
  });
  const anthropic = overrides.anthropic !== undefined ? overrides.anthropic : config.aiEnabled ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }) : null;
  const broadcasterClient =
    overrides.broadcaster ?? (config.BROADCAST_ENABLED ? new HttpBroadcasterClient(config.BROADCASTER_URL!, config.BROADCASTER_TOKEN!, overrides.fetch) : null);
  const broadcasts = broadcasterClient
    ? new BroadcastSupervisor({
        client: broadcasterClient,
        secrets,
        stageOrigin: config.BROADCAST_STAGE_ORIGIN ?? config.PUBLIC_URL,
        video: BROADCAST_VIDEO[config.BROADCAST_QUALITY],
        log: createLogger("broadcast"),
        now,
      })
    : undefined;
  const liveStudioClient =
    overrides.liveStudio ??
    (config.NODE_ENV === "test"
      ? new LocalLiveStudioClient({ ports: [], executablePath: null, ttStoreDir: null, system: inertStudioSystem })
      : new LocalLiveStudioClient());
  const liveStudio = new LiveStudioSupervisor({
    client: liveStudioClient,
    log: createLogger("live-studio"),
    now,
  });
  const manager = new RuntimeManager({
    ctx: { db, config, anthropic, log: createLogger("runtime"), now, djCache },
    secrets,
    entitlements,
    audio,
    ...(broadcasts ? { broadcasts } : {}),
    liveStudio,
    ...(overrides.runtimeOverrides ? { runtimeOverrides: overrides.runtimeOverrides } : {}),
  });
  managerRef = manager;
  return { config, database, db, log, secrets, identity, entitlements, billing, voices, audio, djCache, manager, broadcasts: broadcasts ?? null, liveStudio, now };
}

/** Picks the identity provider for AUTH_MODE (ADR-0018). */
export async function createIdentityProvider(
  config: AppConfig,
  options: { db?: Database["db"]; log?: Logger; onUserDeleted?: (userId: string) => Promise<void> } = {},
): Promise<IdentityProvider> {
  switch (config.AUTH_MODE) {
    case "dev":
      return new DevIdentityProvider();
    case "clerk": {
      const { ClerkIdentityProvider } = await import("./identity/clerk");
      return new ClerkIdentityProvider(config, {
        ...(options.db ? { database: options.db } : {}),
        ...(options.log ? { log: options.log } : {}),
        ...(options.onUserDeleted ? { onUserDeleted: options.onUserDeleted } : {}),
      });
    }
    case "workos": {
      const { WorkOSIdentityProvider } = await import("./identity/workos");
      return new WorkOSIdentityProvider(config, options.log ? { log: options.log } : {});
    }
  }
}
