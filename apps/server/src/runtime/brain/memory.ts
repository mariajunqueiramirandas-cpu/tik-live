import { clip, type LiveEvent, type Viewer } from "@tik-live/shared";
import type { Logger } from "../../log";
import { checkChatInput } from "../safety/rules";

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
  /** Harmless things they shared, as "topic: fact" (older notes may have no topic), newest last. */
  notes: string[];
}

/** Where viewer records live between streams (Postgres in production). */
export interface ViewerPersistence {
  load(ids: string[]): Promise<ViewerRecord[]>;
  save(records: ViewerRecord[]): Promise<void>;
}

/** A gap longer than this between two sightings counts as a new visit. */
export const NEW_VISIT_GAP_MS = 3 * 60 * 60 * 1000;
const RECENT_LINES = 3;
const MAX_NOTES = 8;
/** How many notes the host reads about a viewer at once (the newest). */
const NOTES_SHOWN = 4;
const TOPIC_MAX = 30;
const MAX_CACHED = 20_000;

export interface ViewerMemoryOptions {
  persistence?: ViewerPersistence;
  now?: () => number;
  log?: Logger;
}

/**
 * Remembers every viewer across streams so the host can greet regulars by
 * name and remember what they gifted or said last time.
 *
 * Reads and writes are synchronous against an in-memory cache. A viewer seen
 * for the first time this run is loaded from persistence in the background
 * (batched) and merged with whatever happened in the meantime; dirty records
 * are written back by `flush()`, which the runtime calls every few seconds.
 */
