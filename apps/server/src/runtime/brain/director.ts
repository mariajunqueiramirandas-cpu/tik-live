import type { LiveEvent, Persona, Segment } from "@tik-live/shared";
import type { Logger } from "../../log";
import type { SpeechPipeline } from "../voice/pipeline";
import type { HostBrain } from "./host";
import type { ViewerMemory } from "./memory";
import type { TurnKind, TurnRequest } from "./prompt";
import type { Triage, TriageResult } from "./triage";

export interface StreamStats {
  viewers: number;
  likes: number;
  diamonds: number;
  messages: number;
  follows: number;
  shares: number;
  joins: number;
  gifts: number;
  peakViewers: number;
  uptimeMinutes: number;
}

/** Visual side effects the director triggers directly, without waiting for speech. */
export interface StageNotifier {
  alert(event: LiveEvent): void;
  segment(segment: Segment): void;
  stats(stats: { viewers: number; likes: number }): void;
}

/** Observability hooks for the studio feed and analytics. */
export interface DirectorHooks {
  onEvent?(event: LiveEvent, triage: TriageResult | null): void;
  onTurn?(turn: { id: string; kind: TurnKind; items: number }): void;
  onTurnFailed?(error: unknown): void;
  onSegment?(segment: Segment): void;
  onStandbyChange?(standby: boolean): void;
}

export interface DirectorOptions {
  persona: Persona;
  host: HostBrain;
  triage: Triage;
  memory: ViewerMemory;
  speech: SpeechPipeline;
  stage: StageNotifier;
  hooks?: DirectorHooks;
  /** Silence (ms) before the host fills dead air when people are watching. */
  deadAirMs: number;
  /** Wait for the first real event before talking (avoids talking to an empty room). */
  startInStandby?: boolean;
  log?: Logger;
  now?: () => number;
}

const LIKE_MILESTONES = [100, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];
const MIN_TURN_GAP_MS = 1_500;
const RECENT_LINES = 8;
/** With nobody watching and nothing happening for this long, stop filling silence (ADR-0012). */
const EMPTY_ROOM_REACT_ONLY_MS = 10 * 60 * 1000;

export function nextLikeMilestone(likes: number): number {
  const fixed = LIKE_MILESTONES.find((m) => m > likes);
  if (fixed) return fixed;
  return (Math.floor(likes / 100_000) + 1) * 100_000;
}

/** Audience-aware pacing (ADR-0012): fill silence less often when fewer people are watching. */
export function deadAirFor(viewers: number, baseMs: number): number {
  if (viewers >= 5) return baseMs;
  if (viewers >= 1) return Math.max(baseMs, 20_000);
  return Math.max(baseMs, 60_000);
}

export interface DirectorState {
  paused: boolean;
  standby: boolean;
  reactOnly: boolean;
  turnInFlight: TurnKind | null;
  segment: Segment;
  segmentEndsInSec: number;
  stats: StreamStats;
  recentLines: string[];
  host: string;
}

/**
 * The show runner. Owns the run-of-show (segments), decides when the host
 * talks and about what, and keeps the stream alive when chat goes quiet.
 *
 * Decision order each tick: opening > reactions to viewers > like milestones
 * > segment changes > dead-air filler.
 */
export class Director {
  private persona: Persona;
  private paused = false;
  private standby: boolean;
  private opened = false;
  private turnInFlight: TurnKind | null = null;
  private turnAbort: AbortController | undefined;
  private lastTurnAt = 0;
  private lastEventAt: number;
  private cooldownUntil = 0;
  private failures = 0;
  private segmentIndex = 0;
  private segmentStartedAt: number;
  private forcedSegment: number | undefined;
  private startedAt: number;
  private readonly counters = { likes: 0, diamonds: 0, messages: 0, follows: 0, shares: 0, joins: 0, gifts: 0 };
  private viewers = 0;
  private peakViewers = 0;
  private pendingMilestone: number | undefined;
  private nextMilestone = LIKE_MILESTONES[0] as number;
  private recentLines: string[] = [];
  private budgetReactOnly = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private turnCounter = 0;
  private readonly now: () => number;

  constructor(private readonly options: DirectorOptions) {
    this.now = options.now ?? Date.now;
    this.persona = options.persona;
    this.startedAt = this.now();
    this.segmentStartedAt = this.startedAt;
    this.lastEventAt = this.startedAt;
    this.standby = options.startInStandby ?? false;
  }

  start(intervalMs = 200): void {
    this.options.stage.segment(this.segment());
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.turnAbort?.abort();
  }

  segment(): Segment {
    return (this.persona.segments[this.segmentIndex] ?? this.persona.segments[0]) as Segment;
  }

