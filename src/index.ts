import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { Director } from "./brain/director.js";
import { ClaudeHost, ScriptedHost, type HostBrain } from "./brain/host.js";
import { ViewerMemory } from "./brain/memory.js";
import { toUtterance } from "./brain/sentences.js";
import { Triage } from "./brain/triage.js";
import { SimulatorSource } from "./events/simulator.js";
import { TikTokSource } from "./events/tiktok.js";
import type { EventSource, LiveEvent } from "./events/types.js";
import { addLogSink, createLogger, SessionRecorder } from "./log.js";
import { ObsSupervisor } from "./obs/supervisor.js";
import { ClaudeModerator, SafetyGate } from "./safety/gate.js";
import { StageServer, type ControlCommand } from "./stage/server.js";
import { SpeechPipeline } from "./voice/pipeline.js";
import { ElevenLabsTts, NoTts, type TtsProvider } from "./voice/tts.js";

const log = createLogger("main");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const config = loadConfig();
  const { env, persona, blocklist } = config;

  const recorder = new SessionRecorder(env.DATA_DIR);
  const memory = new ViewerMemory(env.DATA_DIR);
  const triage = new Triage({ blocklist, hostName: persona.name, memory });
  const claude = config.hostBrain === "claude" ? new Anthropic() : undefined;

  const host: HostBrain =
    config.hostBrain === "claude" && claude
      ? new ClaudeHost({ client: claude, persona, memory, blocklist, model: env.HOST_MODEL, effort: env.HOST_EFFORT })
      : new ScriptedHost(persona);

  const useModerator = env.SAFETY_LLM && config.hostBrain === "claude" && claude;
  const safety = new SafetyGate({
    blocklist,
    failOpen: env.SAFETY_FAIL_OPEN,
    ...(useModerator ? { moderator: new ClaudeModerator(claude, env.SAFETY_MODEL) } : {}),
  });

  const tts: TtsProvider =
    env.TTS_PROVIDER === "elevenlabs"
      ? new ElevenLabsTts({
          apiKey: env.ELEVENLABS_API_KEY as string,
          voiceId: env.ELEVENLABS_VOICE_ID as string,
          model: env.ELEVENLABS_MODEL,
        })
      : new NoTts();

  const stage = new StageServer({
    host: env.BIND_HOST,
    port: env.PORT,
    publicDir: path.join(root, "public"),
    persona,
    ...(env.CONTROL_TOKEN ? { controlToken: env.CONTROL_TOKEN } : {}),
  });

  let director: Director | undefined;
  const speech = new SpeechPipeline(tts, safety, stage, {
    onSpoken: (cue) => director?.noteSpoken(cue.text),
    onDropped: (text, reason) => {
      recorder.record("blocked", { text, reason });
      stage.pushControl({ type: "blocked", text, reason, at: Date.now() });
    },
  });

  const source: EventSource =
    config.eventSource === "tiktok"
      ? new TikTokSource({
          username: env.TIKTOK_USERNAME as string,
          ...(env.EULER_API_KEY ? { signApiKey: env.EULER_API_KEY } : {}),
        })
      : new SimulatorSource({ rate: env.SIMULATOR_RATE });

  director = new Director({
    persona,
    host,
    triage,
    memory,
    speech,
    stage,
    recorder,
    deadAirMs: env.DEAD_AIR_SECONDS * 1000,
    startInStandby: config.eventSource === "tiktok",
  });

  const obs = env.OBS_WS_URL
    ? new ObsSupervisor({
        url: env.OBS_WS_URL,
        autostart: env.OBS_AUTOSTART,
        ...(env.OBS_WS_PASSWORD ? { password: env.OBS_WS_PASSWORD } : {}),
      })
    : undefined;

  const injectEvent = (command: Extract<ControlCommand, { type: "inject" }>): LiveEvent | undefined => {
    const e = command.event;
    const viewer = { id: `operator:${e.handle}`, handle: e.handle, nickname: e.handle };
    const at = Date.now();
    if (e.kind === "chat" && e.text) return { kind: "chat", at, viewer, text: e.text };
    if (e.kind === "follow") return { kind: "follow", at, viewer };
    if (e.kind === "gift") {
      const count = Math.max(1, e.count ?? 1);
      return { kind: "gift", at, viewer, giftName: e.giftName || "Rose", count, diamonds: (e.diamonds ?? 1) * count };
    }
    return undefined;
  };

  stage.onControl((command) => {
    const d = director as Director;
    switch (command.type) {
      case "pause":
        d.pause();
        break;
      case "resume":
        d.resume();
        break;
      case "skip":
        d.skip();
        break;
      case "segment":
        d.forceSegment(command.id);
        break;
      case "say": {
        const utterance = toUtterance(command.text);
        if (utterance) speech.enqueue(utterance, true);
        break;
      }
      case "inject": {
        const event = injectEvent(command);
        if (event) d.handleEvent(event);
        break;
      }
    }
  });

  const snapshot = () => ({
    director: director?.state(),
    source: source.status(),
    obs: obs?.getStatus() ?? null,
    stages: stage.stageCount(),
    queue: triage.peek().map((item) => ({
      kind: item.event.kind,
      who: "viewer" in item.event ? item.event.viewer.nickname || item.event.viewer.handle : "",
      text: "text" in item.event ? item.event.text : "giftName" in item.event ? `${item.event.count}x ${item.event.giftName}` : "",
      priority: Math.round(item.priority),
    })),
    dropped: Object.fromEntries(triage.dropped),
    nowPlaying: speech.nowPlaying()?.text ?? null,
    viewersRemembered: memory.size,
    brain: { host: host.name, moderator: Boolean(useModerator), tts: tts.name, source: source.name },
    segments: persona.segments.map((s) => ({ id: s.id, title: s.title })),
  });
  stage.setStateProvider(snapshot);
  addLogSink((entry) => stage.pushControl({ type: "log", ...entry }));
  setInterval(() => stage.pushControl({ type: "state", state: snapshot() }), 1_000).unref();

  await stage.listen();
  await source.start((event) => director?.handleEvent(event));
  obs?.start();
  director.start();

  log.info(
    `${persona.name} is running: source=${source.name}, brain=${host.name}, moderator=${useModerator ? env.SAFETY_MODEL : "rules only"}, tts=${tts.name}`,
  );
  if (config.hostBrain === "scripted") {
    log.warn("no Claude credentials found; using the offline scripted host (set ANTHROPIC_API_KEY for the real brain)");
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    director?.stop();
    speech.stop();
    await source.stop();
    await obs?.stop();
    memory.close();
    stage.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// An autonomous show must not die on one bad promise: log and keep going.
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", reason));
process.on("uncaughtException", (err) => log.error("uncaught exception", err));

main().catch((err) => {
  log.error("failed to start", err);
  process.exit(1);
});