export class ViewerMemory {
  private readonly viewers = new Map<string, ViewerRecord>();
  private readonly dirty = new Set<string>();
  private readonly toLoad = new Set<string>();
  private readonly loaded = new Set<string>();
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: ViewerMemoryOptions = {}) {
    this.now = options.now ?? Date.now;
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
        // The host reads these on later streams ("once said"): never a line the rules kept from it today.
        if (checkChatInput(event.text, []).ok) record.recentLines = [...record.recentLines, clip(event.text, 140)].slice(-RECENT_LINES);
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
    this.dirty.add(record.id);
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
    if (r.notes.length > 0) parts.push(`notes: ${r.notes.slice(-NOTES_SHOWN).join("; ")}`);
    if (r.visits > 1 && r.recentLines.length > 0) {
      parts.push(`once said: ${r.recentLines.slice(-2).map((line) => `"${clip(line, 60)}"`).join(", ")}`);
    }
    return parts.join("; ");
  }

  /**
   * Remembers something harmless a viewer shared (the chronicler's notes).
   * A note on a topic the viewer already has replaces the old one (they got a
   * new pet, changed teams), so the host never reads two answers to the same
   * thing. Keeps the newest few.
   */
  addNote(id: string, note: string, topic?: string): void {
    const record = this.viewers.get(id);
    const fact = note.trim();
    if (!record || !fact) return;
    const key = topic === undefined ? undefined : cleanTopic(topic);
    record.notes = withNote(record.notes, key ? `${key}: ${fact}` : fact);
    this.dirty.add(id);
  }

  /** Resolves when background loads queued so far have completed. */
  async settled(): Promise<void> {
    if (this.loadTimer) {
      clearTimeout(this.loadTimer);
      this.loadTimer = undefined;
      this.inflight = this.inflight.then(() => this.loadBatch());
    }
    await this.inflight;
  }

  /** Writes dirty records. Safe to call concurrently; failures keep records dirty. */
  async flush(): Promise<void> {
    const persistence = this.options.persistence;
    if (!persistence || this.dirty.size === 0) return;
    await this.settled();
    const ids = [...this.dirty];
    this.dirty.clear();
    const records = ids.map((id) => this.viewers.get(id)).filter((r): r is ViewerRecord => Boolean(r));
    try {
      await persistence.save(records);
    } catch (err) {
      for (const id of ids) this.dirty.add(id);
      throw err;
    }
    this.evict();
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
        notes: [],
      };
      this.viewers.set(viewer.id, record);
      this.queueLoad(viewer.id);
      return record;
    }
    if (now - record.lastSeen > NEW_VISIT_GAP_MS) record.visits += 1;
    record.lastSeen = now;
    record.handle = viewer.handle || record.handle;
    record.nickname = viewer.nickname || record.nickname;
    return record;
  }

  private queueLoad(id: string): void {
    if (!this.options.persistence || this.loaded.has(id)) return;
    this.toLoad.add(id);
    if (!this.loadTimer) {
      this.loadTimer = setTimeout(() => {
        this.loadTimer = undefined;
        this.inflight = this.inflight.then(() => this.loadBatch());
      }, 25);
    }
  }

  private async loadBatch(): Promise<void> {
    const ids = [...this.toLoad];
    this.toLoad.clear();
    if (ids.length === 0 || !this.options.persistence) return;
    for (const id of ids) this.loaded.add(id);
    try {
      const rows = await this.options.persistence.load(ids);
      for (const row of rows) this.merge(row);
    } catch (err) {
      this.options.log?.warn("could not load viewer memory", err);
    }
  }

  /** Combines the stored history with whatever this run observed before the load finished. */
  private merge(stored: ViewerRecord): void {
    const current = this.viewers.get(stored.id);
    if (!current) {
      this.viewers.set(stored.id, stored);
      return;
    }
    const gifts = { ...stored.gifts };
    for (const [name, count] of Object.entries(current.gifts)) gifts[name] = (gifts[name] ?? 0) + count;
    this.viewers.set(stored.id, {
      ...stored,
      handle: current.handle || stored.handle,
      nickname: current.nickname || stored.nickname,
      lastSeen: Math.max(current.lastSeen, stored.lastSeen),
      visits: stored.visits + (current.firstSeen - stored.lastSeen > NEW_VISIT_GAP_MS ? 1 : 0),
      messages: stored.messages + current.messages,
      diamonds: stored.diamonds + current.diamonds,
      gifts,
      follows: stored.follows + current.follows,
      shares: stored.shares + current.shares,
      recentLines: [...stored.recentLines, ...current.recentLines].slice(-RECENT_LINES),
      notes: current.notes.reduce(withNote, stored.notes),
    });
  }

  /** Keeps memory bounded on huge streams: drops the least recently seen clean records. */
  private evict(): void {
    if (this.viewers.size <= MAX_CACHED) return;
    const clean = [...this.viewers.values()].filter((r) => !this.dirty.has(r.id)).sort((a, b) => a.lastSeen - b.lastSeen);
    for (const record of clean.slice(0, this.viewers.size - MAX_CACHED)) {
      this.viewers.delete(record.id);
      this.loaded.delete(record.id);
    }
  }
}

/** A note's topic ("pet" in "pet: a dog called Thor"), lowercase, or undefined for a note without one. */
export function noteTopic(note: string): string | undefined {
  const at = note.indexOf(": ");
  return at > 0 ? cleanTopic(note.slice(0, at)) : undefined;
}

/** "Favorite  Food" -> "favorite food"; undefined when empty or too long to be a topic. */
export function cleanTopic(topic: string): string | undefined {
  const clean = topic.trim().toLowerCase().replace(/\s+/g, " ");
  return clean && clean.length <= TOPIC_MAX ? clean : undefined;
}

/** `notes` with `note` added last: an exact repeat stays where it is, and a note on the same topic replaces the old one. */
function withNote(notes: string[], note: string): string[] {
  const lower = note.toLowerCase();
  if (notes.some((existing) => existing.toLowerCase() === lower)) return notes;
  const topic = noteTopic(note);
  const kept = topic ? notes.filter((existing) => noteTopic(existing) !== topic) : notes;
  return [...kept, note].slice(-MAX_NOTES);
}
