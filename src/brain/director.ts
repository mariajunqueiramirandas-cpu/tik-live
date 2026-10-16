import type { Persona, Segment } from "../config.js";
import type { LiveEvent } from "../events/types.js";
import { createLogger, type SessionRecorder } from "../log.js";
import type { SpeechPipeline } from "../voice/pipeline.js";
import type { HostBrain } from "./host.js";
import type { ViewerMemory } from "./memory.js";
import type { TurnKind, TurnRequest } from "./prompt.js";
import type { Triage } from "./triage.js";

const log = createLogger("director");

export interface StreamStats {
  viewers: number;
  likes: number;
  uptimeMinutes: number;
}

/** Visual side effects the director triggers directly, without waiting for speech. */
export interface StageNotifier {
  alert(event: LiveEvent): void;
  segment(segment: Segment): void;
  stats(stats: StreamStats): void;
}

export interface DirectorOptions {
  persona: Persona;
  host: HostBrain;
  triage: Triage;
  memory: ViewerMemory;
  speech: SpeechPipeline;
  stage: StageNotifier;
  recorder?: SessionRecorder;
  /** Silence (ms) before the host fills dead air. */
  deadAirMs: number;
  /** Wait for the first real event before talking (avoids talking to an empty room). */
  startInStandby?: boolean;
  now?: () => number;
}

const LIKE_MILESTONES = [100, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];
const MIN_TURN_GAP_MS = 1_500;
const RECENT_LINES = 8;

export function nextLikeMilestone(likes: number): number {
  const fixed = LIKE_MILESTONES.find((m) => m > likes);
  if (fixed) return fixed;
  return (Math.floor(likes / 100_000) + 1) * 100_000;
}

export interface DirectorState {
  paused: boolean;
  standby: boolean;
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
  private paused = false;
  private standby: boolean;
  private opened = false;
  private turnInFlight: TurnKind | null = null;
  private turnAbort: AbortController | undefined;
  private lastTurnAt = 0;
  private cooldownUntil = 0;
  private failures = 0;
  private segmentIndex = 0;
  private segmentStartedAt: number;
  private forcedSegment: number | undefined;
  private readonly startedAt: number;
  private viewers = 0;
  private likes = 0;
  private pendingMilestone: number | undefined;
  private nextMilestone = LIKE_MILESTONES[0] as number;
  private recentLines: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(private readonly options: DirectorOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.segmentStartedAt = this.startedAt;
    this.standby = options.startInStandby ?? false;
  }

  start(intervalMs = 200): void {
    this.options.stage.segment(this.segment());
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.turnAbort?.abort();
  }

  segment(): Segment {
    return this.options.persona.segments[this.segmentIndex] as Segment;
  }

  handleEvent(event: LiveEvent): void {
    this.options.recorder?.record("event", event);
    if (event.kind === "stream_end") {
      log.info("stream ended; standing by until the next stream");
      this.standby = true;
      this.opened = false;
      return;
    }
    if (this.standby) {
      log.info("audience activity detected; going on air");
      this.standby = false;
    }

    this.options.memory.observe(event);

    switch (event.kind) {
      case "viewers":
        this.viewers = event.count;
        this.options.stage.stats(this.stats());
        return;
      case "like": {
        // Joining a stream that already has likes (e.g. after a restart) sets
        // the baseline instead of celebrating every milestone at once.
        const joinedMidStream = this.likes === 0 && (event.total ?? 0) > event.count;
        this.likes = Math.max(this.likes + event.count, event.total ?? 0);
        if (joinedMidStream) {
          this.nextMilestone = nextLikeMilestone(this.likes);
        } else if (this.likes >= this.nextMilestone) {
          let crossed = this.nextMilestone;
          while (nextLikeMilestone(crossed) <= this.likes) crossed = nextLikeMilestone(crossed);
          this.pendingMilestone = crossed;
          this.nextMilestone = nextLikeMilestone(this.likes);
        }
        this.options.stage.stats(this.stats());
        return;
      }
      case "gift":
      case "follow":
      case "share":
        this.options.stage.alert(event);
        break;
      default:
        break;
    }
    this.options.triage.ingest(event);
  }

