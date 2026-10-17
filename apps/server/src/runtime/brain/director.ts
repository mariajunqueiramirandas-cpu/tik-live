import { viewerName, type Effect, type LiveEvent, type Persona, type Segment, type Sound } from "@tik-live/shared";
import type { Logger } from "../../log";
import type { GameMaster } from "../games/master";
import { containsBlockedTerm } from "../safety/rules";
import type { SpeechPipeline } from "../voice/pipeline";
import type { Chronicler } from "./chronicle";
import type { HostActions, HostBrain } from "./host";
import type { ViewerMemory } from "./memory";
import { describeClock, type TurnKind, type TurnRequest } from "./prompt";
import { RoomLog } from "./room-log";
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
  fx?(fx: Effect, intensity?: number): void;
  sfx?(sound: Sound): void;
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
  /** Runs chat minigames, when the channel has them. */
  games?: GameMaster;
  /** Keeps a running summary of the show and notes about viewers. */
  chronicler?: Chronicler;
  /** What the host may do besides talking (play music). */
  actions?: HostActions;
  /** Terms never spoken, for the moderator context and the chronicler's notes. */
  blocklist?: () => readonly string[];
  log?: Logger;
  now?: () => number;
}

const LIKE_MILESTONES = [100, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];
const MIN_TURN_GAP_MS = 1_500;
const RECENT_LINES = 8;
/** Moments of the room the host sees each turn. */
const HISTORY_ENTRIES = 28;
/** A segment's game starts this long after the segment does, and waits this long between games. */
const SEGMENT_GAME_DELAY_MS = 4_000;
const GAME_BREAK_MS = 40_000;
/** Don't start a segment game with less than this left in the segment. */
const MIN_GAME_WINDOW_MS = 90_000;
/** The chronicler runs at most this often, and only with enough new material. */
const CHRONICLE_EVERY_MS = 4 * 60_000;
const CHRONICLE_MIN_ENTRIES = 10;
/** Viewer events one reaction turn covers: the top few, plus gifts and thank-yous folded in. */
const REACT_TOP_ITEMS = 4;
const REACT_MAX_ITEMS = 8;

/**
 * How much each kind of turn matters once it's under way (ADR-0022). A turn
 * is only ever interrupted, between sentences, by an event more urgent than
 * its priority.
 */
export const TURN_PRIORITY: Record<TurnKind, number> = {
  filler: 10,
  segment_change: 20,
  milestone: 30,
  opening: 40,
  game: 45,
  request: 45,
  react: 50,
};

