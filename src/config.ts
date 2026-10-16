import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const segmentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** How long the segment runs before the director rotates to the next one. */
  minutes: z.number().positive(),
  /** What the host should do to fill time during this segment when chat is quiet. */
  prompt: z.string().min(1),
});

export const personaSchema = z.object({
  name: z.string().min(1),
  tagline: z.string().min(1),
  /** Who the character is: backstory, personality, quirks. */
  description: z.string().min(1),
  /** How the character talks. */
  style: z.string().min(1),
  catchphrases: z.array(z.string()).default([]),
  /** Extra persona-specific rules, appended to the built-in safety rules. */
  rules: z.array(z.string()).default([]),
  /** Upper bound on sentences per turn (keeps the host snappy). */
  maxSentences: z.number().int().min(1).max(8).default(3),
  segments: z.array(segmentSchema).min(1),
  visual: z
    .object({
      /** "orb" draws the character; "none" is a voice-only show with captions. */
      mode: z.enum(["orb", "none"]).default("orb"),
      primary: z.string().default("#7CF5FF"),
      secondary: z.string().default("#FF5FD2"),
      background: z.string().default("#0B0420"),
    })
    .default({ mode: "orb", primary: "#7CF5FF", secondary: "#FF5FD2", background: "#0B0420" }),
});

export type Persona = z.infer<typeof personaSchema>;
export type Segment = z.infer<typeof segmentSchema>;

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no", "on", "off"])
  .transform((v) => ["true", "1", "yes", "on"].includes(v));

const envSchema = z.object({
  TIKTOK_USERNAME: z.string().optional(),
  EULER_API_KEY: z.string().optional(),
  EVENT_SOURCE: z.enum(["tiktok", "simulator"]).optional(),
  SIMULATOR_RATE: z.coerce.number().positive().default(0.5),

  HOST_BRAIN: z.enum(["claude", "scripted"]).optional(),
  HOST_MODEL: z.string().default("claude-opus-5-5"),
  HOST_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  SAFETY_LLM: bool.default(true),
  SAFETY_MODEL: z.string().default("claude-opus-5-5"),
  SAFETY_FAIL_OPEN: bool.default(false),

  TTS_PROVIDER: z.enum(["none", "elevenlabs"]).default("none"),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL: z.string().default("eleven_flash_v2_5"),

  BIND_HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(4545),
  CONTROL_TOKEN: z.string().optional(),

  OBS_WS_URL: z.string().optional(),
  OBS_WS_PASSWORD: z.string().optional(),
  OBS_AUTOSTART: bool.default(true),

  PERSONA: z.string().default("personas/blip.json"),
  BLOCKLIST: z.string().default("config/blocklist.txt"),
  DATA_DIR: z.string().default("data"),
  DEAD_AIR_SECONDS: z.coerce.number().positive().default(7),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env;
  persona: Persona;
  blocklist: string[];
  eventSource: "tiktok" | "simulator";
  hostBrain: "claude" | "scripted";
}

export function loadPersona(file: string): Persona {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const parsed = personaSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid persona ${file}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function loadBlocklist(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith("#"));
}

export function loadConfig(cwd = process.cwd()): AppConfig {
  const envFile = path.join(cwd, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  // Treat blank values (e.g. `CONTROL_TOKEN=` copied from .env.example) as unset.
  const cleaned = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value?.trim()));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.message}`);
  const env = parsed.data;

  const eventSource = env.EVENT_SOURCE ?? (env.TIKTOK_USERNAME ? "tiktok" : "simulator");
  if (eventSource === "tiktok" && !env.TIKTOK_USERNAME) {
    throw new Error("EVENT_SOURCE=tiktok requires TIKTOK_USERNAME");
  }
  // The control panel can make the host say anything, so it must not be
  // reachable from the network without a token.
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(env.BIND_HOST);
  if (!loopback && !env.CONTROL_TOKEN) {
    throw new Error(`BIND_HOST=${env.BIND_HOST} exposes the control panel; set CONTROL_TOKEN`);
  }
  if (env.TTS_PROVIDER === "elevenlabs" && (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID)) {
    throw new Error("TTS_PROVIDER=elevenlabs requires ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID");
  }

  const hasClaudeCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const hostBrain = env.HOST_BRAIN ?? (hasClaudeCredentials ? "claude" : "scripted");

  return {
    env,
    persona: loadPersona(path.resolve(cwd, env.PERSONA)),
    blocklist: loadBlocklist(path.resolve(cwd, env.BLOCKLIST)),
    eventSource,
    hostBrain,
  };
}
