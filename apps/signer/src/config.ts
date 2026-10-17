import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().default(8091),
  /** Shared with the app server; at least 24 characters. */
  SIGNER_TOKEN: z.string().min(24, "SIGNER_TOKEN must be at least 24 characters"),
  CHROMIUM_PATH: z.string().optional(),
  /**
   * Where the browser's traffic leaves from. TikTok decides per network
   * whether anonymous viewers may join a room, and data-center addresses often
   * get a login wall instead; point this at a residential or mobile proxy then.
   */
  SIGNER_PROXY_URL: z.string().url().optional(),
  /** The browser's language and time zone; they go into every signed request. */
  SIGNER_LOCALE: z.string().min(2).max(16).default("en-US"),
  SIGNER_TIMEZONE: z.string().min(3).max(64).default("America/New_York"),
  /** A TikTok page whose own script signs requests; the signer keeps one open. */
  SIGNER_WARMUP_URL: z.string().url().default("https://www.tiktok.com/@tiktok/live"),
  /**
   * TikTok's webcast API host. The connector uses webcast.tiktok.com; TikTok's own
   * page uses a region host such as webcast.us.tiktok.com. Both get signed.
   */
  SIGNER_WEBCAST_ORIGIN: z.string().url().default("https://webcast.tiktok.com"),
  SIGNER_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(4),
  SIGNER_QUEUE_MAX: z.coerce.number().int().min(0).max(256).default(32),
  SIGNER_CALL_TIMEOUT_MS: z.coerce.number().int().min(2_000).max(120_000).default(20_000),
  /** Idle sessions older than this are reloaded, so TikTok's script and tokens stay fresh. */
  SIGNER_RECYCLE_MINUTES: z.coerce.number().int().min(1).max(1_440).default(30),
  /** Containers that run Chromium as root can't use its sandbox. Off by default. */
  SIGNER_NO_SANDBOX: bool,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type SignerConfig = z.infer<typeof schema> & { isProduction: boolean };

export function loadConfig(env: Record<string, string | undefined> = process.env): SignerConfig {
  // Blank values (KEY= in an env file) count as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid signer configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { ...parsed.data, isProduction: parsed.data.NODE_ENV === "production" };
}
