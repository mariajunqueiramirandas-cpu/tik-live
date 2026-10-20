import {
  LIVE_STUDIO_ACTIONS,
  LIVE_STUDIO_PORTS,
  LIVE_STUDIO_SUBPROTOCOL,
  type LiveStudioProbe,
  type LiveStudioStreamStatus,
} from "@tik-live/shared";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export interface LocalStudioController {
  probe(): Promise<LiveStudioProbe>;
  launch(timeoutMs?: number): Promise<{ ok: boolean; detail: string }>;
  start(): Promise<{ ok: boolean; detail: string }>;
  stop(): Promise<{ ok: boolean; detail: string }>;
}

interface SyncSettingsPayload {
  stream_status?: number;
  scene?: string;
}

function toStreamStatus(code: number | undefined): LiveStudioStreamStatus | null {
  if (code === 2) return "live";
  if (code === 1) return "paused";
  if (code === 0) return "stopped";
  return null;
}

export function findLiveStudioExecutable(customPath?: string): string | null {
  if (customPath && existsSync(customPath)) return customPath;
  const roots = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "TikTok LIVE Studio") : "C:\\Program Files\\TikTok LIVE Studio",
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Programs", "TikTok LIVE Studio")] : []),
  ];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const launcherConfig = path.join(root, "launcher_config.json");
    if (existsSync(launcherConfig)) {
      try {
        const parsed = JSON.parse(readFileSync(launcherConfig, "utf8")) as { cur_path?: string };
        if (parsed.cur_path) {
          const versionedExe = path.join(root, parsed.cur_path, "TikTok LIVE Studio.exe");
          if (existsSync(versionedExe)) return versionedExe;
        }
      } catch {
        // Fall through to directory scan.
      }
    }
    try {
      const entries = readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name, "TikTok LIVE Studio.exe");
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Ignore unreadable directories.
    }
    const launcherExe = path.join(root, "TikTok LIVE Studio Launcher.exe");
    if (existsSync(launcherExe)) return launcherExe;
    const directExe = path.join(root, "TikTok LIVE Studio.exe");
    if (existsSync(directExe)) return directExe;
  }
  return null;
}

