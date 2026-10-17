import { createApi } from "./api";
import { BrowserBackend } from "./browser-backend";
import { loadConfig } from "./config";
import { createLogger } from "./log";

const config = loadConfig();
const log = createLogger({ level: config.LOG_LEVEL, json: config.isProduction, base: { service: "signer" } });
const backend = new BrowserBackend({
  log,
  locale: config.SIGNER_LOCALE,
  timezone: config.SIGNER_TIMEZONE,
  warmupUrl: config.SIGNER_WARMUP_URL,
  webcastOrigin: new URL(config.SIGNER_WEBCAST_ORIGIN).origin,
  siteOrigin: "https://www.tiktok.com",
  maxConcurrent: config.SIGNER_MAX_CONCURRENT,
  maxQueue: config.SIGNER_QUEUE_MAX,
  callTimeoutMs: config.SIGNER_CALL_TIMEOUT_MS,
  recycleMs: config.SIGNER_RECYCLE_MINUTES * 60_000,
  readyTimeoutMs: 45_000,
  sandbox: !config.SIGNER_NO_SANDBOX,
  ...(config.CHROMIUM_PATH ? { chromiumPath: config.CHROMIUM_PATH } : {}),
  ...(config.SIGNER_PROXY_URL ? { proxyUrl: config.SIGNER_PROXY_URL } : {}),
});
const app = createApi(backend, config.SIGNER_TOKEN, log);
const server = Bun.serve({ hostname: config.HOST, port: config.PORT, fetch: app.fetch });
log.info(`signer listening on http://${config.HOST}:${server.port}`, {
  maxConcurrent: config.SIGNER_MAX_CONCURRENT,
  proxy: config.SIGNER_PROXY_URL ? "yes" : "no",
  locale: config.SIGNER_LOCALE,
  timezone: config.SIGNER_TIMEZONE,
});
// Start the browser now so the first channel to connect doesn't wait for it.
void backend.warmUp().catch((err: unknown) => log.warn("browser warm-up failed; it will retry on the first request", { error: err instanceof Error ? err.message : String(err) }));

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info(`${signal}: closing the browser`);
  server.stop();
  await backend.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
