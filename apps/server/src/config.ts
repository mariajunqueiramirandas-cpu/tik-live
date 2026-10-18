import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_FISH_VOICE, FISH_VOICE_ID, FISH_VOICES, parseFishVoices, type FishVoice } from "./voices/fish-voices";

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
  /**
   * "adaptive" lets the host's model think when a turn needs it; "off" skips
   * thinking for a faster first word, on models that allow it (Claude Haiku
   * 5.5 at low to high effort). Others keep adaptive thinking.
   */
  HOST_THINKING: z.enum(["adaptive", "off"]).default("adaptive"),
  /**
   * How far behind real time viewers watch the stream (TikTok LIVE is
   * usually a few seconds). Game rounds keep taking answers this long after
   * their timer runs out, and dead air after the host asks chat something
   * waits this much longer.
   */
  STREAM_DELAY_MS: z.coerce.number().int().min(0).max(30_000).default(5_000),
  MODERATION_ENABLED: bool.default(true),
  /** Deployment override for every plan's moderator model; unset = each plan's own. */
  MODERATION_MODEL: z.string().optional(),
  /**
   * "adaptive" lets the moderator think when a sentence needs it (an odd
   * name, a double meaning) and skip it on ordinary lines; "off" never
   * thinks, for the fastest verdict, on models that allow it (ADR-0034).
   */
  MODERATION_THINKING: z.enum(["adaptive", "off"]).default("adaptive"),
  /** Concurrent ElevenLabs requests across all hosts in this process (protects rate limits). */
  ELEVENLABS_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  MODERATION_FAIL_OPEN: bool.default(false),

  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_MODEL: z.string().default("eleven_flash_v2_5"),
  DEFAULT_VOICE_ID: z.string().optional(),

  /** Fish Audio voices through OpenRouter (ADR-0030): on with a key, and then new hosts' default voice. */
  OPENROUTER_API_KEY: z.string().optional(),
  /** OpenRouter's API root; point it at a proxy or a test server. */
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  /** The Fish Audio model on OpenRouter. Drama 3 acts each line's emotion. */
  FISH_TTS_MODEL: z.string().min(1).max(100).default("fish-audio/drama-3"),
  /** The voice for plans without voice choice, and the dashboard's "Voz padrão": a Fish Audio voice id. */
  FISH_TTS_VOICE: z.string().regex(FISH_VOICE_ID, "must be a Fish Audio voice id (32 hex characters)").default(DEFAULT_FISH_VOICE),
  /** Replaces the built-in voices: comma-separated id=Name pairs, for voices you have the rights to. */
  FISH_TTS_VOICES: z.string().optional(),
  /** Concurrent requests to OpenRouter's speech API from this process. */
  FISH_TTS_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),

  /** Self-hosted Pocket TTS (services/tts, ADR-0021). On when both are set. */
  POCKET_TTS_URL: z.string().url().optional(),
  POCKET_TTS_SECRET: z.string().min(16).optional(),
  /** The voice for plans without voice choice, and the dashboard's "Default voice". */
  POCKET_TTS_VOICE: z.string().max(64).default("rafael"),
  /** Concurrent requests to the sidecar from this process; keep under its TTS_MAX_ACTIVE (16). */
  POCKET_TTS_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),

  EULER_API_KEY: z.string().optional(),

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
  fishEnabled: boolean;
  /** The Fish voices hosts may use: FISH_TTS_VOICES, or the built-in list. */
  fishVoices: FishVoice[];
  /** The voice providers this server has, the default (for new hosts) first. */
  voiceProviders: Array<"fish" | "elevenlabs" | "pocket">;
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
  const fishVoices = env.FISH_TTS_VOICES ? parseFishVoices(env.FISH_TTS_VOICES) : FISH_VOICES;
  if (typeof fishVoices === "string") throw new ConfigError(`FISH_TTS_VOICES ${fishVoices}`);
  if (!fishVoices.some((voice) => voice.id === env.FISH_TTS_VOICE)) {
    throw new ConfigError(`FISH_TTS_VOICE ${env.FISH_TTS_VOICE} isn't one of the voices: add it to FISH_TTS_VOICES as id=Name`);
  }
  if (env.BROADCAST_ENABLED && !(env.BROADCASTER_URL && env.BROADCASTER_TOKEN)) {
    throw new ConfigError("BROADCAST_ENABLED requires BROADCASTER_URL and BROADCASTER_TOKEN");
  }

  const pocketEnabled = Boolean(env.POCKET_TTS_URL && env.POCKET_TTS_SECRET);
  const fishEnabled = Boolean(env.OPENROUTER_API_KEY);
  const voiceProviders = [
    ...(fishEnabled ? (["fish"] as const) : []),
    ...(env.ELEVENLABS_API_KEY ? (["elevenlabs"] as const) : []),
    ...(pocketEnabled ? (["pocket"] as const) : []),
  ];
  return {
    ...env,
    isProduction,
    publicOrigin: new URL(env.PUBLIC_URL).origin,
    billingEnabled: Boolean(env.MP_ACCESS_TOKEN),
    aiEnabled: Boolean(env.ANTHROPIC_API_KEY),
    ttsEnabled: voiceProviders.length > 0,
    pocketEnabled,
    fishEnabled,
    fishVoices,
    voiceProviders,
  };
}

/** Configuration for tests: in-memory database, no external services. */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ NODE_ENV: "test", DATABASE_URL: "pglite://memory", LOG_LEVEL: "error", ...overrides });
}
