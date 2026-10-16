import { createApi } from "./api";
import { loadConfig } from "./config";
import { createLogger } from "./log";
import { BroadcastManager } from "./manager";
import { ChromiumPipeline } from "./pipeline";

const config = loadConfig();
const log = createLogger({ level: config.LOG_LEVEL, json: config.isProduction, base: { service: "broadcaster" } });
const pipeline = new ChromiumPipeline({
  ffmpegPath: config.FFMPEG_PATH,
  log,
  renderer: config.BROADCAST_RENDERER,
  videoEncoder: config.VIDEO_ENCODER,
  x264Preset: config.X264_PRESET,
  stageOrigins: config.stageOrigins,
  ...(config.RENDER_THREADS ? { renderThreads: config.RENDER_THREADS } : {}),
  ...(config.CHROMIUM_PATH ? { chromiumPath: config.CHROMIUM_PATH } : {}),
});
const manager = new BroadcastManager({
  factory: pipeline,
  log,
  maxConcurrent: config.BROADCAST_MAX_CONCURRENT,
  stageOrigins: config.stageOrigins,
  rtmp: { allowPrivate: config.ALLOW_PRIVATE_RTMP },
});
const app = createApi(manager, config.BROADCASTER_TOKEN);
const server = Bun.serve({ hostname: config.HOST, port: config.PORT, fetch: app.fetch });
log.info(`broadcaster listening on http://${config.HOST}:${server.port}`, {
  maxConcurrent: config.BROADCAST_MAX_CONCURRENT,
  renderer: config.BROADCAST_RENDERER,
  stageOrigins: config.stageOrigins,
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info(`${signal}: stopping broadcasts`);
  await manager.stopAll();
  await pipeline.close();
  server.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
