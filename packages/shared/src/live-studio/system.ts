import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const STUDIO_IMAGE = "TikTok LIVE Studio.exe";

/** What the controller asks of the PC, so tests can stand in for it. */
export interface StudioSystem {
  /** Studio's process is running. */
  isStudioRunning(): Promise<boolean>;
  /** Loopback TCP ports Studio's processes listen on, for when it isn't on one of the usual ports. */
  studioPorts(): Promise<number[]>;
  isPortOpen(host: string, port: number): Promise<boolean>;
  launch(executablePath: string): void;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

async function studioPids(): Promise<Set<string>> {
  const out = await run("tasklist", ["/FI", `IMAGENAME eq ${STUDIO_IMAGE}`, "/FO", "CSV", "/NH"]);
  const pids = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const pid = line.match(/^"[^"]*","(\d+)"/)?.[1];
    if (pid) pids.add(pid);
  }
  return pids;
}

export function isTcpPortOpen(host: string, port: number, timeoutMs = 250): Promise<boolean> {
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

/** The real PC. Process and port lookups only work on Windows, where Studio runs. */
export const windowsStudioSystem: StudioSystem = {
  async isStudioRunning() {
    if (process.platform !== "win32") return false;
    return (await studioPids()).size > 0;
  },
  async studioPorts() {
    if (process.platform !== "win32") return [];
    const pids = await studioPids();
    if (pids.size === 0) return [];
    const out = await run("netstat", ["-ano", "-p", "TCP"]);
    const ports = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      // Proto, Local Address, Foreign Address, State, PID. The state is localized, so match on the PID and an idle foreign address.
      if (cols.length < 5 || cols[0] !== "TCP" || !pids.has(cols[4]!)) continue;
      if (!/^(0\.0\.0\.0|\[::\]|127\.0\.0\.1|\[::1\]):\d+$/.test(cols[1]!) || !/:0$/.test(cols[2]!)) continue;
      const port = Number(cols[1]!.slice(cols[1]!.lastIndexOf(":") + 1));
      if (port > 0) ports.add(port);
    }
    return [...ports];
  },
  isPortOpen: (host, port) => isTcpPortOpen(host, port),
  launch(executablePath) {
    const child = spawn(executablePath, [], { cwd: path.dirname(executablePath), detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
  },
};

/** For tests and servers that must never touch a real Studio: nothing runs, nothing listens. */
export const inertStudioSystem: StudioSystem = {
  isStudioRunning: async () => false,
  studioPorts: async () => [],
  isPortOpen: (host, port) => isTcpPortOpen(host, port),
  launch() {
    throw new Error("Não é possível abrir o TikTok LIVE Studio aqui.");
  },
};

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
          const versionedExe = path.join(root, parsed.cur_path, STUDIO_IMAGE);
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
        const candidate = path.join(root, entry.name, STUDIO_IMAGE);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Ignore unreadable directories.
    }
    const launcherExe = path.join(root, "TikTok LIVE Studio Launcher.exe");
    if (existsSync(launcherExe)) return launcherExe;
    const directExe = path.join(root, STUDIO_IMAGE);
    if (existsSync(directExe)) return directExe;
  }
  return null;
}
