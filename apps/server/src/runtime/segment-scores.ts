import { FOCUS_MAX, FOCUS_MIN } from "@tik-live/shared";

/**
 * Which segments work on a channel (ADR-0044): how many viewers, likes and
 * diamonds each one pulls compared with the rest of the same stream, kept
 * across streams so the show can lean toward what the room responds to.
 *
 * Everything is measured against the stream it happened in, so a big Friday
 * stream and a quiet Tuesday one count the same: a segment scores well
 * because it did better than the show around it, not because more people
 * happened to be on. Lifts are in log2 units: +1 is twice the stream's
 * average, -1 half of it, 0 the same.
 */

/** What one segment did, from the moment it started to the moment it ended. */
export interface SegmentTake {
  ms: number;
  likes: number;
  diamonds: number;
  /** Viewers on average over the take (time-weighted). */
  viewersAvg: number;
  viewersStart: number;
  viewersEnd: number;
}

/** The whole stream so far, as the take's yardstick. */
export interface StreamBaseline {
  ms: number;
  likes: number;
  diamonds: number;
  viewersAvg: number;
}

export interface TakeScore {
  /** Weighted: viewers 40%, likes 30%, diamonds 30%. */
  score: number;
  viewers: number;
  likes: number;
  diamonds: number;
}

/** One segment's track record on the channel. */
export interface SegmentScore {
  key: string;
  /** The segment's title the last time it played, for the dashboard. */
  title: string;
  plays: number;
  minutes: number;
  /** Moving averages of each take's lifts, recent takes counting more. */
  score: number;
  viewers: number;
  likes: number;
  diamonds: number;
  /** When it last played. */
  at: number;
}

/** Where a channel's segment scores live between streams (Postgres in production). */
export interface SegmentScoresPersistence {
  save(scores: SegmentScore[]): Promise<void>;
}

/** A take shorter than this (a skipped segment, a stream that ended) says too little to learn from. */
export const MIN_TAKE_MS = 2 * 60_000;
/** Below this many viewers on average the room is empty: nothing to learn. */
const MIN_VIEWERS = 1;
/** Rates added to both sides of a lift, so a quiet stream's 1 like against 0 isn't "infinitely better". Per minute. */
const LIKE_PRIOR = 3;
const DIAMOND_PRIOR = 2;
/** A single lift never counts for more than 4x either way: one whale's gift shouldn't decide the show. */
const LIFT_CAP = 2;
/** Recent takes count at least this much in the moving average, so the show follows a changing audience. */
const MIN_ALPHA = 0.2;
/** Plays it takes before a score counts for half its value: one lucky take isn't a trend. */
const CONFIDENCE_PLAYS = 2;
/** How strongly a score turns into a weight: +1 (twice the average) is about 2.8x as likely to come up. */
const WEIGHT_GAIN = 1.5;
/** Segments kept per channel; past this the one played least recently goes. */
const MAX_SCORES = 64;

const WEIGHTS = { viewers: 0.4, likes: 0.3, diamonds: 0.3 } as const;

function lift(value: number, base: number): number {
  const ratio = Math.log2(Math.max(value, 0) / Math.max(base, Number.EPSILON));
  return Math.min(LIFT_CAP, Math.max(-LIFT_CAP, Number.isFinite(ratio) ? ratio : 0));
}

/**
 * How a take did against its stream. `trend` counts whether viewers came or
 * went during it; leave it out for a stream's first segment, when everyone
 * is still arriving whatever the host does.
 */
export function scoreTake(take: SegmentTake, base: StreamBaseline, trend = true): TakeScore | null {
  if (take.ms <= 0 || base.ms <= 0 || take.viewersAvg < MIN_VIEWERS) return null;
  const minutes = take.ms / 60_000;
  const baseMinutes = base.ms / 60_000;
  const average = lift(take.viewersAvg + 1, base.viewersAvg + 1);
  const came = lift(take.viewersEnd + 1, take.viewersStart + 1);
  const viewers = trend ? (average + came) / 2 : average;
  const likes = lift(take.likes / minutes + LIKE_PRIOR, base.likes / baseMinutes + LIKE_PRIOR);
  const diamonds = lift(take.diamonds / minutes + DIAMOND_PRIOR, base.diamonds / baseMinutes + DIAMOND_PRIOR);
  const score = WEIGHTS.viewers * viewers + WEIGHTS.likes * likes + WEIGHTS.diamonds * diamonds;
  return { score, viewers, likes, diamonds };
}

