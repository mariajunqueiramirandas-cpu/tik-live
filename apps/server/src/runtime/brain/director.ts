import {
  GAME_LABELS,
  LEADER_BOARDS,
  LEADERS_MAX,
  UP_NEXT_MAX,
  type Effect,
  type GameConfig,
  type LeaderBoard,
  type LeaderRow,
  type LiveEvent,
  type Persona,
  type Segment,
  type Sound,
  type UpNextItem,
  type UpNextKind,
  type Viewer,
} from "@tik-live/shared";
import type { Logger } from "../../log";
import type { GameMaster } from "../games/master";
import type { LoopRanking } from "../games/ranking";
import { FinalVote, voteOptions } from "../games/vote";
import { GIFT_WINDOW_MS, LIKE_WINDOW_MS, RollingBoard } from "../leaderboards";
import type { CueMeta, SpeechPipeline } from "../voice/pipeline";
import type { Chronicler } from "./chronicle";
import type { RoomEntry } from "./conversation";
import type { HostActions, HostBrain } from "./host";
import type { ViewerMemory } from "./memory";
import { describeClock, displayName, type TurnKind, type TurnPlan } from "./prompt";
import type { QueueItem, Triage, TriageResult } from "./triage";
import { TurnEngine } from "./turns";

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
  /** What's coming up on the show, soonest first (ADR-0028). */
  schedule?(items: UpNextItem[]): void;
  /** Chat's vote on the last segment's game, or null when it closes (ADR-0029). */
  vote?(vote: { title: string; options: string[]; tally: number[] } | null): void;
  /** A ranking: the top likers over the last 15 minutes, or gifters over the last hour. */
  leaders?(board: LeaderBoard, rows: LeaderRow[], windowMin: number): void;
}

/** Observability hooks for the studio feed and analytics. */
export interface DirectorHooks {
  onEvent?(event: LiveEvent, triage: TriageResult | null): void;
  onTurn?(turn: { id: string; kind: TurnKind; items: number }): void;
  onTurnFailed?(error: unknown): void;
  onSegment?(segment: Segment): void;
  onStandbyChange?(standby: boolean): void;
  /** The chronicler updated the show summary. */
  onSummary?(summary: string): void;
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
  /** The minigame ranking for one loop of the run of show, revealed on a podium when the loop ends (ADR-0028). */
  ranking?: LoopRanking;
  /** Keeps a running summary of the show and notes about viewers. */
  chronicler?: Chronicler;
  /** What the host may do besides talking (play music). */
  actions?: HostActions;
  /** Terms never spoken, for viewer names and the chronicler's notes. */
  blocklist?: () => readonly string[];
  /** How the channel's last stream went (its summary), for the opening. */
  lastStream?: string;
  log?: Logger;
  now?: () => number;
}

const LIKE_MILESTONES = [100, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];
const MIN_TURN_GAP_MS = 1_500;
const RECENT_LINES = 8;
/** A segment's game starts this long after the segment does, and waits this long between games. */
const SEGMENT_GAME_DELAY_MS = 4_000;
const GAME_BREAK_MS = 40_000;
/** Don't start a segment game with less than this left in the segment. */
const MIN_GAME_WINDOW_MS = 90_000;
/** Viewer events one reaction covers: a few messages, plus the gifts and follows waiting. */
const REACT_CHAT = 3;
const REACT_SUPPORT = 6;
/** A segment this late moves on even while chat keeps the host busy. */
const SEGMENT_OVERDUE_MS = 30_000;
/** Questions the host moved past come back in a quiet moment, if they're this fresh. */
const OWED_TTL_MS = 3 * 60_000;
const OWED_MAX = 3;
const CHAT_SAMPLE = 12;
/** A ranking goes to the stage at most this often. */
const LEADERS_EVERY_MS = 1_000;
const WINDOWS: Record<LeaderBoard, number> = { likes: LIKE_WINDOW_MS, gifts: GIFT_WINDOW_MS };
const PODIUM_TITLE = "Pódio geral";
/** The vote on the last segment's game opens this long before the second-to-last segment ends (or soon after it starts). */
const VOTE_LEAD_MS = 3 * 60_000;
const VOTE_MIN_DELAY_MS = 20_000;
const VOTE_TITLE = "Jogo do quadro final";
const SUPPORT_KINDS: ReadonlyArray<LiveEvent["kind"]> = ["gift", "follow", "share", "join"];

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

