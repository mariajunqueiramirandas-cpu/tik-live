import Anthropic from "@anthropic-ai/sdk";
import { Entitlements } from "./billing/entitlements";
import type { MercadoPagoClient } from "./billing/mercadopago";
import { BillingService } from "./billing/service";
import { HttpBroadcasterClient, type BroadcasterClient } from "./broadcast/client";
import { BroadcastSupervisor } from "./broadcast/supervisor";
import type { AppConfig } from "./config";
import { Secrets } from "./crypto/secrets";
import type { Database, Db } from "./db/client";
import { DevIdentityProvider } from "./identity/dev";
import type { IdentityProvider } from "./identity/types";
import { createLogger, type Logger } from "./log";
import { listChannels } from "./repos/channels";
import { AudioStore } from "./runtime/audio-store";
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
  manager: RuntimeManager;
  /** Present when cloud broadcast is on for this server. */
  broadcasts: BroadcastSupervisor | null;
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
  const voices = new VoiceCatalog(config.ELEVENLABS_API_KEY, createLogger("voices"), overrides.fetch);
  const audio = new AudioStore(undefined, undefined, now);
  const anthropic = overrides.anthropic !== undefined ? overrides.anthropic : config.aiEnabled ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }) : null;
  const broadcasterClient =
    overrides.broadcaster ?? (config.BROADCAST_ENABLED ? new HttpBroadcasterClient(config.BROADCASTER_URL!, config.BROADCASTER_TOKEN!, overrides.fetch) : null);
  const broadcasts = broadcasterClient
    ? new BroadcastSupervisor({ client: broadcasterClient, secrets, stageOrigin: config.BROADCAST_STAGE_ORIGIN ?? config.PUBLIC_URL, log: createLogger("broadcast"), now })
    : undefined;
  const manager = new RuntimeManager({
    ctx: { db, config, anthropic, log: createLogger("runtime"), now },
    secrets,
    entitlements,
    audio,
    ...(broadcasts ? { broadcasts } : {}),
    ...(overrides.runtimeOverrides ? { runtimeOverrides: overrides.runtimeOverrides } : {}),
  });
  managerRef = manager;
  return { config, database, db, log, secrets, identity, entitlements, billing, voices, audio, manager, broadcasts: broadcasts ?? null, now };
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
