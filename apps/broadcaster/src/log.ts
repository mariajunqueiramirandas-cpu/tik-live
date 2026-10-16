/** Minimal structured logger: JSON lines in production, readable lines otherwise. */
export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(options: { level?: Level; json?: boolean; base?: Record<string, unknown>; sink?: (line: string) => void } = {}): Logger {
  const min = ORDER[options.level ?? "info"];
  const sink = options.sink ?? ((line: string) => console.log(line));
  const base = options.base ?? {};
  const write = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < min) return;
    const all = { ...base, ...fields };
    if (options.json) sink(JSON.stringify({ at: new Date().toISOString(), level, msg, ...all }));
    else sink(`${new Date().toISOString().slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${msg}${Object.keys(all).length ? ` ${JSON.stringify(all)}` : ""}`);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}
