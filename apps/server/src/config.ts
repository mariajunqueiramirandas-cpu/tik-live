import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { OXYLABS_DEFAULT_ENDPOINT } from "@tik-live/shared";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no", "on", "off"])
  .transform((value) => ["true", "1", "yes", "on"].includes(value));

const money = z.coerce.number().positive().max(1_000_000);

const DEV_SECRET = "dev-only-secret-change-me-dev-only-secret-change-me";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  /** True behind a reverse proxy that sets X-Forwarded-For (Caddy in deploy/compose.yaml). */
  TRUST_PROXY: bool.default(false),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  /** Where people reach the app; used for stage links, redirects and CSRF origin checks. */
  PUBLIC_URL: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().default("pglite://.data/pglite"),
  APP_SECRET: z.string().min(32).default(DEV_SECRET),
  /** Built dashboard assets to serve. Unset in development (Vite serves them). */
  WEB_DIST: z.string().optional(),

  AUTH_MODE: z.enum(["dev", "clerk", "workos"]).default("dev"),
  DEV_GATE_PASSWORD: z.string().min(8).optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  /** Optional: Clerk user webhooks (user.updated, user.deleted) at /api/identity/clerk-webhook. */
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().optional(),
  WORKOS_API_KEY: z.string().optional(),
  WORKOS_CLIENT_ID: z.string().optional(),
  WORKOS_COOKIE_PASSWORD: z.string().min(32).optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  /** Deployment override for every plan's host model (ADR-0012); unset = each plan's own. */
  HOST_MODEL: z.string().optional(),
  HOST_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  MODERATION_ENABLED: bool.default(true),
  /** Deployment override for every plan's moderator model; unset = each plan's own. */
  MODERATION_MODEL: z.string().optional(),
  /** Concurrent ElevenLabs requests across all hosts in this process (protects rate limits). */
  ELEVENLABS_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  MODERATION_FAIL_OPEN: bool.default(false),

  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_MODEL: z.string().default("eleven_flash_v2_5"),
  DEFAULT_VOICE_ID: z.string().optional(),

  /** Self-hosted Pocket TTS (services/tts, ADR-0021). On when both are set. */
  POCKET_TTS_URL: z.string().url().optional(),
  POCKET_TTS_SECRET: z.string().min(16).optional(),
  /** The voice for plans without voice choice, and the dashboard's "Default voice". */
  POCKET_TTS_VOICE: z.string().max(64).default("rafael"),
  /** Concurrent requests to the sidecar from this process; keep under its TTS_MAX_ACTIVE (16). */
  POCKET_TTS_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),

  /** Hosted Euler Stream sign server (higher rate limits). Ignored when the self-hosted signer below is on. */
  EULER_API_KEY: z.string().optional(),
  /** Self-hosted TikTok signer (apps/signer, ADR-0023). On when both are set; replaces Euler Stream. */
  SIGNER_URL: z.string().url().optional(),
  SIGNER_TOKEN: z.string().min(24).optional(),
  /**
   * Oxylabs residential proxies (ADR-0023). The signer reads the same names for its own traffic;
   * the app only uses them to send each channel's TikTok websocket through the proxy, when asked.
   */
  OXYLABS_USERNAME: z.string().min(1).max(128).optional(),
  OXYLABS_PASSWORD: z.string().min(1).max(256).optional(),
  OXYLABS_COUNTRY: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "OXYLABS_COUNTRY is a two-letter country code, like BR")
    .optional(),
  OXYLABS_ENDPOINT: z
    .string()
    .regex(/^[A-Za-z0-9.-]+:\d{2,5}$/, "OXYLABS_ENDPOINT is host:port, like pr.oxylabs.io:7777")
    .default(OXYLABS_DEFAULT_ENDPOINT),
  /**
   * Send every channel's TikTok websocket through the proxy too, one sticky address per channel. Off by
   * default: the signed join is a few kilobytes, but a room's websocket streams for hours and residential
   * proxies bill by traffic. Turn it on if TikTok refuses the websocket from the server's own address.
   */
  TIKTOK_WS_VIA_PROXY: bool.default(false),

  MP_ACCESS_TOKEN: z.string().optional(),
  /** Alias for MP_ACCESS_TOKEN (the name used in this project's environment settings). */
  MP_PLATFORM_ACCESS_TOKEN: z.string().optional(),
  MP_WEBHOOK_SECRET: z.string().optional(),
  MP_PUBLIC_KEY: z.string().optional(),
  BILLING_CURRENCY: z.string().length(3).default("BRL"),
  PLAN_PRICE_CREATOR: money.default(49.9),
  PLAN_PRICE_PRO: money.default(149.9),

  BROADCAST_ENABLED: bool.default(false),
  BROADCASTER_URL: z.string().url().optional(),
  BROADCASTER_TOKEN: z.string().min(24).optional(),
  /** Origin the broadcaster uses to load stage pages, e.g. http://lantern-app:8080 inside compose. Defaults to PUBLIC_URL. */
  BROADCAST_STAGE_ORIGIN: z.string().url().optional(),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig extends Env {
  isProduction: boolean;
  publicOrigin: string;
  billingEnabled: boolean;
  aiEnabled: boolean;
  ttsEnabled: boolean;
  pocketEnabled: boolean;
  signerEnabled: boolean;
  /** The websocket goes through Oxylabs (TIKTOK_WS_VIA_PROXY, with credentials). */
  wsProxyEnabled: boolean;
}

