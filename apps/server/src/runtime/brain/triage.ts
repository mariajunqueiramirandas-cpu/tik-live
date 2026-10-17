import type { LiveEvent } from "@tik-live/shared";
import { checkChatInput } from "../safety/rules";
import type { ViewerMemory } from "./memory";

export interface QueueItem {
  event: LiveEvent;
  priority: number;
  expiresAt: number;
}

export type TriageResult = { queued: true; item: QueueItem } | { queued: false; reason: string };

export interface TriageOptions {
  blocklist: readonly string[];
  hostName: string;
  memory: ViewerMemory;
  now?: () => number;
  maxQueue?: number;
}

/** How long each kind of event stays worth reacting to. Old chat is worse than no reply. */
const TTL_MS: Partial<Record<LiveEvent["kind"], number>> = {
  chat: 25_000,
  question: 60_000,
  gift: 120_000,
  follow: 60_000,
  share: 60_000,
  join: 20_000,
};

const FLOOD_WINDOW_MS = 15_000;
const FLOOD_MAX_MESSAGES = 3;
const DUPLICATE_WINDOW_MS = 60_000;

/**
 * Decides which audience events deserve the host's attention, and in what
 * order. Filters spam, links and injection attempts; scores the rest; and
 * expires anything that got stale while the host was talking.
 */
export class Triage {
  private queue: QueueItem[] = [];
  private readonly history = new Map<string, Array<{ text: string; at: number }>>();
  private readonly now: () => number;
  readonly dropped = new Map<string, number>();

  constructor(private readonly options: TriageOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Applies new safety settings or a renamed host without restarting the show. */
  reconfigure(update: { blocklist?: readonly string[]; hostName?: string }): void {
    if (update.blocklist) this.options.blocklist = update.blocklist;
    if (update.hostName) this.options.hostName = update.hostName;
  }

  ingest(event: LiveEvent): TriageResult {
    const priority = this.score(event);
    if (typeof priority === "string") return this.drop(priority);

    const ttl = TTL_MS[event.kind];
    if (ttl === undefined) return this.drop("not queueable");

    if ((event.kind === "chat" || event.kind === "question") && this.isDuplicateQueued(event.text)) {
      return this.drop("duplicate of queued message");
    }

    if (event.kind === "gift") {
      const merged = this.mergeGift(event, ttl);
      if (merged) return { queued: true, item: merged };
    }

    const item: QueueItem = { event, priority, expiresAt: this.now() + ttl };
    this.queue.push(item);
    this.queue.sort((a, b) => b.priority - a.priority);
    const max = this.options.maxQueue ?? 50;
    if (this.queue.length > max) this.queue.length = max;
    return { queued: true, item };
  }

  /** Removes and returns up to `max` of the most important live items. */
  take(max: number): QueueItem[] {
    this.prune();
    return this.queue.splice(0, max);
  }

  /** Removes and returns all pending items of the given kinds (e.g. to batch thank-yous). */
  takeKinds(kinds: ReadonlyArray<LiveEvent["kind"]>, max = Infinity): QueueItem[] {
    this.prune();
    const taken: QueueItem[] = [];
    this.queue = this.queue.filter((item) => {
      if (taken.length < max && kinds.includes(item.event.kind)) {
        taken.push(item);
        return false;
      }
      return true;
    });
    return taken;
  }

  pending(): number {
    this.prune();
    return this.queue.length;
  }

  peek(): readonly QueueItem[] {
    this.prune();
    return this.queue;
  }

  clear(): void {
    this.queue = [];
  }

  private prune(): void {
    const now = this.now();
    this.queue = this.queue.filter((item) => item.expiresAt > now);
  }

  private drop(reason: string): TriageResult {
    this.dropped.set(reason, (this.dropped.get(reason) ?? 0) + 1);
    return { queued: false, reason };
  }

  /** Returns a priority, or a string explaining why the event is dropped. */
  private score(event: LiveEvent): number | string {
    const memory = this.options.memory;
    switch (event.kind) {
      case "gift":
        return 100 + 15 * Math.log10(event.diamonds + 1);
      case "share":
        return 50;
      case "follow":
        return 45;
      case "join":
        return memory.isReturning(event.viewer.id) ? 25 : "join from new viewer";
      case "question":
      case "chat": {
        const verdict = checkChatInput(event.text, this.options.blocklist);
        if (!verdict.ok) return verdict.reason;
        const flood = this.checkFlood(event.viewer.id, event.text);
        if (flood) return flood;
        let priority = event.kind === "question" ? 70 : 40;
        const text = event.text.toLowerCase();
        if (text.includes("?")) priority += 15;
        if (text.includes(this.options.hostName.toLowerCase())) priority += 15;
        const record = memory.get(event.viewer.id);
        if (record && record.visits > 1) priority += 10;
        if (record && record.messages <= 1) priority += 5;
        if (text.replace(/[^\p{L}\p{N}]/gu, "").length < 4) priority -= 15;
        return priority;
      }
      default:
        return "not queueable";
    }
  }

  private checkFlood(viewerId: string, text: string): string | undefined {
    const now = this.now();
    const normalized = text.trim().toLowerCase();
    const recent = (this.history.get(viewerId) ?? []).filter((m) => now - m.at < DUPLICATE_WINDOW_MS);
    const inWindow = recent.filter((m) => now - m.at < FLOOD_WINDOW_MS);
    const repeated = recent.some((m) => m.text === normalized);
    recent.push({ text: normalized, at: now });
    this.history.set(viewerId, recent);
    if (this.history.size > 5_000) this.history.delete(this.history.keys().next().value as string);
    if (repeated) return "repeated message";
    if (inWindow.length >= FLOOD_MAX_MESSAGES) return "flooding";
    return undefined;
  }

  /**
   * Folds a gift into one already waiting from the same viewer (same gift),
   * so a burst of roses becomes one "ten roses" thank-you, not ten.
   */
  private mergeGift(event: Extract<LiveEvent, { kind: "gift" }>, ttl: number): QueueItem | undefined {
    this.prune();
    const index = this.queue.findIndex(
      (item) => item.event.kind === "gift" && item.event.viewer.id === event.viewer.id && item.event.giftName === event.giftName,
    );
    const item = this.queue[index];
    if (!item || item.event.kind !== "gift") return undefined;
    const combined: LiveEvent = { ...item.event, count: item.event.count + event.count, diamonds: item.event.diamonds + event.diamonds };
    const merged: QueueItem = { event: combined, priority: this.score(combined) as number, expiresAt: this.now() + ttl };
    this.queue[index] = merged;
    this.queue.sort((a, b) => b.priority - a.priority);
    return merged;
  }

  private isDuplicateQueued(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return this.queue.some(
      (item) =>
        (item.event.kind === "chat" || item.event.kind === "question") &&
        item.event.text.trim().toLowerCase() === normalized,
    );
  }
}