  /** Called when a sentence was actually performed on stage. */
  noteSpoken(text: string): void {
    this.recentLines = [...this.recentLines, text].slice(-RECENT_LINES);
    this.options.recorder?.record("spoken", { text });
  }

  pause(): void {
    this.paused = true;
    this.turnAbort?.abort();
    this.options.speech.stop();
    log.warn("host paused (kill switch)");
  }

  resume(): void {
    this.paused = false;
    this.cooldownUntil = 0;
    log.info("host resumed");
  }

  /** Cut the current sentence and anything queued, but keep the show running. */
  skip(): void {
    this.turnAbort?.abort();
    this.options.speech.stop();
  }

  forceSegment(id: string): boolean {
    const index = this.options.persona.segments.findIndex((s) => s.id === id);
    if (index === -1) return false;
    this.forcedSegment = index;
    return true;
  }

  stats(): StreamStats {
    return {
      viewers: this.viewers,
      likes: this.likes,
      uptimeMinutes: Math.floor((this.now() - this.startedAt) / 60_000),
    };
  }

  state(): DirectorState {
    const segment = this.segment();
    return {
      paused: this.paused,
      standby: this.standby,
      turnInFlight: this.turnInFlight,
      segment,
      segmentEndsInSec: Math.max(
        0,
        Math.round((this.segmentStartedAt + segment.minutes * 60_000 - this.now()) / 1000),
      ),
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

  private chooseTurn(now: number): TurnRequest | undefined {
    const { triage, speech, persona } = this.options;
    const base = { segment: this.segment(), stats: this.stats(), recentLines: this.recentLines };

    if (!this.opened) {
      this.opened = true;
      return { ...base, kind: "opening", items: [] };
    }

    if (triage.pending() > 0) {
      const items = triage.take(4);
      // Fold any remaining thank-you-type events into the same turn.
      items.push(...triage.takeKinds(["follow", "share", "join"], 6 - items.length));
      return { ...base, kind: "react", items };
    }

    if (this.pendingMilestone !== undefined) {
      const note = `the stream just passed ${this.pendingMilestone.toLocaleString("en-US")} likes`;
      this.pendingMilestone = undefined;
      return { ...base, kind: "milestone", items: [], note };
    }

    const segment = this.segment();
    const segmentOver = now - this.segmentStartedAt >= segment.minutes * 60_000;
    if ((segmentOver || this.forcedSegment !== undefined) && speech.isIdle() && persona.segments.length > 1) {
      const nextIndex = this.forcedSegment ?? (this.segmentIndex + 1) % persona.segments.length;
      this.forcedSegment = undefined;
      const nextSegment = persona.segments[nextIndex] as Segment;
      this.segmentIndex = nextIndex;
      this.segmentStartedAt = now;
      this.options.stage.segment(nextSegment);
      this.options.recorder?.record("segment", { id: nextSegment.id });
      return { ...base, kind: "segment_change", items: [], nextSegment };
    }

    const quietFor = speech.silenceMs();
    if (quietFor >= this.options.deadAirMs && now - this.lastTurnAt >= this.options.deadAirMs) {
      return { ...base, kind: "filler", items: [] };
    }
    return undefined;
  }

  private async runTurn(turn: TurnRequest): Promise<void> {
    this.turnInFlight = turn.kind;
    this.lastTurnAt = this.now();
    const abort = new AbortController();
    this.turnAbort = abort;
    this.options.recorder?.record("turn", { kind: turn.kind, items: turn.items.map((i) => i.event) });
    try {
      for await (const utterance of this.options.host.generate(turn, abort.signal)) {
        if (abort.signal.aborted || this.paused) break;
        this.options.speech.enqueue(utterance);
      }
      this.failures = 0;
    } catch (err) {
      if (!abort.signal.aborted) {
        this.failures += 1;
        const backoff = Math.min(30_000, 1_000 * 2 ** this.failures);
        this.cooldownUntil = this.now() + backoff;
        log.warn(`turn failed; cooling down ${Math.round(backoff / 1000)}s`, err);
      }
    } finally {
      this.turnInFlight = null;
      this.turnAbort = undefined;
    }
  }
}