export class ConfigError extends Error {}

/** Loads and validates configuration. Blank values count as unset. */
export function loadConfig(source: Record<string, string | undefined> = process.env, cwd = process.cwd()): AppConfig {
  if (source === process.env) {
    const envFile = path.join(cwd, ".env");
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${problems}`);
  }
  const env = parsed.data;
  env.MP_ACCESS_TOKEN ??= env.MP_PLATFORM_ACCESS_TOKEN;
  const isProduction = env.NODE_ENV === "production";

  if (isProduction && env.APP_SECRET === DEV_SECRET) {
    throw new ConfigError("APP_SECRET must be set to a random value of at least 32 characters in production");
  }
  // ADR-0018: never run the no-sign-in mode on a public production server without the gate.
  if (isProduction && env.AUTH_MODE === "dev" && !env.DEV_GATE_PASSWORD) {
    throw new ConfigError(
      "AUTH_MODE=dev has no sign-in. Set DEV_GATE_PASSWORD to protect this server, or configure Clerk/WorkOS",
    );
  }
  if (env.AUTH_MODE === "clerk" && !(env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY)) {
    throw new ConfigError("AUTH_MODE=clerk requires CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY");
  }
  if (env.AUTH_MODE === "workos" && !(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID && env.WORKOS_COOKIE_PASSWORD)) {
    throw new ConfigError("AUTH_MODE=workos requires WORKOS_API_KEY, WORKOS_CLIENT_ID and WORKOS_COOKIE_PASSWORD");
  }
  if (Boolean(env.MP_ACCESS_TOKEN) !== Boolean(env.MP_WEBHOOK_SECRET)) {
    throw new ConfigError("Set both MP_ACCESS_TOKEN and MP_WEBHOOK_SECRET to enable billing, or neither");
  }
  if (env.POCKET_TTS_SECRET && !env.POCKET_TTS_URL) {
    throw new ConfigError("POCKET_TTS_SECRET requires POCKET_TTS_URL (the tts service, e.g. http://localhost:8793)");
  }
  if (env.BROADCAST_ENABLED && !(env.BROADCASTER_URL && env.BROADCASTER_TOKEN)) {
    throw new ConfigError("BROADCAST_ENABLED requires BROADCASTER_URL and BROADCASTER_TOKEN");
  }
  if (Boolean(env.SIGNER_URL) !== Boolean(env.SIGNER_TOKEN)) {
    throw new ConfigError("Set both SIGNER_URL and SIGNER_TOKEN to use the self-hosted signer, or neither");
  }
  if (Boolean(env.OXYLABS_USERNAME) !== Boolean(env.OXYLABS_PASSWORD)) {
    throw new ConfigError("Set both OXYLABS_USERNAME and OXYLABS_PASSWORD to use the Oxylabs proxy, or neither");
  }
  if (env.TIKTOK_WS_VIA_PROXY && !env.OXYLABS_USERNAME) {
    throw new ConfigError("TIKTOK_WS_VIA_PROXY requires OXYLABS_USERNAME and OXYLABS_PASSWORD");
  }

  const pocketEnabled = Boolean(env.POCKET_TTS_URL && env.POCKET_TTS_SECRET);
  return {
    ...env,
    isProduction,
    publicOrigin: new URL(env.PUBLIC_URL).origin,
    billingEnabled: Boolean(env.MP_ACCESS_TOKEN),
    aiEnabled: Boolean(env.ANTHROPIC_API_KEY),
    ttsEnabled: Boolean(env.ELEVENLABS_API_KEY) || pocketEnabled,
    pocketEnabled,
    signerEnabled: Boolean(env.SIGNER_URL && env.SIGNER_TOKEN),
    wsProxyEnabled: Boolean(env.TIKTOK_WS_VIA_PROXY && env.OXYLABS_USERNAME && env.OXYLABS_PASSWORD),
  };
}

/** Configuration for tests: in-memory database, no external services. */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ NODE_ENV: "test", DATABASE_URL: "pglite://memory", LOG_LEVEL: "error", ...overrides });
}