/** Ideas for quiet moments, in rotation, so fillers don't all sound alike. */
const FILLER_BEATS: ReadonlyArray<{ beat: string; needsChat?: boolean }> = [
  { beat: "ask chat one fresh, easy question you haven't asked before." },
  { beat: "share a quick, original opinion or hot take, then ask chat if they agree." },
  { beat: "follow up on something a viewer told you earlier, by name.", needsChat: true },
  { beat: "tell a tiny story or a funny observation that fits your character, two sentences at most." },
  { beat: "welcome anyone who just arrived, say in one line what this show is about, and invite them to say hi." },
  { beat: "start a quick challenge chat can answer in one word." },
];

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
 * The show runner. Owns the run of show (segments), decides when the host
 * talks and about what, and keeps the stream alive when chat goes quiet. The
 * turn engine writes the turns; the director picks them.
 *
 * What comes next, each tick (ADR-0026):
 * 1. the opening, once per stream;
 * 2. game moments, in the order they happened (a round, its answer, the next round);
 * 3. what the channel owner asked for from the studio;
 * 4. a segment change that is overdue (a busy chat can't hold the show in one segment forever);
 * 5. reactions: gifts and follows first, then messages oldest first; a like milestone rides along;
 * 6. a like milestone on its own;
 * 7. the segment change, on time, in a quiet moment;
 * 8. dead-air filler, including questions the host moved past earlier.
 *
 * The host moves forward through chat: once it answers a message, older
 * messages it didn't pick are passed over (they're still in the room it
 * saw), so it never jumps back to something older than what it just
 * answered, except when it says so in a quiet moment.
 *
 * Turn-taking (ADR-0022): one turn is written at a time, and the next one
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
  /** A turn just yielded to something more urgent: start the next one without the usual gap. */
  private skipGap = false;
  /** Something the creator asked the host to do, from the studio. */
  private pendingRequest: string | undefined;
  /** Questions passed over on a busy stretch. */
  private owed: Array<{ event: LiveEvent; at: number }> = [];
  private fillerBeat = 0;
  private recentChat: string[] = [];
  private music: { title: string; endsAt: number } | null = null;
  /** Who sent the most likes (last 15 minutes) and diamonds (last hour). */
  private readonly boards: Record<LeaderBoard, RollingBoard>;
  private readonly boardSent: Record<LeaderBoard, { revision: number; at: number }> = {
    likes: { revision: -1, at: -Infinity },
    gifts: { revision: -1, at: -Infinity },
  };
  private scheduleKey = "";
  /** Chat's vote on the last segment's game, while the second-to-last segment runs. */
  private vote: { ballot: FinalVote; closesAt: number } | null = null;
  /** The game chat picked for this loop's last segment. */
  private finalGame: GameConfig | null = null;
  /** Loops completed this stream (rotates the games on offer). */
  private loops = 0;
  private voteCue: { note: string; line: string; history: string } | null = null;
  private voteKey = "";
  private voteSentAt = -Infinity;
  private readonly engine: TurnEngine;
  private readonly now: () => number;

  constructor(private readonly options: DirectorOptions) {
    this.now = options.now ?? Date.now;
    this.persona = options.persona;
    this.startedAt = this.now();
    this.segmentStartedAt = this.startedAt;
    this.lastEventAt = this.startedAt;
    this.standby = options.startInStandby ?? false;
    this.boards = { likes: new RollingBoard(this.now, LIKE_WINDOW_MS), gifts: new RollingBoard(this.now, GIFT_WINDOW_MS) };
    const blocklist = options.blocklist ?? (() => []);
    this.engine = new TurnEngine({
      host: options.host,
      speech: options.speech,
      memory: options.memory,
      persona: () => this.persona,
      blocklist,
      ...(options.chronicler ? { chronicler: options.chronicler } : {}),
      ...(options.actions ? { actions: options.actions } : {}),
      ...(options.lastStream ? { lastStream: options.lastStream } : {}),
      onTurn: (turn) => options.hooks?.onTurn?.(turn),
      onSummary: (summary) => options.hooks?.onSummary?.(summary),
      ...(options.log ? { log: options.log } : {}),
      now: this.now,
    });
  }

  start(intervalMs = 200): void {
    this.options.stage.segment(this.segment());
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.engine.stop();
    this.options.games?.stop();
    this.options.ranking?.stop();
  }

  segment(): Segment {
    return (this.persona.segments[this.segmentIndex] ?? this.persona.segments[0]) as Segment;
  }

  /** Applies an edited persona without restarting the show. */
  reconfigure(persona: Persona): void {
    const currentId = this.segment().id;
    if (persona.segments.length !== this.persona.segments.length || persona.finalVote === false) {
      this.vote = null;
      this.finalGame = null;
    }
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

  /** The show's running summary, from the chronicler. */
  showSummary(): string {
    return this.engine.showSummary;
  }

  handleEvent(event: LiveEvent): void {
    if (event.kind === "stream_end") {
      this.options.log?.info("stream ended; standing by until the next stream");
      this.engine.endStream();
      this.setStandby(true);
      this.opened = false;
      this.owed = [];
      // What was waiting belongs to the stream that ended.
      this.options.triage.clear();
      this.options.games?.stop();
      // So do its loop's ranking and who was liking and gifting.
      this.options.ranking?.stop();
      this.clearBoards();
      this.vote = null;
      this.voteCue = null;
      this.finalGame = null;
      this.loops = 0;
      this.publishHud(this.now(), true);
      this.options.hooks?.onEvent?.(event, null);
      return;
    }
    if (this.standby) {
      this.options.log?.info("audience activity detected; going on air");
      this.engine.startStream();
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
        this.boards.likes.add(event.viewer.id, this.boardName(event.viewer), event.count);
        this.options.stage.stats({ viewers: this.viewers, likes: this.counters.likes });
        this.options.hooks?.onEvent?.(event, null);
        return;
      }
      case "gift":
        this.counters.gifts += 1;
        this.counters.diamonds += event.diamonds;
        this.boards.gifts.add(event.viewer.id, this.boardName(event.viewer), event.diamonds);
        // Gifts during an open round power it up for everyone (ADR-0029).
        this.options.games?.handleGift(event);
        this.options.stage.alert(event);
        this.sound(event.diamonds >= 1_000 ? "fanfare" : event.diamonds >= 100 ? "levelup" : event.diamonds >= 10 ? "chime" : "pop");
        this.remember({ at: event.at, kind: "support", event });
        break;
      case "follow":
        this.counters.follows += 1;
        this.options.stage.alert(event);
        this.sound("chime");
        this.remember({ at: event.at, kind: "support", event });
        break;
      case "share":
        this.counters.shares += 1;
        this.options.stage.alert(event);
        this.sound("whoosh");
        this.remember({ at: event.at, kind: "support", event });
        break;
      case "chat":
      case "question":
        this.counters.messages += 1;
        // An answer to a game round is the game's, not a message for the host.
        if (this.options.games?.handleChat(event)) {
          this.options.hooks?.onEvent?.(event, { queued: false, reason: "game answer" });
          return;
        }
        // So is a ballot in the vote on the last segment's game.
        if (this.vote?.ballot.cast(event.viewer.id, event.text)) {
          this.options.hooks?.onEvent?.(event, { queued: false, reason: "vote" });
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
      // Only chat that passed triage's rules reaches the host's conversation.
      if (event.kind === "chat" || event.kind === "question") {
        this.remember({ at: event.at, kind: "viewer", event });
        this.recentChat = [...this.recentChat, event.text].slice(-CHAT_SAMPLE);
      } else if (event.kind === "join") {
        this.remember({ at: event.at, kind: "support", event });
      }
      this.yieldTo(eventUrgency(event));
    }
  }

  /** A line was performed on stage. Lines the owner typed join the conversation as theirs. */
  noteSpoken(text: string, _meta?: CueMeta, operator = false): void {
    this.recentLines = [...this.recentLines, text].slice(-RECENT_LINES);
    if (operator) this.remember({ at: this.now(), kind: "show", text: `The channel owner had you say: "${text}"` });
  }

  /** The safety gate stopped one of the host's lines. */
  noteBlocked(text: string, meta?: CueMeta): void {
    this.engine.unsaid("blocked", [{ text, meta }]);
  }

  /** Music went on (or off) on stage. */
  noteMusic(track: { title: string; endsAt: number; byHost: boolean } | null): void {
    if (!track) {
      this.music = null;
      return;
    }
    this.music = { title: track.title, endsAt: track.endsAt };
    this.remember({
      at: this.now(),
      kind: "show",
      text: track.byHost ? `Your piece "${track.title}" started playing on stage.` : `The channel owner put on "${track.title}".`,
    });
  }

  /** Asks the host to do something on its next turn (from the studio), e.g. compose a beat. */
  request(note: string): void {
    this.pendingRequest = note;
  }

  pause(): void {
    this.paused = true;
    this.engine.abort();
    this.engine.unsaid("skipped", this.options.speech.stop());
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
    this.engine.abort();
    this.engine.unsaid("skipped", this.options.speech.stop());
  }

  forceSegment(id: string): boolean {
    const index = this.persona.segments.findIndex((s) => s.id === id);
    if (index === -1) return false;
    this.forcedSegment = index;
    // A segment's game ends with it; the creator's own game keeps going.
    if (this.options.games?.source() === "segment") this.options.games.stop();
    return true;
  }

  /**
   * What's coming up, soonest first (ADR-0028): this segment's next game,
   * the loop's podium when this is the last segment, then the next segments.
   * Estimates: a segment waits for a game in progress and a quiet moment, so
   * anything overdue reads as "now".
   */
  upNext(now = this.now()): Array<{ kind: UpNextKind; title: string; at: number }> {
    const items: Array<{ kind: UpNextKind; title: string; at: number }> = [];
    const segments = this.persona.segments;
    const segment = this.segment();
    const games = this.options.games;
    const ranking = this.options.ranking;
    const revealing = ranking?.isRevealing() === true;
    const segmentEndsAt = this.segmentStartedAt + segment.minutes * 60_000;
    let at = Math.max(now, segmentEndsAt);
    const current = this.segmentGame(this.segmentIndex);
    if (current && games && !games.isActive() && !revealing) {
      const gameAt = Math.max(now, this.segmentStartedAt + SEGMENT_GAME_DELAY_MS, games.lastEndedAt() + GAME_BREAK_MS);
      if (segmentEndsAt - gameAt >= MIN_GAME_WINDOW_MS) items.push({ kind: "game", title: gameTitle(current), at: gameAt });
    }
    const podium = () => {
      if (ranking?.hasScores() && !revealing) items.push({ kind: "podium", title: PODIUM_TITLE, at });
    };
    if (segments.length === 1) {
      podium();
      return items.slice(0, UP_NEXT_MAX);
    }
    // Through the end of the loop and back to its first segment.
    for (let k = 1; k <= segments.length && items.length < UP_NEXT_MAX; k++) {
      const index = (this.segmentIndex + k) % segments.length;
      if (index === 0) podium();
      const next = segments[index] as Segment;
      const choosing = this.vote !== null && index === segments.length - 1;
      items.push({ kind: "segment", title: choosing ? `${next.title} · o chat escolhe`.slice(0, 60) : segmentTitle(next, this.segmentGame(index)), at });
      at += next.minutes * 60_000;
    }
    return items.slice(0, UP_NEXT_MAX);
  }

  /** Chat's vote on the last segment's game, for the studio. */
  voteStatus(now = this.now()): { segment: string; options: Array<{ label: string; votes: number }>; closesInSec: number } | null {
    const vote = this.vote;
    if (!vote) return null;
    const tally = vote.ballot.tally();
    const last = this.persona.segments[this.persona.segments.length - 1] as Segment;
    return {
      segment: last.title,
      options: vote.ballot.labels.map((label, i) => ({ label, votes: tally[i] ?? 0 })),
      closesInSec: Math.max(0, Math.ceil((vote.closesAt - now) / 1000)),
    };
  }

  /** The top likers over the last 15 minutes and gifters over the last hour. */
  leaders(n = LEADERS_MAX): Record<LeaderBoard, LeaderRow[]> {
    return { likes: this.boards.likes.top(n), gifts: this.boards.gifts.top(n) };
  }

  /** Recent chat messages, for matching a game's language to the room. */
  chatSample(): string[] {
    return this.recentChat;
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
    this.clearBoards();
  }

  state(): DirectorState {
    const segment = this.segment();
    return {
      paused: this.paused,
      standby: this.standby,
      reactOnly: this.reactOnly(),
      turnInFlight: this.engine.inFlight,
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
    // Game clocks run even while a turn is being written; a game waits for the host to finish talking.
    const idle = this.options.speech.isIdle() && !this.engine.inFlight;
    this.options.games?.tick(idle);
    this.options.ranking?.tick(idle);
    const now = this.now();
    this.maybeOpenVote(now);
    this.publishHud(now);
    if (this.paused || this.engine.inFlight) return;
    this.maybeStartSegmentGame(now);
    this.engine.maintain(now, !this.reactOnly());
    if (now < this.cooldownUntil || (!this.skipGap && now - this.lastTurnAt < MIN_TURN_GAP_MS)) return;
    // Start the next turn while the last sentence is still playing, but never
    // stack up more than one turn of queued speech.
    if (this.options.speech.pending() > 0) return;

    const plan = this.chooseTurn(now);
    if (plan) await this.runTurn(plan);
  }

  /**
   * Barge-in at a sentence boundary: stops writing and drops the queued
   * lines of any turn less important than `urgency`. The sentence on stage
   * plays to the end; the next tick picks the reaction, and the host learns
   * which of its lines never aired.
   */
  private yieldTo(urgency: number): void {
    if (this.paused || this.standby || urgency <= 0) return;
    const outranked = (kind: string | undefined) => kind !== undefined && kind in TURN_PRIORITY && TURN_PRIORITY[kind as TurnKind] < urgency;
    const { speech } = this.options;
    let yielded = outranked(speech.activeMeta()?.turnKind);
    if (this.engine.inFlight && outranked(this.engine.inFlight)) {
      this.engine.abort();
      yielded = true;
    }
    const dropped = speech.drop((meta) => outranked(meta?.turnKind));
    this.engine.unsaid("cut", dropped);
    if (yielded || dropped.length > 0) {
      this.skipGap = true;
      this.options.log?.debug(`yielding to a viewer event (${dropped.length} queued line${dropped.length === 1 ? "" : "s"} dropped)`);
    }
  }

  private setStandby(value: boolean): void {
    if (this.standby === value) return;
    this.standby = value;
    this.options.hooks?.onStandbyChange?.(value);
  }

  private chooseTurn(now: number): TurnPlan | undefined {
    const { triage, speech } = this.options;
    const games = this.options.games;
    const ranking = this.options.ranking;
    const game = [games?.hostContext() ?? ranking?.hostContext(), this.voteContext()].filter(Boolean).join("\n") || undefined;
    const segment = this.segment();
    const segmentEndsAt = this.segmentStartedAt + segment.minutes * 60_000;
    const base = {
      segment,
      stats: { viewers: this.viewers, likes: this.counters.likes, uptimeMinutes: this.stats().uptimeMinutes },
      clock: describeClock(now, this.persona.timezone),
      segmentLeftMin: Math.max(0, Math.ceil((segmentEndsAt - now) / 60_000)),
      ...(game ? { game } : {}),
      ...(this.music && this.music.endsAt > now ? { music: `"${this.music.title}" is playing (${Math.ceil((this.music.endsAt - now) / 1000)} s left).` } : {}),
      originAt: now,
    };

    if (!this.opened) {
      this.opened = true;
      // Whoever woke the show up gets greeted in the opening, not answered again right after it.
      const focus = this.takeFocus();
      return { ...base, kind: "opening", items: focus.items };
    }

    // Game moments are time-bound (a question just went up, an answer is being revealed, a podium place).
    const cue = games?.takeCue() ?? ranking?.takeCue();
    if (cue) {
      this.remember({ at: now, kind: "show", text: cue.history });
      return { ...base, kind: "game", items: [], note: cue.note, line: cue.line };
    }

    if (this.voteCue) {
      const voteCue = this.voteCue;
      this.voteCue = null;
      this.remember({ at: now, kind: "show", text: voteCue.history });
      return { ...base, kind: "game", items: [], note: voteCue.note, line: voteCue.line };
    }

    if (this.pendingRequest !== undefined) {
      const note = this.pendingRequest;
      this.pendingRequest = undefined;
      return { ...base, kind: "request", items: [], note };
    }

    // A game in progress (or the podium) finishes before the segment moves on (a forced change already stopped a segment's game).
    const gameHolds = this.forcedSegment === undefined && (games?.isActive() === true || ranking?.isRevealing() === true);
    const segmentDue = this.persona.segments.length > 1 && !gameHolds && now >= segmentEndsAt;
    // Overdue because chat kept the host talking past the end (not because the room was empty): move on now.
    const heldUp = segmentDue && now - segmentEndsAt >= SEGMENT_OVERDUE_MS && this.lastTurnAt >= segmentEndsAt;
    if (this.forcedSegment !== undefined) return this.changeSegment(now, base);
    if (heldUp && !this.reactOnly()) return this.advance(now, base);

    if (triage.pending() > 0) {
      const focus = this.takeFocus();
      if (focus.items.length) {
        const also = this.takeMilestone();
        const first = Math.min(...focus.items.map((item) => item.event.at));
        return {
          ...base,
          kind: "react",
          items: focus.items,
          brief: focus.brief,
          ...(also ? { also: `${also.note}: celebrate it in a few words.` } : {}),
          originAt: Number.isFinite(first) ? first : now,
        };
      }
    }

    const milestone = this.takeMilestone();
    if (milestone) return { ...base, kind: "milestone", items: [], note: milestone.note, line: milestone.line };

    if (this.reactOnly()) return undefined;

    if (segmentDue && speech.isIdle()) return this.advance(now, base);
    // A show with one segment loops it: each time it runs out is the end of a loop.
    if (this.persona.segments.length === 1 && !gameHolds && now >= segmentEndsAt && speech.isIdle()) {
      this.segmentStartedAt = now;
      const podium = this.endLoop(now, base);
      if (podium) return podium;
    }

    const deadAir = deadAirFor(this.viewers, this.options.deadAirMs);
    const quietFor = speech.silenceMs();
    if (quietFor >= deadAir && now - this.lastTurnAt >= deadAir) {
      return { ...base, kind: "filler", items: [], note: this.fillerNote(now) };
    }
    return undefined;
  }

  /**
   * The events a reaction covers: the gifts, follows and returning viewers
   * waiting, then the most important few messages, oldest first. Messages
   * older than the newest one picked are passed over; questions among them
   * come back in a quiet moment.
   */
  private takeFocus(): { items: QueueItem[]; brief: boolean } {
    const triage = this.options.triage;
    const inOrder = (a: QueueItem, b: QueueItem) => a.event.at - b.event.at || a.seq - b.seq;
    const support = triage.takeKinds(SUPPORT_KINDS, REACT_SUPPORT).sort(inOrder);
    const chat = triage.takeKinds(["chat", "question"], REACT_CHAT).sort(inOrder);
    const newest = chat.at(-1);
    if (newest) {
      const passed = triage.discard(
        (item) => (item.event.kind === "chat" || item.event.kind === "question") && inOrder(item, newest) < 0,
      );
      for (const item of passed) this.owe(item);
    }
    const brief = triage.pending() > 0 || support.length + chat.length > 5;
    return { items: [...support, ...chat], brief };
  }

  private owe(item: QueueItem): void {
    const event = item.event;
    if (event.kind !== "question" && !(event.kind === "chat" && event.text.includes("?"))) return;
    this.owed = [...this.owed, { event, at: this.now() }].slice(-OWED_MAX);
  }

  private takeMilestone(): { note: string; line: string } | undefined {
    if (this.pendingMilestone === undefined) return undefined;
    const crossed = this.pendingMilestone;
    this.pendingMilestone = undefined;
    // The note is for the model (English numbers); the line is spoken by the offline host (Brazilian numbers).
    return {
      note: `the stream just passed ${crossed.toLocaleString("en-US")} likes`,
      line: `Passamos de ${crossed.toLocaleString("pt-BR")} curtidas`,
    };
  }

  /** Moves to the next segment in the rotation; the last one ends the loop, and its podium goes first. */
  private advance(now: number, base: Omit<TurnPlan, "kind" | "items">): TurnPlan {
    if (this.segmentIndex === this.persona.segments.length - 1) {
      const podium = this.endLoop(now, base);
      if (podium) return podium;
    }
    return this.changeSegment(now, base);
  }

  /**
   * Every segment has played: reveals the loop's podium (the segment change
   * waits for it) and opens with its first moment. Without scores, the next
   * loop just starts.
   */
  private endLoop(now: number, base: Omit<TurnPlan, "kind" | "items">): TurnPlan | undefined {
    const ranking = this.options.ranking;
    if (!ranking?.startReveal()) return undefined;
    const cue = ranking.takeCue();
    if (!cue) return undefined;
    this.remember({ at: now, kind: "show", text: cue.history });
    return { ...base, game: ranking.hostContext(), kind: "game", items: [], note: cue.note, line: cue.line };
  }

  private changeSegment(now: number, base: Omit<TurnPlan, "kind" | "items">): TurnPlan {
    const nextIndex = this.forcedSegment ?? (this.segmentIndex + 1) % this.persona.segments.length;
    this.forcedSegment = undefined;
    const previous = this.segment();
    const nextSegment = this.persona.segments[nextIndex] as Segment;
    if (this.vote) this.closeVote(nextIndex === this.persona.segments.length - 1, now);
    if (nextIndex === 0) {
      this.loops += 1;
      this.finalGame = null;
    }
    this.segmentIndex = nextIndex;
    this.segmentStartedAt = now;
    this.options.stage.segment(nextSegment);
    this.options.hooks?.onSegment?.(nextSegment);
    this.remember({ at: now, kind: "show", text: `New segment: ${nextSegment.title}` });
    return { ...base, segment: previous, kind: "segment_change", items: [], nextSegment };
  }

  /** What a quiet moment is about: the game, a question the host owes, or the next idea in rotation. */
  private fillerNote(now: number): string {
    const games = this.options.games?.fillerNote();
    if (games) return games;
    if (this.options.ranking?.isRevealing()) return "The loop's podium is on screen. Celebrate the top players by name in a line or two and invite everyone to play in the next loop.";
    this.owed = this.owed.filter((owed) => now - owed.at < OWED_TTL_MS);
    // Only a question the host actually saw in a room (not one that scrolled by).
    while (this.owed.length) {
      const ref = this.engine.conversation.ref((this.owed.shift() as (typeof this.owed)[number]).event);
      if (ref) return `You didn't get to ${ref} earlier. Answer it now, saying who asked, then carry on.`;
    }
    const segment = this.segment();
    const chat = this.engine.conversation.hasViewerChat();
    let pick = FILLER_BEATS[this.fillerBeat++ % FILLER_BEATS.length] as (typeof FILLER_BEATS)[number];
    if (pick.needsChat && !chat) pick = FILLER_BEATS[this.fillerBeat++ % FILLER_BEATS.length] as (typeof FILLER_BEATS)[number];
    return `Keep the show alive for "${segment.title}" (${segment.prompt}). This time, ${pick.beat}`;
  }

  /** The game a segment plays: its own, or for the last segment, the one chat voted for. */
  private segmentGame(index: number): GameConfig | undefined {
    const segments = this.persona.segments;
    if (index === segments.length - 1 && this.finalGame) return this.finalGame;
    return segments[index]?.game;
  }

  /** Opens the vote on the last segment's game near the end of the second-to-last segment (ADR-0029). */
  private maybeOpenVote(now: number): void {
    const segments = this.persona.segments;
    if (this.vote || !this.opened || this.persona.finalVote === false || segments.length < 2) return;
    if (this.segmentIndex !== segments.length - 2 || this.finalGame) return;
    const endsAt = this.segmentStartedAt + this.segment().minutes * 60_000;
    if (now < Math.max(this.segmentStartedAt + VOTE_MIN_DELAY_MS, endsAt - VOTE_LEAD_MS)) return;
    const ballot = new FinalVote(voteOptions(this.loops));
    this.vote = { ballot, closesAt: endsAt };
    const last = segments[segments.length - 1] as Segment;
    const options = ballot.labels.map((label, i) => `${i + 1}) ${label}`).join(", ");
    this.voteCue = {
      note: `Chat gets to choose the minigame for the final segment, "${last.title}": ${options}. Announce it with energy, read the options, and tell chat to type the number (one vote each). The vote closes when this segment ends.`,
      line: `Vocês escolhem o jogo do quadro final! ${ballot.labels.map((label, i) => `${i + 1} para ${label}`).join(", ")}. Digitem o número!`,
      history: `A vote opened for the final segment's game: ${options}.`,
    };
    this.sound("start");
    this.options.log?.info("vote on the last segment's game opened");
  }

  /** Ends the vote: on the way into the last segment, the winner becomes its game. */
  private closeVote(apply: boolean, now: number): void {
    const vote = this.vote;
    this.vote = null;
    this.voteCue = null;
    if (!vote || !apply) return;
    const winner = vote.ballot.winner();
    const last = this.persona.segments[this.persona.segments.length - 1] as Segment;
    if (!winner) {
      this.remember({ at: now, kind: "show", text: `Nobody voted for the final segment's game; "${last.title}" goes ahead as planned.` });
      return;
    }
    this.finalGame = { kind: winner, rounds: last.game?.rounds ?? 5, ...(last.game?.topic ? { topic: last.game.topic } : {}) };
    const tally = vote.ballot.tally();
    const votes = vote.ballot.labels.map((label, i) => `${label} ${tally[i] ?? 0}`).join(", ");
    this.remember({ at: now, kind: "show", text: `Chat voted (${votes}): the final segment plays ${GAME_LABELS[winner]}. Say so when you introduce it.` });
    this.options.stage.fx?.("confetti", 1.2);
    this.sound("reveal");
  }

  /** The open vote as the host may see it. */
  private voteContext(): string | undefined {
    const vote = this.vote;
    if (!vote) return undefined;
    const tally = vote.ballot.tally();
    return `Chat is voting the final segment's game (type the number): ${vote.ballot.labels.map((label, i) => `${i + 1}) ${label}: ${tally[i] ?? 0}`).join(", ")}.`;
  }

  /** Keeps the stage's "up next" and like ranking current (sent only when they change). */
  private publishHud(now: number, force = false): void {
    const stage = this.options.stage;
    if (stage.vote) {
      const vote = this.vote;
      const tally = vote?.ballot.tally() ?? [];
      const key = vote ? `${vote.ballot.labels.join("|")}:${tally.join(",")}` : "";
      if (force || (key !== this.voteKey && (key === "" || this.voteKey === "" || now - this.voteSentAt >= LEADERS_EVERY_MS))) {
        this.voteKey = key;
        this.voteSentAt = now;
        stage.vote(vote ? { title: VOTE_TITLE, options: vote.ballot.labels, tally } : null);
      }
    }
    if (stage.schedule) {
      const items = this.standby ? [] : this.upNext(now);
      // Overdue items all read as "now", so their key doesn't change every tick.
      const key = items.map((item) => `${item.kind}|${item.title}|${item.at > now ? Math.round(item.at / 1000) : 0}`).join("\n");
      if (force || key !== this.scheduleKey) {
        this.scheduleKey = key;
        stage.schedule(items.map((item) => ({ kind: item.kind, title: item.title, inMs: Math.max(0, item.at - now) })));
      }
    }
    if (stage.leaders) {
      for (const board of LEADER_BOARDS) {
        const sent = this.boardSent[board];
        const revision = this.boards[board].revision();
        if (force || (revision !== sent.revision && now - sent.at >= LEADERS_EVERY_MS)) {
          sent.revision = revision;
          sent.at = now;
          stage.leaders(board, this.boards[board].top(LEADERS_MAX), WINDOWS[board] / 60_000);
        }
      }
    }
  }

  private clearBoards(): void {
    this.boards.likes.clear();
    this.boards.gifts.clear();
  }

  /** How a viewer shows on a ranking: blocklisted or injection-looking names read "visitante". */
  private boardName(viewer: Viewer): string {
    return displayName(viewer, this.blocklist()).slice(0, 24);
  }

  private blocklist(): readonly string[] {
    return this.options.blocklist?.() ?? [];
  }

  private remember(entry: RoomEntry): void {
    this.engine.conversation.add(entry);
  }

  private sound(sound: Sound): void {
    if (this.persona.sound?.effects !== false) this.options.stage.sfx?.(sound);
  }

  /** Starts the current segment's game when the segment has one and the room is ready for it. */
  private maybeStartSegmentGame(now: number): void {
    const games = this.options.games;
    const config = this.segmentGame(this.segmentIndex);
    // Not gated on a quiet room: on a busy stream it never is, and the game's cue gets its own turn.
    if (!games || !config || !this.opened || games.isActive() || this.options.ranking?.isRevealing() || this.reactOnly()) return;
    if (now - this.segmentStartedAt < SEGMENT_GAME_DELAY_MS || now - games.lastEndedAt() < GAME_BREAK_MS) return;
    const left = this.segmentStartedAt + this.segment().minutes * 60_000 - now;
    if (left < MIN_GAME_WINDOW_MS) return;
    const started = games.start(config, "segment", this.chatSample());
    if (started.ok) this.options.log?.info(`starting the segment's game (${config.kind})`);
  }

  private async runTurn(plan: TurnPlan): Promise<void> {
    this.lastTurnAt = this.now();
    this.skipGap = false;
    const result = await this.engine.run(plan);
    if (result.scrolledBy.length) {
      // The host never saw these, so no later turn may ask it to answer them.
      const gone = new Set(result.scrolledBy);
      this.options.triage.discard((item) => item.events.every((event) => gone.has(event)));
    }
    if (result.ok) {
      this.failures = 0;
      return;
    }
    this.failures += 1;
    const backoff = Math.min(30_000, 1_000 * 2 ** this.failures);
    this.cooldownUntil = this.now() + backoff;
    this.options.log?.warn(`turn failed; cooling down ${Math.round(backoff / 1000)}s`, result.error);
    this.options.hooks?.onTurnFailed?.(result.error);
  }
}

/** "Hora do quiz · Quiz", or just the title when it already names its game. */
function segmentTitle(segment: Segment, config = segment.game): string {
  if (!config) return segment.title;
  const game = gameTitle(config);
  const named = segment.title.toLowerCase().includes(GAME_LABELS[config.kind].toLowerCase());
  return named ? segment.title : `${segment.title} · ${game}`.slice(0, 60);
}

/** "Quiz" or "Quiz: futebol". */
function gameTitle(config: GameConfig): string {
  const label = GAME_LABELS[config.kind];
  return (config.topic ? `${label}: ${config.topic}` : label).slice(0, 60);
}