function isTcpPortOpen(host: string, port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

export class LocalLiveStudioController implements LocalStudioController {
  private readonly ports: readonly number[];
  private readonly host: string;
  private readonly executablePath: string | null;

  constructor(
    options: {
      host?: string;
      ports?: readonly number[];
      executablePath?: string | null;
    } = {},
  ) {
    this.host = options.host ?? "127.0.0.1";
    this.ports = options.ports ?? LIVE_STUDIO_PORTS;
    this.executablePath = options.executablePath !== undefined ? options.executablePath : findLiveStudioExecutable(process.env.TIKTOK_LIVE_STUDIO_PATH);
  }

  private async findOpenPort(): Promise<number | null> {
    for (const port of this.ports) {
      if (await isTcpPortOpen(this.host, port)) return port;
    }
    return null;
  }

  async probe(): Promise<LiveStudioProbe> {
    const installed = Boolean(this.executablePath);
    const port = await this.findOpenPort();
    if (!port) {
      return {
        connected: false,
        port: null,
        streamStatus: null,
        scene: null,
        installed,
        executablePath: this.executablePath,
      };
    }

    try {
      const settings = await this.readSettings(port, 3_000);
      return {
        connected: true,
        port,
        streamStatus: toStreamStatus(settings.stream_status),
        scene: settings.scene ?? null,
        installed,
        executablePath: this.executablePath,
      };
    } catch {
      return {
        connected: false,
        port,
        streamStatus: null,
        scene: null,
        installed,
        executablePath: this.executablePath,
      };
    }
  }

  async launch(timeoutMs = 45_000): Promise<{ ok: boolean; detail: string }> {
    const initial = await this.probe();
    if (initial.connected && initial.streamStatus !== null) {
      return { ok: true, detail: "O TikTok LIVE Studio já está aberto e conectado." };
    }
    if (!initial.connected) {
      if (!this.executablePath) {
        return {
          ok: false,
          detail: "O TikTok LIVE Studio não foi encontrado neste computador. Instale ou abra o aplicativo primeiro.",
        };
      }
      try {
        const child = spawn(this.executablePath, [], {
          cwd: path.dirname(this.executablePath),
          detached: true,
          stdio: "ignore",
          windowsHide: false,
          env: { ...process.env, DEVTOOLS_MCP: "1" },
        });
        child.unref();
      } catch (err) {
        return {
          ok: false,
          detail: `Não foi possível abrir o TikTok LIVE Studio: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.probe();
      if (current.connected && current.streamStatus !== null) {
        return { ok: true, detail: "TikTok LIVE Studio aberto e pronto." };
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return {
      ok: false,
      detail: "O TikTok LIVE Studio abriu, mas ainda não terminou de carregar. Confira se você está logado no aplicativo.",
    };
  }

  async start(): Promise<{ ok: boolean; detail: string }> {
    let probe = await this.probe();
    if (!probe.connected || probe.streamStatus === null) {
      const launched = await this.launch();
      if (!launched.ok) return launched;
      probe = await this.probe();
    }
    if (!probe.connected || !probe.port) {
      return { ok: false, detail: "Não foi possível conectar ao TikTok LIVE Studio." };
    }
    if (probe.streamStatus === "live") {
      return { ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" };
    }

    const action = probe.streamStatus === "paused" ? LIVE_STUDIO_ACTIONS.livePauseResume : LIVE_STUDIO_ACTIONS.liveStartEnd;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.emitAction(probe.port, action, "live", 25_000);
      if (result.ok) {
        return { ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" };
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2_000));
        const check = await this.probe();
        if (check.streamStatus === "live") {
          return { ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" };
        }
      }
    }

    return {
      ok: false,
      detail: "O TikTok LIVE Studio não conseguiu iniciar a live. Confira no aplicativo se sua conta está logada e com título e tema preenchidos.",
    };
  }

  async stop(): Promise<{ ok: boolean; detail: string }> {
    const probe = await this.probe();
    if (!probe.connected || !probe.port || probe.streamStatus === "stopped" || probe.streamStatus === null) {
      return { ok: true, detail: "Desligada" };
    }
    const result = await this.emitAction(probe.port, LIVE_STUDIO_ACTIONS.liveStartEnd, "stopped", 15_000);
    if (result.ok) return { ok: true, detail: "Desligada" };
    const after = await this.probe();
    if (!after.connected || after.streamStatus === "stopped") {
      return { ok: true, detail: "Desligada" };
    }
    return { ok: false, detail: "Não foi possível encerrar a live no TikTok LIVE Studio." };
  }

  private readSettings(port: number, timeoutMs: number): Promise<SyncSettingsPayload> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.host}:${port}/socket.io/?EIO=4&transport=websocket`, [LIVE_STUDIO_SUBPROTOCOL]);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // Ignore close errors.
        }
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error("Timed out reading TikTok LIVE Studio settings"))), timeoutMs);

      ws.addEventListener("message", (event) => {
        const data = String(event.data);
        if (data.startsWith("0")) {
          ws.send("40");
          return;
        }
        if (data === "2") {
          ws.send("3");
          return;
        }
        if (data.startsWith("40")) {
          ws.send('42["stream_deck/join_room"]');
          ws.send('42["stream_deck/sync_settings"]');
          return;
        }
        if (data.startsWith("42")) {
          try {
            const [name, rawPayload] = JSON.parse(data.slice(2)) as [string, unknown];
            if (name === "stream_deck/sync_settings" && typeof rawPayload === "string") {
              const parsed = JSON.parse(rawPayload) as SyncSettingsPayload;
              finish(() => resolve(parsed));
            }
          } catch {
            // Ignore malformed messages.
          }
        }
      });

      ws.addEventListener("error", () => finish(() => reject(new Error("Could not connect to TikTok LIVE Studio"))));
      ws.addEventListener("close", () => finish(() => reject(new Error("Connection closed before settings arrived"))));
    });
  }

  private emitAction(
    port: number,
    action: string,
    targetStatus: LiveStudioStreamStatus,
    timeoutMs: number,
  ): Promise<{ ok: boolean; code: number }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://${this.host}:${port}/socket.io/?EIO=4&transport=websocket`, [LIVE_STUDIO_SUBPROTOCOL]);
      const contextId = `lantern_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let settled = false;
      let actionSent = false;

      const finish = (result: { ok: boolean; code: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // Ignore close errors.
        }
        resolve(result);
      };

      const timer = setTimeout(() => finish({ ok: false, code: -1 }), timeoutMs);

      ws.addEventListener("message", (event) => {
        const data = String(event.data);
        if (data.startsWith("0")) {
          ws.send("40");
          return;
        }
        if (data === "2") {
          ws.send("3");
          return;
        }
        if (data.startsWith("40")) {
          ws.send('42["stream_deck/join_room"]');
          ws.send('42["stream_deck/sync_settings"]');
          return;
        }
        if (data.startsWith("42")) {
          try {
            const [name, rawPayload] = JSON.parse(data.slice(2)) as [string, unknown];
            if (name === "stream_deck/sync_settings" && typeof rawPayload === "string") {
              const parsed = JSON.parse(rawPayload) as SyncSettingsPayload;
              const status = toStreamStatus(parsed.stream_status);
              if (status === targetStatus) {
                finish({ ok: true, code: 0 });
                return;
              }
              if (!actionSent && status !== null) {
                actionSent = true;
                const payload = JSON.stringify({ action, context: contextId, payload: {} });
                ws.send(`42${JSON.stringify(["stream_deck/action_emit", payload])}`);
              }
              return;
            }
            if (name === `stream_deck/${contextId}` && typeof rawPayload === "string") {
              const parsed = JSON.parse(rawPayload) as { code?: number };
              const code = typeof parsed.code === "number" ? parsed.code : -1;
              finish({ ok: code === 0, code });
            }
          } catch {
            // Ignore malformed packets.
          }
        }
      });

      ws.addEventListener("error", () => finish({ ok: false, code: -1 }));
      ws.addEventListener("close", () => finish({ ok: false, code: -1 }));
    });
  }
}