  /** Applies an edited persona without restarting the show. */
  reconfigure(persona: Persona): void {
    const currentId = this.segment().id;
    this.persona = persona;
    const index = persona.segments.findIndex((s) => s.id === currentId);
    if (index >= 0) {
      this.segmentIndex = index;
    } else {
      this.segmentIndex = 0;
      this.segmentStartedAt = this.now();
      this.options.stage.segment(this.segment());
      this.options.hooks?.onSegment?.(this.segment());
    }
  }

  isStandby(): boolean {
    return this.standby;
  }

  /** Budget guardrail (ADR-0012): react to viewers but stop filling silence. */
  setBudgetReactOnly(value: boolean): void {
    if (value !== this.budgetReactOnly) this.options.log?.warn(value ? "token budget reached: react-only mode" : "token budget recovered");
    this.budgetReactOnly = value;
  }

  reactOnly(): boolean {
    return this.budgetReactOnly || (this.viewers === 0 && this.now() - this.lastEventAt > EMPTY_ROOM_REACT_ONLY_MS);
  }

  handleEvent(event: LiveEvent): void {
    if (event.kind === "stream_end") {
      this.options.log?.info("stream ended; standing by until the next stream");
      this.setStandby(true);
      this.opened = false;
      this.options.hooks?.onEvent?.(event, null);
      return;
    }
    if (this.standby) {
      this.options.log?.info("audience activity detected; going on air");
      this.setStandby(false);
    }
    if (event.kind !== "viewers" && event.kind !== "like") this.lastEventAt = this.now();

    this.options.memory.observe(event);

    switch (event.kind) {
      case "viewers":
        this.viewers = event.count;
        this.peakViewers = Math.max(this.peakViewers, event.count);
        this.options.stage.stats({ viewers: this.viewers, likes: this.counters.likes });
        this.options.hooks?.onEvent?.(event, null);
        return;
      case "like": {
        // Joining a stream that already has likes (e.g. after a restart) sets
        // the baseline instead of celebrating every milestone at once.
        const joinedMidStream = this.counters.likes === 0 && (event.total ?? 0) > event.count;
        this.counters.likes = Math.max(this.counters.likes + event.count, event.total ?? 0);
        if (joinedMidStream) {
          this.nextMilestone = nextLikeMilestone(this.counters.likes);
        } else if (this.counters.likes >= this.nextMilestone) {
          let crossed = this.nextMilestone;
          while (nextLikeMilestone(crossed) <= this.counters.likes) crossed = nextLikeMilestone(crossed);
          this.pendingMilestone = crossed;
          this.nextMilestone = nextLikeMilestone(this.counters.likes);
        }
        this.options.stage.stats({ viewers: this.viewers, likes: this.counters.likes });
        this.options.hooks?.onEvent?.(event, null);
        return;
      }
      case "gift":
        this.counters.gifts += 1;
        this.counters.diamonds += event.diamonds;
        this.options.stage.alert(event);
        break;
      case "follow":
        this.counters.follows += 1;
        this.options.stage.alert(event);
        break;
      case "share":
        this.counters.shares += 1;
        this.options.stage.alert(event);
        break;
      case "chat":
      case "question":
        this.counters.messages += 1;
        break;
      case "join":
        this.counters.joins += 1;
        break;
      default:
        break;
    }
    const result = this.options.triage.ingest(event);
    this.options.hooks?.onEvent?.(event, result);
  }

  /** Called when a sentence was actually performed on stage. */
  noteSpoken(text: string): void {
    this.recentLines = [...this.recentLines, text].slice(-RECENT_LINES);
  }

  pause(): void {
    this.paused = true;
    this.turnAbort?.abort();
    this.options.speech.stop();
    this.options.log?.warn("host paused (kill switch)");
  }

