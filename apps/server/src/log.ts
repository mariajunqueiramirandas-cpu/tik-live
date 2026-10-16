/**
 * Structured logging. JSON lines in production (one object per line, easy to
 * ship anywhere), readable lines in development. Sensitive keys are redacted
 * before anything is written.
 */

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /authorization|cookie|password|secret|token|stream.?key|api.?key|access.?key/i;

export interface LogEntry {
  level: Level;
  scope: string;
  msg: string;
  at: number;
  fields: Record<string, unknown>;
}

export type LogSink = (entry: LogEntry) => void;

const settings: { level: Level; format: "json" | "pretty" } = {
  level: (process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : "info",
  format: process.env.NODE_ENV === "production" ? "json" : "pretty",
};

export function configureLogging(options: Partial<typeof settings>): void {
  Object.assign(settings, options);
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(fields: Record<string, unknown>, sink?: LogSink): Logger;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return settings.format === "json" ? { name: value.name, message: value.message } : value.message;
  }
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE.test(key) ? "[redacted]" : redact(inner, depth + 1);
  }
  return out;
}

export function createLogger(scope: string, fields: Record<string, unknown> = {}, sinks: LogSink[] = []): Logger {
  const write = (level: Level, msg: string, extra?: unknown) => {
    if (ORDER[level] < ORDER[settings.level]) return;
    const at = Date.now();
    const detail = extra === undefined ? undefined : redact(extra);
    const entry: LogEntry = { level, scope, msg, at, fields };
    if (settings.format === "json") {
      const line = JSON.stringify({ t: new Date(at).toISOString(), level, scope, msg, ...fields, ...(detail !== undefined ? { detail } : {}) });
      (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
    } else {
      const time = new Date(at).toISOString().slice(11, 19);
      const context = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
      const tail = detail === undefined ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
      const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}${context}`;
      (level === "error" || level === "warn" ? console.error : console.log)(line);
    }
    if (sinks.length) {
      const sinkEntry = detail === undefined ? entry : { ...entry, msg: `${msg} ${typeof detail === "string" ? detail : JSON.stringify(detail)}` };
      for (const sink of sinks) sink(sinkEntry);
    }
  };
  return {
    debug: (msg, extra) => write("debug", msg, extra),
    info: (msg, extra) => write("info", msg, extra),
    warn: (msg, extra) => write("warn", msg, extra),
    error: (msg, extra) => write("error", msg, extra),
    child: (more, sink) => createLogger(scope, { ...fields, ...more }, sink ? [...sinks, sink] : sinks),
  };
}
