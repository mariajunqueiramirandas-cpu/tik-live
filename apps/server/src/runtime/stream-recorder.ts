import { estimateCostUsd, type ChannelSource, type LiveEvent } from "@tik-live/shared";
import type { Db } from "../db/client";
import type { Logger } from "../log";
import {
  closeOrphanedSessions,
  createSession,
  endSession,
  insertUtterances,
  setSessionSummary,
  updateSessionTotals,
  upsertSamples,
  type NewUtterance,
  type SampleRow,
  type SessionTotals,
} from "../repos/streams";
import type { StreamStats } from "./brain/director";
import type { UsageReport } from "./usage";

interface MinuteBucket {
  viewers: number;
  likes: number;
  messages: number;
  diamonds: number;
}

/**
 * Turns one live stream into analytics: a `stream_session` row, per-minute
 * samples and the host's spoken and blocked lines. Everything is buffered and
 * written in batches (ADR-0005), never on the speech path.
 */
export class StreamRecorder {
  private sessionId: string | null = null;
  private startedAt: Date | null = null;
  private buckets = new Map<number, MinuteBucket>();
  private utterances: NewUtterance[] = [];
  private counts = { turns: 0, spokenLines: 0, blockedLines: 0, inputTokens: 0, outputTokens: 0, ttsCharacters: 0, costUsd: 0 };
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly channelId: string,
    private readonly source: ChannelSource,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  get current(): { id: string; startedAt: string } | null {
    return this.sessionId && this.startedAt ? { id: this.sessionId, startedAt: this.startedAt.toISOString() } : null;
  }

  async begin(): Promise<void> {
    if (this.sessionId) return;
    const id = Bun.randomUUIDv7();
    const startedAt = new Date(this.now());
    this.sessionId = id;
    this.startedAt = startedAt;
    this.buckets.clear();
    this.utterances = [];
    this.counts = { turns: 0, spokenLines: 0, blockedLines: 0, inputTokens: 0, outputTokens: 0, ttsCharacters: 0, costUsd: 0 };
    await this.serialize(async () => {
      await closeOrphanedSessions(this.db, this.channelId, startedAt);
      await createSession(this.db, { id, channelId: this.channelId, startedAt, source: this.source });
    });
  }

  observe(event: LiveEvent): void {
    if (!this.sessionId) return;
    const bucket = this.bucket();
    switch (event.kind) {
      case "viewers":
        bucket.viewers = Math.max(bucket.viewers, event.count);
        break;
      case "like":
        bucket.likes += event.count;
        break;
      case "chat":
      case "question":
        bucket.messages += 1;
        break;
      case "gift":
        bucket.diamonds += event.diamonds;
        break;
      default:
        break;
    }
  }

  countTurn(): void {
    if (this.sessionId) this.counts.turns += 1;
  }

  addUsage(report: UsageReport): void {
    if (!this.sessionId) return;
    if (report.kind === "tts") {
      this.counts.ttsCharacters += report.characters;
      return;
    }
    this.counts.inputTokens += report.inputTokens + report.cacheReadTokens + report.cacheWriteTokens;
    this.counts.outputTokens += report.outputTokens;
    this.counts.costUsd += estimateCostUsd(report.model, report);
  }

  line(entry: { text: string; emotion: string; status: "spoken" | "blocked"; reason?: string; turnKind?: string }): void {
    if (!this.sessionId) return;
    if (entry.status === "spoken") this.counts.spokenLines += 1;
    else this.counts.blockedLines += 1;
    this.utterances.push({
      sessionId: this.sessionId,
      channelId: this.channelId,
      at: new Date(this.now()),
      text: entry.text,
      emotion: entry.emotion,
      status: entry.status,
      reason: entry.reason ?? null,
      turnKind: entry.turnKind ?? null,
    });
  }

  /** Keeps the host's show summary with the session, for the next stream's opening. */
  summary(text: string): void {
    const id = this.sessionId;
    if (!id) return;
    // serialize() logs a failed write; nothing else to do with it here.
    this.serialize(() => setSessionSummary(this.db, id, text.slice(0, 2_000))).catch(() => undefined);
  }

  /** Writes buffered samples, lines and running totals. */
  async flush(stats: StreamStats): Promise<void> {
    const id = this.sessionId;
    if (!id) return;
    const samples = this.drainBuckets(id);
    const lines = this.utterances;
    this.utterances = [];
    const totals = this.totals(stats);
    await this.serialize(async () => {
      await upsertSamples(this.db, samples);
      await insertUtterances(this.db, lines);
      await updateSessionTotals(this.db, id, totals);
    });
  }

  async end(reason: string, stats: StreamStats): Promise<void> {
    const id = this.sessionId;
    if (!id) return;
    await this.flush(stats);
    this.sessionId = null;
    const endedAt = new Date(this.now());
    const totals = this.totals(stats);
    await this.serialize(() => endSession(this.db, id, endedAt, reason, totals));
  }

  private totals(stats: StreamStats): SessionTotals {
    return {
      peakViewers: stats.peakViewers,
      likes: stats.likes,
      diamonds: stats.diamonds,
      gifts: stats.gifts,
      messages: stats.messages,
      follows: stats.follows,
      shares: stats.shares,
      joins: stats.joins,
      ...this.counts,
    };
  }

  private bucket(): MinuteBucket {
    const minute = Math.floor(this.now() / 60_000) * 60_000;
    let bucket = this.buckets.get(minute);
    if (!bucket) {
      bucket = { viewers: 0, likes: 0, messages: 0, diamonds: 0 };
      this.buckets.set(minute, bucket);
    }
    return bucket;
  }

  private drainBuckets(sessionId: string): SampleRow[] {
    const rows: SampleRow[] = [];
    for (const [minute, bucket] of this.buckets) rows.push({ sessionId, minute: new Date(minute), ...bucket });
    this.buckets.clear();
    return rows;
  }

  /** Writes happen one at a time so totals never go backwards. */
  private serialize(task: () => Promise<void>): Promise<void> {
    const next = this.writing.then(task, task);
    this.writing = next.catch((err) => this.log.warn("analytics write failed", err));
    return next;
  }
}
