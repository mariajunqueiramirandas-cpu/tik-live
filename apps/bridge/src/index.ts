import { toBridgeWsUrl } from "@tik-live/shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { BridgeAgent } from "./agent";
import { LocalLiveStudioController } from "./live-studio";

interface SavedBridgeConfig {
  url?: string;
}

function configFilePaths(): string[] {
  const localPath = path.join(path.dirname(process.execPath), "lantern-bridge.json");
  const appData = process.env.APPDATA ? path.join(process.env.APPDATA, "Lantern", "bridge.json") : null;
  return appData ? [localPath, appData] : [localPath];
}

function loadSavedUrl(): string | null {
  for (const file of configFilePaths()) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as SavedBridgeConfig;
      if (parsed.url?.trim()) return parsed.url.trim();
    } catch {
      // Ignore invalid config files.
    }
  }
  return null;
}

function saveUrl(url: string): void {
  const targets = configFilePaths();
  for (const target of targets) {
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify({ url }, null, 2), "utf8");
      return;
    } catch {
      // Try next candidate path.
    }
  }
}

async function promptForStageUrl(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question("Cole o link do palco do apresentador (ex: https://.../s/...): ")).trim();
      try {
        toBridgeWsUrl(answer);
        return answer;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    rl.close();
  }
}

function readFlagValue(args: string[], flag: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === flag && args[i + 1]) return args[i + 1]!;
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const controller = new LocalLiveStudioController();

  if (args.includes("--check")) {
    const probe = await controller.probe();
    console.log(JSON.stringify(probe, null, 2));
    process.exit(probe.connected || probe.installed ? 0 : 1);
  }
  if (args.includes("--launch")) {
    const res = await controller.launch();
    console.log(res.detail);
    process.exit(res.ok ? 0 : 1);
  }
  if (args.includes("--start")) {
    const res = await controller.start();
    console.log(res.detail);
    process.exit(res.ok ? 0 : 1);
  }
  if (args.includes("--stop")) {
    const res = await controller.stop();
    console.log(res.detail);
    process.exit(res.ok ? 0 : 1);
  }
  if (args.includes("--highlight")) {
    const res = await controller.highlight();
    console.log(res.detail);
    process.exit(res.ok ? 0 : 1);
  }
  if (args.includes("--record")) {
    const res = await controller.toggleRecording();
    console.log(res.detail);
    process.exit(res.ok ? 0 : 1);
  }
  const sceneFlag = readFlagValue(args, "--scene");
  if (sceneFlag) {
    const res = await controller.switchScene(sceneFlag);
    console.log(res.detail);
    process.exit(res.ok ? 0 : 1);
  }
  const vibeFlag = readFlagValue(args, "--vibe");
  if (vibeFlag) {
    const res = await controller.triggerVibe(vibeFlag);
    console.log(res.detail);
    process.exit(res.ok ? 0 : 1);
  }
  const injectStageFlag = readFlagValue(args, "--inject-stage");
  if (injectStageFlag) {
    const res = await controller.injectStage(injectStageFlag);
    console.log(res.detail);
    process.exit(res.ok ? 0 : 1);
  }

  let urlArg = readFlagValue(args, "--url");
  if (!urlArg) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (!arg.startsWith("-")) {
        urlArg = arg;
        break;
      }
    }
  }

  let targetUrl = urlArg ?? process.env.LANTERN_STAGE_URL ?? loadSavedUrl();
  if (!targetUrl) {
    console.log("=== Lantern — Agente Local do TikTok LIVE Studio ===");
    targetUrl = await promptForStageUrl();
  }

  // Validate and persist for future double-click runs.
  const wsUrl = toBridgeWsUrl(targetUrl);
  saveUrl(targetUrl);

  // If the user passed a full Stage URL (`https://.../s/<stageKey>`), ensure the
  // Browser Source ("Vincular") in TikTok LIVE Studio points to it automatically.
  if (/^https?:\/\/.+\/s\/[A-Za-z0-9_-]{16,64}/.test(targetUrl.trim())) {
    const injected = await controller.injectStage(targetUrl.trim());
    if (injected.ok) {
      console.log(`[lantern-bridge] ${injected.detail}`);
    }
  }

  const initialProbe = await controller.probe();
  console.log("=== Lantern — Agente Local do TikTok LIVE Studio ===");
  console.log(`Servidor: ${wsUrl}`);
  if (initialProbe.tiktokUsername) {
    console.log(`Conta logada no TikTok LIVE Studio: @${initialProbe.tiktokUsername}`);
  }
  console.log(
    initialProbe.connected
      ? `TikTok LIVE Studio: aberto na porta ${initialProbe.port} (${initialProbe.streamStatus ?? "carregando"})${initialProbe.scene ? ` — cena "${initialProbe.scene}"` : ""}`
      : initialProbe.installed
        ? `TikTok LIVE Studio: instalado (${initialProbe.executablePath})`
        : "TikTok LIVE Studio: não encontrado neste computador",
  );

  const agent = new BridgeAgent({ url: targetUrl, controller });
  agent.start();

  const shutdown = () => {
    console.log("\nEncerrando agente local...");
    agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[lantern-bridge] erro:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
