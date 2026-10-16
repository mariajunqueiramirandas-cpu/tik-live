import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().default(8090),
  /** Shared with the app server; at least 24 characters. */
  BROADCASTER_TOKEN: z.string().min(24, "BROADCASTER_TOKEN must be at least 24 characters"),
  /**
   * Comma-separated origins the stage page may load from. Inside compose the
   * app is reached as http://lantern-app:8080: never a bare "app" host, which
   * is an HSTS-preloaded top-level domain that Chromium forces to HTTPS.
   */
  STAGE_ORIGINS: z.string().default("http://lantern-app:8080"),
  CHROMIUM_PATH: z.string().optional(),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  BROADCAST_MAX_CONCURRENT: z.coerce.number().int().min(1).max(64).default(2),
  /** Development only: allow RTMP targets on private networks (a local test listener). */
  ALLOW_PRIVATE_RTMP: bool,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type BroadcasterConfig = z.infer<typeof schema> & { stageOrigins: string[]; isProduction: boolean };

export function loadConfig(env: Record<string, string | undefined> = process.env): BroadcasterConfig {
  // Blank values (KEY= in an env file) count as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid broadcaster configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const config = parsed.data;
  const isProduction = config.NODE_ENV === "production";
  if (isProduction && config.ALLOW_PRIVATE_RTMP) throw new Error("ALLOW_PRIVATE_RTMP must be off in production");
  const stageOrigins = config.STAGE_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => new URL(o).origin);
  return { ...config, stageOrigins, isProduction };
}
