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
   * For Oxylabs, set OXYLABS_USERNAME and OXYLABS_PASSWORD instead.
   */
  SIGNER_PROXY_URL: z.string().url().optional(),
  /** Oxylabs residential proxies: the proxy user's name and password (not your account login). */
  OXYLABS_USERNAME: z.string().min(1).max(128).optional(),
  OXYLABS_PASSWORD: z.string().min(1).max(256).optional(),
  /** Two-letter country for the exit address, e.g. BR. Any country when unset. */
  OXYLABS_COUNTRY: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "OXYLABS_COUNTRY is a two-letter country code, like BR")
    .optional(),
  /** The residential entry node, host:port. */
  OXYLABS_ENDPOINT: z
    .string()
    .regex(/^[A-Za-z0-9.-]+:\d{2,5}$/, "OXYLABS_ENDPOINT is host:port, like pr.oxylabs.io:7777")
    .default("pr.oxylabs.io:7777"),
  /** How long one session keeps its exit address. Defaults to a little longer than SIGNER_RECYCLE_MINUTES. */
  OXYLABS_SESSION_MINUTES: z.coerce.number().int().min(1).max(1_440).optional(),
  /** Retries of a refused join from a new session (a new exit address). Needs a proxy. */
  SIGNER_REFUSAL_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
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

export type SignerConfig = z.infer<typeof schema> & { isProduction: boolean; oxylabsSessionMinutes: number };

export function loadConfig(env: Record<string, string | undefined> = process.env): SignerConfig {
  // Blank values (KEY= in an env file) count as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid signer configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const config = parsed.data;
  if (Boolean(config.OXYLABS_USERNAME) !== Boolean(config.OXYLABS_PASSWORD)) {
    throw new Error("Invalid signer configuration: set both OXYLABS_USERNAME and OXYLABS_PASSWORD, or neither");
  }
  if (config.OXYLABS_USERNAME && config.SIGNER_PROXY_URL) {
    throw new Error("Invalid signer configuration: set either SIGNER_PROXY_URL or the OXYLABS_* variables, not both");
  }
  return {
    ...config,
    isProduction: config.NODE_ENV === "production",
    oxylabsSessionMinutes: config.OXYLABS_SESSION_MINUTES ?? Math.min(1_440, config.SIGNER_RECYCLE_MINUTES + 10),
  };
}