/** How urgently a queued event wants the floor: gifts cut short anything but a reaction or the opening; chat only cuts filler. */
export function eventUrgency(event: LiveEvent): number {
  switch (event.kind) {
    case "gift":
      return 35;
    case "chat":
    case "question":
      return 15;
    default:
      return 0;
  }
}
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
 *
 * Turn-taking (ADR-0022): one turn is generated at a time, and the next one
 * starts while the last sentence of the previous one is playing, so events
 * that arrive meanwhile are batched into it (and it's kept brief when chat is
 * busy). Sentences are never cut: when a gift or a message arrives during a
 * less important turn (filler, a segment intro), the sentence on stage
 * finishes, the rest of that turn is dropped, and the host reacts next.
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
  /** A turn just yielded to something more urgent: start the next one without the usual gap. */
  private skipGap = false;
  private readonly room: RoomLog;
  /** Something the creator asked the host to do, from the studio. */
  private pendingRequest: string | undefined;
  private summary = "";
  private chronicledAt: number;
  private roomSinceChronicle = 0;
  private chronicling = false;
  private readonly now: () => number;

  constructor(private readonly options: DirectorOptions) {
    this.now = options.now ?? Date.now;
    this.persona = options.persona;
    this.startedAt = this.now();
    this.segmentStartedAt = this.startedAt;
    this.lastEventAt = this.startedAt;
    this.chronicledAt = this.startedAt;
    this.standby = options.startInStandby ?? false;
    this.room = new RoomLog(this.now);
  }

  start(intervalMs = 200): void {
    this.options.stage.segment(this.segment());
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.turnAbort?.abort();
    this.options.games?.stop();
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
      this.options.games?.stop();
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
          this.options.stage.fx?.("hearts", 2);
          this.sound("levelup");
        }
        this.options.stage.stats({ viewers: this.viewers, likes: this.counters.likes });
        this.options.hooks?.onEvent?.(event, null);
        return;
      }
      case "gift":
        this.counters.gifts += 1;
        this.counters.diamonds += event.diamonds;
        this.options.stage.alert(event);
        this.sound(event.diamonds >= 1_000 ? "fanfare" : event.diamonds >= 100 ? "levelup" : event.diamonds >= 10 ? "chime" : "pop");
        this.room.add({ at: event.at, kind: "support", event });
        break;
      case "follow":
        this.counters.follows += 1;
        this.options.stage.alert(event);
        this.sound("chime");
        this.room.add({ at: event.at, kind: "support", event });
        break;
      case "share":
        this.counters.shares += 1;
        this.options.stage.alert(event);
        this.sound("whoosh");
        this.room.add({ at: event.at, kind: "support", event });
        break;
      case "chat":
      case "question":
        this.counters.messages += 1;
        // An answer to a game round is the game's, not a message for the host.
        if (this.options.games?.handleChat(event)) {
          this.options.hooks?.onEvent?.(event, { queued: false, reason: "game answer" });
          return;
        }
        break;
      case "join":
        this.counters.joins += 1;
        break;
      default:
        break;
    }
    const result = this.options.triage.ingest(event);
    this.options.hooks?.onEvent?.(event, result);
    if (result.queued) {
      // Only chat that passed triage's rules goes into the host's memory of the room.
      if (event.kind === "chat" || event.kind === "question") this.remember({ at: event.at, kind: "viewer", event });
      this.yieldTo(eventUrgency(event));
    }
  }

  /** Called when a sentence was actually performed on stage. */
  noteSpoken(text: string): void {
    this.recentLines = [...this.recentLines, text].slice(-RECENT_LINES);
    this.remember({ at: this.now(), kind: "host", text });
  }

  /** Asks the host to do something on its next turn (from the studio), e.g. compose a beat. */
  request(note: string): void {
    this.pendingRequest = note;
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
    // A segment's game ends with it; the creator's own game keeps going.
    if (this.options.games?.source() === "segment") this.options.games.stop();
    return true;
  }

  /** Recent chat messages, for matching a game's language to the room. */
  chatSample(): string[] {
    return this.room
      .recent(HISTORY_ENTRIES)
      .flatMap((entry) => (entry.kind === "viewer" ? [entry.event.text] : []))
      .slice(-12);
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
    if (this.standby) return;
    // Game clocks run even while a turn is being written.
    this.options.games?.tick(this.options.speech.isIdle());
    if (this.paused || this.turnInFlight) return;
    const now = this.now();
    this.maybeStartSegmentGame(now);
    this.maybeChronicle(now);
    if (now < this.cooldownUntil || (!this.skipGap && now - this.lastTurnAt < MIN_TURN_GAP_MS)) return;
    // Start the next turn while the last sentence is still playing, but never
    // stack up more than one turn of queued speech.
    if (this.options.speech.pending() > 0) return;

    const turn = this.chooseTurn(now);
    if (turn) await this.runTurn(turn);
  }

  /**
   * Barge-in at a sentence boundary: stops generating and drops the queued
   * lines of any turn less important than `urgency`. The sentence on stage
   * plays to the end; the next tick picks the reaction.
   */
  private yieldTo(urgency: number): void {
    if (this.paused || this.standby || urgency <= 0) return;
    const outranked = (kind: string | undefined) => kind !== undefined && kind in TURN_PRIORITY && TURN_PRIORITY[kind as TurnKind] < urgency;
    const { speech } = this.options;
    let yielded = outranked(speech.activeMeta()?.turnKind);
    if (this.turnInFlight && outranked(this.turnInFlight)) {
      this.turnAbort?.abort();
      yielded = true;
    }
    const dropped = speech.drop((meta) => outranked(meta?.turnKind));
    if (yielded || dropped > 0) {
      this.skipGap = true;
      this.options.log?.debug(`yielding to a viewer event (${dropped} queued line${dropped === 1 ? "" : "s"} dropped)`);
    }
  }

  private setStandby(value: boolean): void {
    if (this.standby === value) return;
    this.standby = value;
    this.options.hooks?.onStandbyChange?.(value);
  }

  private chooseTurn(now: number): (TurnRequest & { originAt: number }) | undefined {
    const { triage, speech } = this.options;
    const games = this.options.games;
    const game = games?.hostContext();
    const base = {
      segment: this.segment(),
      stats: { viewers: this.viewers, likes: this.counters.likes, uptimeMinutes: this.stats().uptimeMinutes },
      history: this.room.recent(HISTORY_ENTRIES),
      // What it's still saying: the reply plays after those.
      upcoming: speech.upcoming(),
      clock: describeClock(now, this.persona.timezone),
      ...(this.summary ? { summary: this.summary } : {}),
      ...(game ? { game } : {}),
      originAt: now,
    };

    if (!this.opened) {
      this.opened = true;
      return { ...base, kind: "opening", items: [] };
    }

    // Game moments are time-bound (a question just went up, an answer is being revealed).
    const cue = games?.takeCue();
    if (cue) {
      this.remember({ at: now, kind: "show", text: cue.history });
      return { ...base, kind: "game", items: [], note: cue.note, line: cue.line };
    }

    if (this.pendingRequest !== undefined) {
      const note = this.pendingRequest;
      this.pendingRequest = undefined;
      return { ...base, kind: "request", items: [], note };
    }

    if (triage.pending() > 0) {
      const items = triage.take(REACT_TOP_ITEMS);
      // Fold the other gifts and thank-you-type events into the same turn.
      items.push(...triage.takeKinds(["gift", "follow", "share", "join"], REACT_MAX_ITEMS - items.length));
      // More is waiting, or this turn covers a lot: keep it short to keep up.
      const brief = triage.pending() > 0 || items.length > REACT_TOP_ITEMS;
      const originAt = Math.min(...items.map((item) => item.event.at));
      return { ...base, kind: "react", items, brief, originAt: Number.isFinite(originAt) ? originAt : now };
    }

    if (this.pendingMilestone !== undefined) {
      const crossed = this.pendingMilestone;
      this.pendingMilestone = undefined;
      // The note is for the model (English numbers); the offline line is spoken (Brazilian numbers).
      return {
        ...base,
        kind: "milestone",
        items: [],
        note: `the stream just passed ${crossed.toLocaleString("en-US")} likes`,
        line: `Passamos de ${crossed.toLocaleString("pt-BR")} curtidas`,
      };
    }

    if (this.reactOnly()) return undefined;

    const segment = this.segment();
    const segmentOver = now - this.segmentStartedAt >= segment.minutes * 60_000;
    // A game in progress finishes before the segment moves on (a forced change already stopped a segment's game).
    const gameHolds = this.forcedSegment === undefined && games?.isActive() === true;
    if ((segmentOver || this.forcedSegment !== undefined) && !gameHolds && speech.isIdle() && this.persona.segments.length > 1) {
      const nextIndex = this.forcedSegment ?? (this.segmentIndex + 1) % this.persona.segments.length;
      this.forcedSegment = undefined;
      const nextSegment = this.persona.segments[nextIndex] as Segment;
      this.segmentIndex = nextIndex;
      this.segmentStartedAt = now;
      this.options.stage.segment(nextSegment);
      this.options.hooks?.onSegment?.(nextSegment);
      this.remember({ at: now, kind: "show", text: `New segment: ${nextSegment.title}` });
      return { ...base, kind: "segment_change", items: [], nextSegment };
    }

    const deadAir = deadAirFor(this.viewers, this.options.deadAirMs);
    const quietFor = speech.silenceMs();
    if (quietFor >= deadAir && now - this.lastTurnAt >= deadAir) {
      const note = games?.fillerNote();
      return { ...base, kind: "filler", items: [], ...(note ? { note } : {}) };
    }
    return undefined;
  }

  private remember(entry: Parameters<RoomLog["add"]>[0]): void {
    this.room.add(entry);
    this.roomSinceChronicle += 1;
  }

  private sound(sound: Sound): void {
    if (this.persona.sound?.effects !== false) this.options.stage.sfx?.(sound);
  }

  /** Starts the current segment's game when the segment has one and the room is ready for it. */
  private maybeStartSegmentGame(now: number): void {
    const games = this.options.games;
    const config = this.segment().game;
    // Not gated on a quiet room: on a busy stream it never is, and the game's cue gets its own turn.
    if (!games || !config || !this.opened || games.isActive() || this.reactOnly()) return;
    if (now - this.segmentStartedAt < SEGMENT_GAME_DELAY_MS || now - games.lastEndedAt() < GAME_BREAK_MS) return;
    const left = this.segmentStartedAt + this.segment().minutes * 60_000 - now;
    if (left < MIN_GAME_WINDOW_MS) return;
    const started = games.start(config, "segment", this.chatSample());
    if (started.ok) this.options.log?.info(`starting the segment's game (${config.kind})`);
  }

  /** Every few minutes, folds the recent room into a running summary and notes about viewers. */
  private maybeChronicle(now: number): void {
    const chronicler = this.options.chronicler;
    if (!chronicler || this.chronicling || this.reactOnly()) return;
    if (now - this.chronicledAt < CHRONICLE_EVERY_MS || this.roomSinceChronicle < CHRONICLE_MIN_ENTRIES) return;
    this.chronicling = true;
    this.chronicledAt = now;
    const entries = this.room.recent(60);
    this.roomSinceChronicle = 0;
    const blocklist = this.options.blocklist?.() ?? [];
    void chronicler
      .update(this.summary, entries)
      .then((chronicle) => {
        if (!containsBlockedTerm(chronicle.summary, blocklist)) this.summary = chronicle.summary;
        for (const note of chronicle.notes) {
          if (!containsBlockedTerm(note.note, blocklist)) this.options.memory.addNote(note.viewerId, note.note);
        }
      })
      .catch((err: unknown) => this.options.log?.warn("couldn't update the show summary", err))
      .finally(() => {
        this.chronicling = false;
      });
  }

  /** What a line replies to, so the moderator reads it in context (ADR-0016). */
  private moderationContext(turn: TurnRequest, said: string[]): string {
    const lines: string[] = [];
    for (const item of turn.items) {
      const event = item.event;
      if (event.kind === "chat" || event.kind === "question") lines.push(`Viewer ${viewerName(event.viewer).slice(0, 30)} wrote: ${event.text}`);
      else if (event.kind === "gift") lines.push(`Viewer ${viewerName(event.viewer).slice(0, 30)} sent ${event.count}x ${event.giftName}.`);
    }
    if (turn.kind === "game") lines.push("The host is running a chat quiz game and announcing a round.");
    if (turn.kind === "request") lines.push(`The channel owner asked the host: ${turn.note ?? ""}`);
    if (said.length) lines.push(`The host just said: ${said.slice(-2).join(" ")}`);
    return lines.join("\n");
  }

  private async runTurn(turn: TurnRequest & { originAt: number }): Promise<void> {
    this.turnInFlight = turn.kind;
    this.lastTurnAt = this.now();
    this.skipGap = false;
    const abort = new AbortController();
    this.turnAbort = abort;
    const turnId = `t${++this.turnCounter}`;
    this.options.hooks?.onTurn?.({ id: turnId, kind: turn.kind, items: turn.items.length });
    let first = true;
    const said: string[] = [];
    try {
      for await (const utterance of this.options.host.generate(turn, abort.signal, this.options.actions)) {
        if (abort.signal.aborted || this.paused) break;
        const context = this.moderationContext(turn, said);
        this.options.speech.enqueue(utterance, {
          meta: { turnId, turnKind: turn.kind, originAt: turn.originAt, first },
          ...(context ? { context } : {}),
        });
        said.push(utterance.text);
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
