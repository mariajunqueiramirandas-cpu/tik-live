import { BRIDGE_CLOSE, formatPairingCode, normalizePairingCode, toBridgeWsUrl } from "@tik-live/shared";
import os from "node:os";
import readline from "node:readline/promises";
import { BridgeAgent, type BridgeConnection } from "./agent";
import { loadConfig, saveConfig } from "./config";
import { LocalLiveStudioController } from "./live-studio";
import { pairWithCode, readOwnStamp } from "./pair";

const TITLE = "=== Lantern — Agente Local do TikTok LIVE Studio ===";

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Keeps a double-clicked console window open long enough to read the last message. */
async function pauseBeforeExit(): Promise<void> {
  if (process.platform === "win32" && process.stdin.isTTY) await ask("Pressione Enter para fechar.");
}

function argValue(args: string[], name: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === name && args[i + 1]) return args[i + 1]!;
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return null;
}

function isStageLink(input: string): boolean {
  try {
    toBridgeWsUrl(input);
    return true;
  } catch {
    return false;
  }
}

async function askServer(): Promise<string> {
  for (;;) {
    const answer = await ask("Endereço do Lantern (o mesmo do painel, ex: https://lantern.exemplo.com): ");
    try {
      const url = new URL(answer.includes("://") ? answer : `https://${answer}`);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // Ask again.
    }
    console.error("Isso não parece um endereço. Copie da barra do navegador, com o painel aberto.");
  }
}

/**
 * Pairs this PC with a host (ADR-0047): the stamped or given code first,
 * then asks until a code works. Returns how to connect; pasting a stage link
 * at the prompt still works for setups from before pairing.
 */
async function pair(options: { code: string | null; server: string | null }): Promise<BridgeConnection> {
  let code = options.code;
  let server = options.server;
  for (;;) {
    if (!code) {
      const answer = await ask("Digite o código de pareamento que aparece no painel (ex: ABCD-2345): ");
      if (isStageLink(answer)) {
        saveConfig({ url: answer });
        return { url: answer };
      }
      code = normalizePairingCode(answer);
      if (!code) {
        console.error("O código tem 8 letras e números, como ABCD-2345.");
        continue;
      }
    }
    server ??= await askServer();
    try {
      console.log(`Pareando com o código ${formatPairingCode(code)}...`);
      const paired = await pairWithCode(server, code, os.hostname());
      saveConfig({ server, token: paired.token, channelName: paired.channelName, usedCode: code });
      console.log(`Pareado com o apresentador "${paired.channelName}".`);
      return { server, token: paired.token };
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      saveConfig({ ...loadConfig(), usedCode: code });
      code = null;
    }
  }
}

function forgetPairing(): void {
  const { token: _token, channelName: _channel, url: _url, ...rest } = loadConfig();
  saveConfig(rest);
}

let current: BridgeAgent | null = null;

async function run(connection: BridgeConnection, controller: LocalLiveStudioController): Promise<void> {
  // Stage link mode: point the "Vincular" Browser Source in TikTok LIVE Studio at it automatically.
  if ("url" in connection && /^https?:\/\/.+\/s\/[A-Za-z0-9_-]{16,64}/.test(connection.url.trim())) {
    const injected = await controller.injectStage(connection.url.trim());
    if (injected.ok) console.log(`[lantern-bridge] ${injected.detail}`);
  }
  const initialProbe = await controller.probe();
  const server = "token" in connection ? connection.server : new URL(toBridgeWsUrl(connection.url).replace(/^ws/, "http")).origin;
  console.log(TITLE);
  console.log(`Servidor: ${server}`);
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

  // The server let go for good: forget what no longer works and pair again.
  const ended = async (code: number) => {
    forgetPairing();
    console.log(
      code === BRIDGE_CLOSE.unpaired
        ? "Este computador foi removido no painel. Gere um novo código de pareamento para conectar de novo."
        : code === BRIDGE_CLOSE.channelDeleted
          ? "O apresentador foi excluído. Gere um código de pareamento em outro apresentador."
          : "O link do palco mudou. Gere um código de pareamento no painel para conectar de novo.",
    );
    await run(await pair({ code: null, server }), controller);
  };

  current = new BridgeAgent({ ...connection, controller, onEnded: (code) => void ended(code).catch(fail) });
  current.start();
}

function shutdown(): void {
  console.log("\nEncerrando agente local...");
  current?.stop();
  process.exit(0);
}

async function main(): Promise<void> {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
  const sceneFlag = argValue(args, "--scene");
  if (sceneFlag) {
    const res = await controller.switchScene(sceneFlag);
    console.log(res.detail);
    process.exit(res.ok ? 0 : 1);
  }
  const vibeFlag = argValue(args, "--vibe");
  if (vibeFlag) {
    const res = await controller.triggerVibe(vibeFlag);
    console.log(res.detail);
    process.exit(res.ok ? 0 : 1);
  }
  const injectStageFlag = argValue(args, "--inject-stage");
  if (injectStageFlag) {
    const res = await controller.injectStage(injectStageFlag);
    console.log(res.detail);
    process.exit(res.ok ? 0 : 1);
  }
  if (args.includes("--unpair")) {
    forgetPairing();
    console.log("Pareamento apagado deste computador. Remova-o também no painel, se quiser.");
    process.exit(0);
  }

  // Stage link mode, from before pairing: `--url <link>` or a bare link argument.
  const stageUrl = argValue(args, "--url") ?? args.find((arg) => !arg.startsWith("-") && isStageLink(arg)) ?? process.env.LANTERN_STAGE_URL ?? null;
  if (stageUrl) {
    toBridgeWsUrl(stageUrl);
    saveConfig({ url: stageUrl });
    return run({ url: stageUrl }, controller);
  }

  const saved = loadConfig();
  const stamp = readOwnStamp();
  const pairArg = argValue(args, "--pair");
  const server = argValue(args, "--server") ?? stamp?.server ?? saved.server ?? process.env.LANTERN_SERVER_URL ?? null;

  if (pairArg) {
    const code = normalizePairingCode(pairArg);
    if (!code) throw new Error("O código de pareamento tem 8 letras e números, como ABCD-2345.");
    return run(await pair({ code, server }), controller);
  }
  // A fresh download pairs itself with the code the dashboard stamped on it.
  if (stamp && stamp.code !== saved.usedCode) {
    console.log(TITLE);
    return run(await pair({ code: stamp.code, server: stamp.server }), controller);
  }
  if (saved.token && saved.server) return run({ server: saved.server, token: saved.token }, controller);
  if (saved.url) return run({ url: saved.url }, controller);

  console.log(TITLE);
  return run(await pair({ code: null, server }), controller);
}

async function fail(err: unknown): Promise<void> {
  console.error("[lantern-bridge] erro:", err instanceof Error ? err.message : String(err));
  await pauseBeforeExit();
  process.exit(1);
}

if (import.meta.main) main().catch(fail);