export interface SegmentScoresOptions {
  persistence?: SegmentScoresPersistence;
  now?: () => number;
}

/** A channel's segment track records, read from memory and written back in the background. */
export class SegmentScores {
  private scores: SegmentScore[];
  private dirty = false;
  private readonly now: () => number;

  constructor(
    initial: readonly SegmentScore[] = [],
    private readonly options: SegmentScoresOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.scores = initial.map((score) => ({ ...score }));
  }

  all(): readonly SegmentScore[] {
    return this.scores;
  }

  get(key: string): SegmentScore | undefined {
    return this.scores.find((score) => score.key === key);
  }

  /** Best first, by the score the show actually leans on (a one-off doesn't top the list). */
  ranked(): SegmentScore[] {
    return [...this.scores].sort((a, b) => confident(b) - confident(a) || b.plays - a.plays);
  }

  /** Folds one take into the segment's record. */
  record(key: string, title: string, minutes: number, take: TakeScore): SegmentScore {
    let entry = this.get(key);
    if (!entry) {
      entry = { key, title, plays: 0, minutes: 0, score: 0, viewers: 0, likes: 0, diamonds: 0, at: 0 };
      this.scores.push(entry);
    }
    entry.plays += 1;
    const alpha = Math.max(1 / entry.plays, MIN_ALPHA);
    entry.score += alpha * (take.score - entry.score);
    entry.viewers += alpha * (take.viewers - entry.viewers);
    entry.likes += alpha * (take.likes - entry.likes);
    entry.diamonds += alpha * (take.diamonds - entry.diamonds);
    entry.minutes = Math.round((entry.minutes + minutes) * 10) / 10;
    entry.title = title;
    entry.at = this.now();
    if (this.scores.length > MAX_SCORES) this.scores = [...this.scores].sort((a, b) => b.at - a.at).slice(0, MAX_SCORES);
    this.dirty = true;
    return entry;
  }

  /** How much the show leans toward a segment: 1 when it's new or average, more when it works, less when it doesn't. */
  weight(key: string): number {
    const entry = this.get(key);
    if (!entry) return 1;
    return Math.min(FOCUS_MAX, Math.max(FOCUS_MIN, 2 ** (WEIGHT_GAIN * confident(entry))));
  }

  /**
   * A line for the host's brief about a segment that's starting, when its
   * record says something: what it's good at, or that it loses the room.
   */
  describe(key: string): string | undefined {
    const entry = this.get(key);
    if (!entry || entry.plays < CONFIDENCE_PLAYS) return undefined;
    const weight = this.weight(key);
    if (weight >= 1.4) {
      const best = strongest(entry);
      return `on this channel, "${entry.title}" is one of your best segments (${best}). Go all in on it.`;
    }
    if (weight <= 0.7) {
      return `on this channel, "${entry.title}" tends to lose the room (${weakest(entry)}). Keep it punchy and fast, bring chat in right away and play to whatever they react to.`;
    }
    return undefined;
  }

