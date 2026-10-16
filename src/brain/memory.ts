import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LiveEvent, Viewer } from "../events/types.js";

export interface ViewerRecord {
  id: string;
  handle: string;
  nickname: string;
  firstSeen: number;
  lastSeen: number;
  /** Number of separate streams this viewer showed up in. */
  visits: number;
  messages: number;
  diamonds: number;
  gifts: Record<string, number>;
  follows: number;
  shares: number;
  /** A few recent things they said, newest last. */
  recentLines: string[];
}

/** A gap longer than this between two sightings counts as a new visit. */
const NEW_VISIT_GAP_MS = 3 * 60 * 60 * 1000;
const RECENT_LINES = 3;

/**
 * Remembers every viewer across streams so the host can greet regulars by
 * name and remember what they gifted or said last time. Stored as a JSON file
 * with atomic writes; swap for SQLite/Postgres when audiences get large.
 */
export class ViewerMemory {
  private readonly viewers = new Map<string, ViewerRecord>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly file: string | undefined;

  constructor(dataDir?: string, private readonly now: () => number = Date.now) {
    if (!dataDir) return;
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "viewers.json");
    if (existsSync(this.file)) {
      const stored = JSON.parse(readFileSync(this.file, "utf8")) as ViewerRecord[];
      for (const record of stored) this.viewers.set(record.id, record);
    }
  }

  get size(): number {
    return this.viewers.size;
  }

  get(id: string): ViewerRecord | undefined {
    return this.viewers.get(id);
  }

  observe(event: LiveEvent): ViewerRecord | undefined {
    if (!("viewer" in event)) return undefined;
    const record = this.touch(event.viewer);
    switch (event.kind) {
      case "chat":
      case "question":
        record.messages += 1;
        record.recentLines = [...record.recentLines, event.text.slice(0, 140)].slice(-RECENT_LINES);
        break;
      case "gift":
        record.diamonds += event.diamonds;
        record.gifts[event.giftName] = (record.gifts[event.giftName] ?? 0) + event.count;
        break;
      case "follow":
        record.follows += 1;
        break;
      case "share":
        record.shares += 1;
        break;
      default:
        break;
    }
    this.markDirty();
    return record;
  }

  /** True when this viewer has been here on a previous stream. */
  isReturning(id: string): boolean {
    return (this.viewers.get(id)?.visits ?? 0) > 1;
  }

  /** One-line summary for the host prompt, e.g. "returning (4 visits), gifted 340 diamonds". */
  describe(id: string): string {
    const r = this.viewers.get(id);
    if (!r) return "new viewer";
    const parts: string[] = [];
    parts.push(r.visits > 1 ? `returning viewer (${r.visits} streams)` : "first stream with us");
    if (r.diamonds > 0) {
      const top = Object.entries(r.gifts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([name, count]) => `${count}x ${name}`)
        .join(", ");
      parts.push(`has gifted ${r.diamonds} diamonds total (${top})`);
    }
    if (r.follows > 0) parts.push("follows the channel");
    return parts.join("; ");
  }

  flush(): void {
    if (!this.file || !this.dirty) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.viewers.values()]));
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  close(): void {
    clearTimeout(this.saveTimer);
    this.flush();
  }

  private touch(viewer: Viewer): ViewerRecord {
    const now = this.now();
    let record = this.viewers.get(viewer.id);
    if (!record) {
      record = {
        id: viewer.id,
        handle: viewer.handle,
        nickname: viewer.nickname,
        firstSeen: now,
        lastSeen: now,
        visits: 1,
        messages: 0,
        diamonds: 0,
        gifts: {},
        follows: 0,
        shares: 0,
        recentLines: [],
      };
      this.viewers.set(viewer.id, record);
      return record;
    }
    if (now - record.lastSeen > NEW_VISIT_GAP_MS) record.visits += 1;
    record.lastSeen = now;
    record.handle = viewer.handle || record.handle;
    record.nickname = viewer.nickname || record.nickname;
    return record;
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      try {
        this.flush();
      } catch {
        // Retry on the next change; memory loss is preferable to a crash.
      }
    }, 5_000);
    this.saveTimer.unref();
  }
}
