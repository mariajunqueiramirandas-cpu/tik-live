import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? order.info;

export type LogSink = (entry: { level: Level; scope: string; msg: string; at: number }) => void;
const sinks: LogSink[] = [];

/** Lets the control panel mirror the log. */
export function addLogSink(sink: LogSink): void {
  sinks.push(sink);
}

export function createLogger(scope: string) {
  const write = (level: Level, msg: string, extra?: unknown) => {
    if (order[level] < threshold) return;
    const at = Date.now();
    const time = new Date(at).toISOString().slice(11, 19);
    const tail = extra === undefined ? "" : ` ${formatExtra(extra)}`;
    const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`;
    (level === "error" || level === "warn" ? console.error : console.log)(line);
    for (const sink of sinks) sink({ level, scope, msg: msg + tail, at });
  };
  return {
    debug: (msg: string, extra?: unknown) => write("debug", msg, extra),
    info: (msg: string, extra?: unknown) => write("info", msg, extra),
    warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
    error: (msg: string, extra?: unknown) => write("error", msg, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;

function formatExtra(extra: unknown): string {
  if (extra instanceof Error) return extra.message;
  if (typeof extra === "string") return extra;
  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

/**
 * Append-only JSONL record of everything that happened on stream: events,
 * host lines, viewer counts. This is the raw material for analytics and for
 * tuning personas/segments later.
 */
export class SessionRecorder {
  private readonly file: string | undefined;

  constructor(dataDir: string | undefined) {
    if (!dataDir) return;
    const dir = path.join(dataDir, "sessions");
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  }

  record(type: string, data: unknown): void {
    if (!this.file) return;
    try {
      appendFileSync(this.file, JSON.stringify({ t: Date.now(), type, data }) + "\n");
    } catch {
      // Recording is best-effort; never take the show down over a log write.
    }
  }
}