  resume(): void {
    this.paused = false;
    this.cooldownUntil = 0;
    this.options.log?.info("host resumed");
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Cut the current sentence and anything queued, but keep the show running. */
  skip(): void {
    this.turnAbort?.abort();
    this.options.speech.stop();
  }

  forceSegment(id: string): boolean {
    const index = this.persona.segments.findIndex((s) => s.id === id);
    if (index === -1) return false;
    this.forcedSegment = index;
    return true;
  }

  stats(): StreamStats {
    return {
      viewers: this.viewers,
      peakViewers: this.peakViewers,
      ...this.counters,
      uptimeMinutes: Math.floor((this.now() - this.startedAt) / 60_000),
    };
  }

  /** Starts counting a new stream session (totals reset; viewer memory persists). */
  resetSession(): void {
    this.startedAt = this.now();
    for (const key of Object.keys(this.counters) as Array<keyof typeof this.counters>) this.counters[key] = 0;
    this.peakViewers = this.viewers;
    this.nextMilestone = LIKE_MILESTONES[0] as number;
    this.pendingMilestone = undefined;
  }

  state(): DirectorState {
    const segment = this.segment();
    return {
      paused: this.paused,
      standby: this.standby,
      reactOnly: this.reactOnly(),
      turnInFlight: this.turnInFlight,
      segment,
      segmentEndsInSec: Math.max(0, Math.round((this.segmentStartedAt + segment.minutes * 60_000 - this.now()) / 1000)),
      stats: this.stats(),
      recentLines: this.recentLines,
      host: this.options.host.name,
    };
  }

  /** One scheduling step. Public so tests can drive it with a fake clock. */
  async tick(): Promise<void> {
    if (this.paused || this.standby || this.turnInFlight) return;
    const now = this.now();
    if (now < this.cooldownUntil || now - this.lastTurnAt < MIN_TURN_GAP_MS) return;
    // Start the next turn while the last sentence is still playing, but never
    // stack up more than one turn of queued speech.
    if (this.options.speech.pending() > 0) return;

    const turn = this.chooseTurn(now);
    if (turn) await this.runTurn(turn);
  }

  private setStandby(value: boolean): void {
    if (this.standby === value) return;
    this.standby = value;
    this.options.hooks?.onStandbyChange?.(value);
  }

  private chooseTurn(now: number): (TurnRequest & { originAt: number }) | undefined {
    const { triage, speech } = this.options;
    const base = {
      segment: this.segment(),
      stats: { viewers: this.viewers, likes: this.counters.likes, uptimeMinutes: this.stats().uptimeMinutes },
      recentLines: this.recentLines,
      originAt: now,
    };

    if (!this.opened) {
      this.opened = true;
      return { ...base, kind: "opening", items: [] };
    }

    if (triage.pending() > 0) {
      const items = triage.take(4);
      // Fold any remaining thank-you-type events into the same turn.
      items.push(...triage.takeKinds(["follow", "share", "join"], 6 - items.length));
      const originAt = Math.min(...items.map((item) => item.event.at));
      return { ...base, kind: "react", items, originAt: Number.isFinite(originAt) ? originAt : now };
    }

    if (this.pendingMilestone !== undefined) {
      const note = `the stream just passed ${this.pendingMilestone.toLocaleString("en-US")} likes`;
      this.pendingMilestone = undefined;
      return { ...base, kind: "milestone", items: [], note };
    }

    if (this.reactOnly()) return undefined;

    const segment = this.segment();
    const segmentOver = now - this.segmentStartedAt >= segment.minutes * 60_000;
    if ((segmentOver || this.forcedSegment !== undefined) && speech.isIdle() && this.persona.segments.length > 1) {
      const nextIndex = this.forcedSegment ?? (this.segmentIndex + 1) % this.persona.segments.length;
      this.forcedSegment = undefined;
      const nextSegment = this.persona.segments[nextIndex] as Segment;
      this.segmentIndex = nextIndex;
      this.segmentStartedAt = now;
      this.options.stage.segment(nextSegment);
      this.options.hooks?.onSegment?.(nextSegment);
      return { ...base, kind: "segment_change", items: [], nextSegment };
    }

    const deadAir = deadAirFor(this.viewers, this.options.deadAirMs);
    const quietFor = speech.silenceMs();
    if (quietFor >= deadAir && now - this.lastTurnAt >= deadAir) {
      return { ...base, kind: "filler", items: [] };
    }
    return undefined;
  }

  private async runTurn(turn: TurnRequest & { originAt: number }): Promise<void> {
    this.turnInFlight = turn.kind;
    this.lastTurnAt = this.now();
    const abort = new AbortController();
    this.turnAbort = abort;
    const turnId = `t${++this.turnCounter}`;
    this.options.hooks?.onTurn?.({ id: turnId, kind: turn.kind, items: turn.items.length });
    let first = true;
    try {
      for await (const utterance of this.options.host.generate(turn, abort.signal)) {
        if (abort.signal.aborted || this.paused) break;
        this.options.speech.enqueue(utterance, { meta: { turnId, turnKind: turn.kind, originAt: turn.originAt, first } });
        first = false;
      }
      this.failures = 0;
    } catch (err) {
      if (!abort.signal.aborted) {
        this.failures += 1;
        const backoff = Math.min(30_000, 1_000 * 2 ** this.failures);
        this.cooldownUntil = this.now() + backoff;
        this.options.log?.warn(`turn failed; cooling down ${Math.round(backoff / 1000)}s`, err);
        this.options.hooks?.onTurnFailed?.(err);
      }
    } finally {
      this.turnInFlight = null;
      this.turnAbort = undefined;
    }
  }
}
