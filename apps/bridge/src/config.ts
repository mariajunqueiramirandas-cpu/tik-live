import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** What the agent remembers between runs. */
export interface SavedBridgeConfig {
  /** The app's address, e.g. `https://lantern.example`. */
  server?: string;
  /** The device token from pairing (ADR-0047). */
  token?: string;
  channelName?: string;
  /** The stamped pairing code already used, so a copy doesn't retry it on every run. */
  usedCode?: string;
  /** Stage link, from agents before pairing. */
  url?: string;
}

/** %APPDATA% first: the token shouldn't sit next to the .exe in Downloads. */
function configFilePaths(): string[] {
  const appData = process.env.APPDATA ? path.join(process.env.APPDATA, "Lantern", "bridge.json") : null;
  const localPath = path.join(path.dirname(process.execPath), "lantern-bridge.json");
  return appData ? [appData, localPath] : [localPath];
}

export function loadConfig(): SavedBridgeConfig {
  for (const file of configFilePaths()) {
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as SavedBridgeConfig;
    } catch {
      // Ignore invalid config files.
    }
  }
  return {};
}

export function saveConfig(config: SavedBridgeConfig): void {
  for (const target of configFilePaths()) {
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(config, null, 2), "utf8");
      return;
    } catch {
      // Try next candidate path.
    }
  }
}