  /** Writes the scores if they changed. Failures keep them dirty for the next flush. */
  async flush(): Promise<void> {
    if (!this.dirty || !this.options.persistence) return;
    this.dirty = false;
    try {
      await this.options.persistence.save(this.scores.map((score) => ({ ...score })));
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }
}

/** The score, shrunk toward average until the segment has played a few times. */
function confident(entry: SegmentScore): number {
  return entry.score * (entry.plays / (entry.plays + CONFIDENCE_PLAYS));
}

const METRIC_WORDS = { viewers: "viewers", likes: "likes", diamonds: "gifts" } as const;

function strongest(entry: SegmentScore): string {
  const metrics = (["viewers", "likes", "diamonds"] as const).filter((m) => entry[m] >= 0.3).sort((a, b) => entry[b] - entry[a]);
  return metrics.length ? `more ${metrics.map((m) => METRIC_WORDS[m]).join(" and ")} than the rest of the show` : "the room loves it";
}

function weakest(entry: SegmentScore): string {
  const metrics = (["viewers", "likes", "diamonds"] as const).filter((m) => entry[m] <= -0.3).sort((a, b) => entry[a] - entry[b]);
  return metrics.length ? `fewer ${metrics.map((m) => METRIC_WORDS[m]).join(" and ")} than the rest of the show` : "the room goes quiet";
}

/**
 * Measures the stream and the segment on air: likes, diamonds, and viewers
 * over time (viewer-milliseconds, so the average is time-weighted). The
 * director feeds it events and asks for the take when a segment ends.
 */
export class SegmentMeter {
  private stream = { startedAt: 0, likes: 0, diamonds: 0, viewerMs: 0 };
  private take = { startedAt: 0, likes: 0, diamonds: 0, viewerMs: 0, viewersStart: 0 };
  private viewers = 0;
  private viewersAt = 0;
  /** Segments that ended this stream; the first one's viewer trend is everyone arriving. */
  private takes = 0;
  private live = false;

  /** A stream starts (or restarts): both the stream and the segment on air begin now. */
  startStream(now: number, viewers: number): void {
    this.viewers = viewers;
    this.viewersAt = now;
    this.stream = { startedAt: now, likes: 0, diamonds: 0, viewerMs: 0 };
    this.takes = 0;
    this.live = true;
    this.startSegment(now);
  }

  /** The stream ended: nothing more to measure until the next one. */
  endStream(): void {
    this.live = false;
  }

  startSegment(now: number): void {
    this.integrate(now);
    this.take = { startedAt: now, likes: 0, diamonds: 0, viewerMs: 0, viewersStart: this.viewers };
  }

  setViewers(count: number, now: number): void {
    this.integrate(now);
    this.viewers = count;
  }

  like(count: number): void {
    this.stream.likes += count;
    this.take.likes += count;
  }

  gift(diamonds: number): void {
    this.stream.diamonds += diamonds;
    this.take.diamonds += diamonds;
  }

  /** How the segment on air is doing against the stream so far, or null when there's too little to say. */
  current(now: number, minMs = MIN_TAKE_MS): TakeScore | null {
    if (!this.live) return null;
    this.integrate(now);
    const take = this.snapshotTake(now);
    if (take.ms < minMs) return null;
    return scoreTake(take, this.baseline(now), this.takes > 0);
  }

  /** The segment on air ended: its take and score (null when it was too short or the room empty), and the next one starts. */
  endSegment(now: number): { take: SegmentTake; score: TakeScore } | null {
    if (!this.live) return null;
    this.integrate(now);
    const take = this.snapshotTake(now);
    const score = take.ms >= MIN_TAKE_MS ? scoreTake(take, this.baseline(now), this.takes > 0) : null;
    if (take.ms >= MIN_TAKE_MS) this.takes += 1;
    this.startSegment(now);
    return score ? { take, score } : null;
  }

  private snapshotTake(now: number): SegmentTake {
    const ms = now - this.take.startedAt;
    return {
      ms,
      likes: this.take.likes,
      diamonds: this.take.diamonds,
      viewersAvg: ms > 0 ? this.take.viewerMs / ms : this.viewers,
      viewersStart: this.take.viewersStart,
      viewersEnd: this.viewers,
    };
  }

  private baseline(now: number): StreamBaseline {
    const ms = now - this.stream.startedAt;
    return { ms, likes: this.stream.likes, diamonds: this.stream.diamonds, viewersAvg: ms > 0 ? this.stream.viewerMs / ms : this.viewers };
  }

  private integrate(now: number): void {
    const dt = Math.max(0, now - this.viewersAt);
    this.viewersAt = now;
    this.stream.viewerMs += this.viewers * dt;
    this.take.viewerMs += this.viewers * dt;
  }
}
