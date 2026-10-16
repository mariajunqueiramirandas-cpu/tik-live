import { websocket } from "hono/bun";
import path from "node:path";
import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { openDatabase } from "./db/client";
import { createDeps } from "./deps";
import { configureLogging, createLogger } from "./log";
import { lagMonitor } from "./http/lag";
import { RetentionJob } from "./runtime/retention";
import { elevenLabsLimiter, pocketLimiter } from "./runtime/voice/tts";

const log = createLogger("main");
// src/index.ts in development, dist/index.js in production: both sit one level below the package.
const MIGRATIONS = path.resolve(import.meta.dir, "../drizzle");

async function main(): Promise<void> {
  const config = loadConfig();
  configureLogging({ level: config.LOG_LEVEL, format: config.isProduction ? "json" : "pretty" });
  elevenLabsLimiter.limit = config.ELEVENLABS_MAX_CONCURRENCY;
  pocketLimiter.limit = config.POCKET_TTS_MAX_CONCURRENCY;

  const database = await openDatabase(config.DATABASE_URL, MIGRATIONS);
  await database.migrate();
  log.info(`database ready (${database.kind})`);

  const deps = await createDeps(config, database);
  const app = createApp(deps);
  const server = Bun.serve({
    hostname: config.HOST,
    port: config.PORT,
    fetch: app.fetch,
    websocket: { ...websocket, idleTimeout: 120, sendPings: true, maxPayloadLength: 64 * 1024 },
  });
  log.info(`listening on http://${server.hostname}:${server.port} (public URL ${config.PUBLIC_URL}, auth ${config.AUTH_MODE})`);
  if (!config.aiEnabled) log.warn("ANTHROPIC_API_KEY is not set: hosts use the offline scripted brain");
  if (config.AUTH_MODE === "dev") log.warn("AUTH_MODE=dev: there is no sign-in (ADR-0018)");

  await deps.manager.boot();
  lagMonitor.start();
  const retention = new RetentionJob({ db: deps.db, entitlements: deps.entitlements, log: createLogger("retention") });
  retention.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: draining`);
    retention.stop();
    await deps.manager.shutdown();
    server.stop();
    deps.audio.close();
    await database.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// An autonomous show must not die on one bad promise: log and keep going.
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", reason));
process.on("uncaughtException", (err) => log.error("uncaught exception", err));

main().catch((err) => {
  log.error(err instanceof ConfigError ? err.message : "failed to start", err instanceof ConfigError ? undefined : err);
  process.exit(1);
});
