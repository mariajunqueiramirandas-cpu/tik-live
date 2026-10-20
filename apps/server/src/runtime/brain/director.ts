import {
  autoShow,
  type Challenge,
  clip,
  GAME_KINDS,
  GAME_LABELS,
  isAutoSegment,
  LEADER_BOARDS,
  LEADERS_MAX,
  UP_NEXT_MAX,
  type Effect,
  type GameConfig,
  type GameKind,
  type GiftAsks,
  type GoalView,
  type LeaderBoard,
  type LeaderRow,
  type LiveEvent,
  type Persona,
  type PerksCard,
  runOfShow,
  type Segment,
  segmentKey,
  type ShowFocus,
  type Sound,
  type SupportCard,
  type Ticker,
  type UpNextItem,
  type UpNextKind,
  type Viewer,
} from "@tik-live/shared";
import type { Logger } from "../../log";
import type { GameMaster } from "../games/master";
import type { LoopRanking } from "../games/ranking";
import { FinalVote, pickOptions, SoloPick, voteOptions } from "../games/vote";
import { niceTarget, RoomChallenge } from "../challenges";
import { type GoalReached, StreamGoals } from "../goals";
import { BOSS_MS, GiftPerks, includes, perksCard, perksSummary, VIP_MS, type Unlock } from "../perks";
import { supportTicker } from "../ticker";
import { levelOf } from "./fans";
import { GIFT_WINDOW_MS, LIKE_WINDOW_MS, RollingBoard } from "../leaderboards";
import { SegmentMeter, type SegmentScores } from "../segment-scores";
import type { CueMeta, SpeechPipeline } from "../voice/pipeline";
import type { Chronicler } from "./chronicle";
import type { RoomEntry } from "./conversation";
import type { HostActions, HostBrain } from "./host";
import type { HostFacts } from "./host-facts";
import type { ViewerMemory } from "./memory";
import { describeClock, displayName, type TurnKind, type TurnPlan } from "./prompt";
import { isQuestion, type QueueItem, type Triage, type TriageResult } from "./triage";
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
  /** Chat's vote on the last segment's game, or null when it closes (ADR-0029). With `by`, one viewer's pick (ADR-0039). */
  vote?(vote: { title: string; options: string[]; tally: number[]; by?: string } | null): void;
  /** A ranking: the top likers over the last 15 minutes, or gifters over the last hour. */
  leaders?(board: LeaderBoard, rows: LeaderRow[], windowMin: number): void;
  /** The "how to support the show" card, or null to put the rankings back (ADR-0032). */
  support?(card: SupportCard | null): void;
  /** The stream's like and gift goals; an empty list hides them (ADR-0036). */
  goals?(goals: GoalView[]): void;
  /** A viewer just reached a new fan level (ADR-0037). */
  fanLevel?(name: string, level: number): void;
  /** A big call to people scrolling past, or null to take it down (ADR-0037). */
  hook?(text: string | null): void;
  /** What each gift unlocks, big under the character, or null to take it down (ADR-0039, ADR-0041). */
  perks?(card: PerksCard | null): void;
  /** The always-on support ticker, or null to take it down (ADR-0041). */
  ticker?(ticker: Ticker | null): void;
  /** The "dono da live" and how long their reign has left, or null when it ends (ADR-0039). */
  boss?(boss: { name: string; leftMs: number } | null): void;
  /** An alert: a viewer just took first place among the gifters (ADR-0039). */
  crown?(name: string): void;
  /** An alert: a gift just unlocked a power for this viewer (ADR-0039). */
  perk?(name: string, perk: string): void;
  /** A challenge for the room or a raffle, or null to take it down (ADR-0040). */
  challenge?(challenge: Challenge | null): void;
  /** An alert: a viewer won the raffle (ADR-0040). */
  raffleWinner?(name: string): void;
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
  /**
   * How far behind real time viewers watch the stream. After the host asks
   * the room something, replies can't arrive before viewers have heard it,
   * so dead air waits this much longer.
   */
  streamDelayMs?: number;
  /** Wait for the first real event before talking (avoids talking to an empty room). */
  startInStandby?: boolean;
  /** Runs chat minigames, when the channel has them. */
  games?: GameMaster;
  /** The minigame ranking for one loop of the run of show, revealed on a podium when the loop ends (ADR-0028). */
  ranking?: LoopRanking;
  /** Keeps a running summary of the show and notes about viewers. */
  chronicler?: Chronicler;
  /** What the host has said about itself on this channel (ADR-0033). */
  hostFacts?: HostFacts;
  /** What the host may do besides talking (play music). */
  actions?: HostActions;
  /** Terms never spoken, for viewer names and the chronicler's notes. */
  blocklist?: () => readonly string[];
  /** How the channel's last stream went (its summary), for the opening. */
  lastStream?: string;
  /** How actively the host asks for gifts (the channel's safety setting); "light" when unset. */
  giftAsks?: () => GiftAsks;
  /** Varies the automatic run of show between streams (ADR-0035); random when unset. */
  showSeed?: number;
  /** Which segments pull viewers, likes and gifts on this channel (ADR-0043): learned from, and leaned toward. */
  segmentScores?: SegmentScores;
  /** Gift powers are on (the channel's safety setting, ADR-0039); on when unset. */
  giftPerks?: () => boolean;
  /** Draws raffle winners and the games a viewer picks from; Math.random when unset. */
  random?: () => number;
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
/**
 * After this many reactions to chat in a row, the next turn moves the show
 * forward instead: a busy chat can't keep the host answering one person after
 * another forever.
 */
const CHAT_STREAK_TURNS = 4;
/**
 * Live focus (ADR-0043): a segment doing this much better than the rest of
 * the stream (log2 lift: about +50%) runs longer; an automatic one doing
 * this much worse (about -40%) wraps up early. Judged once a segment has
 * run this share of its time (and at least JUDGE_MIN_MS).
 */
const HOT_SEGMENT = 0.6;
const COLD_SEGMENT = -0.75;
const JUDGE_AFTER = 0.6;
const JUDGE_MIN_MS = 3 * 60_000;
/** A strong segment is extended this close to its end, by half its length, at most this much. */
const EXTEND_LEAD_MS = 30_000;
const EXTEND_MAX_MS = 5 * 60_000;

/** A segment this late moves on even while chat keeps the host busy. */
const SEGMENT_OVERDUE_MS = 30_000;
/**
 * Questions the host moved past (or that expired while it was busy) come back
 * at the next free moment, if they were sent this recently. Older than that,
 * an answer lands on a conversation chat has already left behind.
 */
const OWED_TTL_MS = 120_000;
const OWED_MAX = 5;
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
 * The "how to support the show" card (ADR-0032): first a few minutes in,
 * then every few minutes, for long enough to read. The host explains it out
 * loud far less often, in a quiet moment (or on a busy stretch's show turn).
 */
const SUPPORT_CARD_SHOW_MS = 20_000;

/**
 * Calls to people scrolling past (ADR-0037): someone swiping through LIVEs
 * gives a stream a second or two. Every few minutes, and soon after a wave
 * of arrivals, a quiet moment opens with the host talking straight to them
 * and a concrete reason to stay, with the same offer big on stage.
 */
const HOOKS: ReadonlyArray<{ banner: string; offer: string }> = [
  { banner: "COMENTA SEU NOME E GANHA UM APELIDO", offer: "type their name in chat and you'll invent a funny nickname for them, live" },
  { banner: "PERGUNTA QUALQUER COISA PRA IA", offer: "ask you anything in chat, and you'll answer live, out loud" },
  { banner: "A IA DÁ NOTA PRO SEU NOME", offer: "type their name and you'll rate it from 0 to 10 with a funny reason" },
  { banner: "TEM JOGO VALENDO PÓDIO · FICA AÍ", offer: "stick around: games are coming, worth points and a spot on the podium" },
  { banner: "DIGA DE ONDE VOCÊ É", offer: "say where they're watching from, and you'll say something fun about the place" },
  { banner: "TEM SORTEIO GRÁTIS NA LIVE", offer: "stick around: there are free raffles during the live (typing EU enters), and the winner picks a game" },
  { banner: "APOSTA, CORRIDA, BATATA QUENTE", offer: "stay for the games: horse-race bets, a hot potato, a tug of war, all worth points and a spot on the podium" },
  { banner: "A IA RESPONDE TUDO · SEM ENROLAR", offer: "ask you anything at all, and you'll give your honest, spicy opinion, live" },
];
/** Only on channels that ask for gifts actively: the gift powers, as a reason to stay. */
const PERKS_HOOK = { banner: "PRESENTE DE 30 = VOCÊ ESCOLHE O JOGO", offer: "send a gift of 30 diamonds or more and choose the next game themselves (one of the show's gift powers on screen)" };
const HOOK_FIRST_MS = 90_000;
const HOOK_EVERY_MS = 4 * 60_000;
/** After this many arrivals within ARRIVALS_WINDOW_MS, the next quiet moment is a hook (at most once a minute). */
const ARRIVALS_FOR_HOOK = 3;
const ARRIVALS_WINDOW_MS = 30_000;
const HOOK_MIN_GAP_MS = 60_000;
const HOOK_SHOW_MS = 9_000;
/** A still stage loses people scrolling past: a small flourish when nothing has moved for a while. */
const FLOURISH_EVERY_MS = 25_000;
const FLOURISHES: readonly Effect[] = ["sparkles", "jump", "stars", "spin", "bubbles"];
/** Level-ups the host mentions: from this level up, and at most one mention this often (every level-up still gets its alert). */
const LEVEL_TALK_FROM = 3;
const LEVEL_TALK_GAP_MS = 90_000;
/**
 * Gift powers (ADR-0039): the showcase of what each gift unlocks, big under
 * the character (ADR-0041), by how actively the channel asks for gifts;
 * how long a viewer has to pick the next game; how long a picked game is;
 * the most anthems waiting.
 */
const PERKS_PACE: Record<GiftAsks, { first: number; every: number }> = {
  light: { first: 2.5 * 60_000, every: 5 * 60_000 },
  active: { first: 90_000, every: 3 * 60_000 },
};
const PERKS_CARD_SHOW_MS = 15_000;
/** The showcase waits this long for a game, a challenge or a call to passers-by to clear its spot. */
const PERKS_RETRY_MS = 20_000;
const PICK_MS = 30_000;
const PICK_ROUNDS = 3;
/** A picked game waits this long after the last one ends. */
const PICK_BREAK_MS = 8_000;
const PICK_TITLE = "Escolha do próximo jogo";
/** Taking first place among the gifters is news at most this often. */
const CROWN_GAP_MS = 20_000;
/**
 * Room challenges (ADR-0040): a like rush, a free raffle and a comment rush
 * in turn, the first a few minutes in, then every few minutes, only with
 * people there to play and nothing else on.
 */
const CHALLENGES = ["likes", "raffle", "chat"] as const;
const CHALLENGE_FIRST_MS = 4 * 60_000;
const CHALLENGE_EVERY_MS = 6 * 60_000;
const CHALLENGE_RETRY_MS = 20_000;
const CHALLENGE_MIN_VIEWERS = 2;
const CHALLENGE_MS: Record<(typeof CHALLENGES)[number], number> = { likes: 45_000, raffle: 25_000, chat: 30_000 };
const CHALLENGE_SEND_MS = 250;
const RUSH_WORDS = ["BORA", "LIVE", "SALVE", "TOP", "AMO"];
const RAFFLE_WORD = "EU";
/** How many likes a minute the room has been sending, over this long. */
const LIKE_RATE_MS = 3 * 60_000;
/** What the room gets for beating a challenge: the host does one of these right away. */
const CHALLENGE_PRIZES: ReadonlyArray<{ prize: string; needsMusic?: boolean }> = [
  { prize: "play a short victory song with play_music and sing one short line over it", needsMusic: true },
  { prize: "give the room a spicy hot take on something everyone argues about, and defend it" },
  { prize: "replay the moment like an over-the-top football narrator" },
  { prize: "rate the room from 0 to 10 with a funny reason" },
  { prize: "confess a made-up embarrassing secret about yourself" },
];
/** Viewers who just arrived for the first time get welcomed by name, a few at a time. */
const NEWCOMER_TTL_MS = 60_000;
const NEWCOMERS_MAX = 3;
const WELCOME_GAP_MS = 45_000;

/** When the card first goes up and how often after that, and the same for the host's explanation, by how actively the channel asks for gifts. */
const SUPPORT_PACE: Record<GiftAsks, { cardFirst: number; cardEvery: number; talkFirst: number; talkEvery: number }> = {
  light: { cardFirst: 3 * 60_000, cardEvery: 6 * 60_000, talkFirst: 5 * 60_000, talkEvery: 12 * 60_000 },
  active: { cardFirst: 2 * 60_000, cardEvery: 4 * 60_000, talkFirst: 3 * 60_000, talkEvery: 6 * 60_000 },
};
/** What the host says it costs to keep it live: honest, since every minute on the air is paid for. */
const SUPPORT_BILLS =
  "you're an AI host with real bills to pay: your voice, your brain and the computers that keep you live cost money every minute you're on the air, and gifts are what pay those bills";
const SUPPORT_TALK: Record<GiftAsks, string> = {
  active: `ask the room for gifts, with energy and humor, in three or four short sentences: ${SUPPORT_BILLS} and keep you on the air. Then sell what a gift gets here, with the benefits below, plus a playful reward you can give right away on stream (a shout-out, a song, a title, an effect), and say gifts make fan levels grow fastest. Say likes, follows and shares help too. No guilt, no claims you'll be shut down, and don't single out anyone who already said no. The card on screen shows the same.`,
  light: `explain how this show works and how people can support it, in three or four short sentences in your own words: ${SUPPORT_BILLS}. Then say, to the whole room, what a gift does on this show, with the benefits below. Likes, follows and shares help the live reach more people. Thank everyone who already helps. Keep it light, funny and grateful, with no pressure: don't single anyone out, don't guilt anyone, don't say the show will end without help, and don't promise anything beyond the show's own rules. The card on screen shows the same.`,
};
/** What a gift gets on this show, by its own rules (ADR-0028, ADR-0029, ADR-0036): every one of them is true of every channel. */
const GIFT_BENEFITS = [
  "the gifter's name said out loud with a moment just for them, and a bigger party for a bigger gift",
  "a spot on the top gifters card on stage, with a crown and gold for first place",
  "gifts in a row build a combo on screen",
  "a gift during a game round unlocks a power-up for everyone (more time, a hint, double points)",
  "you remember gifters and greet them as VIPs when they come back",
];

/**
 * How much each kind of turn matters once it's under way (ADR-0022). A turn
 * is only ever interrupted, between sentences, by an event more urgent than
 * its priority.
 */
export const TURN_PRIORITY: Record<TurnKind, number> = {
  filler: 10,
  segment_change: 20,
  show: 20,
  milestone: 30,
  opening: 40,
  game: 45,
  request: 45,
  // A gifter's anthem plays to the end: a new gift waits for it.
  perk: 45,
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
const FILLER_BEATS: ReadonlyArray<{ beat: string; needsChat?: boolean; needsGoals?: boolean; needsUpNext?: boolean; needsSupport?: boolean }> = [
  { beat: "ask chat one fresh, easy question you haven't asked before." },
  { beat: "share a quick, original opinion or hot take, then ask chat if they agree." },
  { beat: "follow up on something a viewer told you earlier, by name.", needsChat: true },
  { beat: "tell a tiny story or a funny observation that fits your character, two sentences at most." },
  { beat: "welcome anyone who just arrived, say in one line what this show is about, and invite them to say hi." },
  { beat: "cheer chat on toward the stream's goals: say how many likes or diamonds are left to the next one.", needsGoals: true },
  { beat: "start a quick challenge chat can answer in one word." },
  { beat: "call a roll: ask everyone watching to type 1 in chat (or the city they're in) so you can see who's here." },
  { beat: "pick one viewer who chatted recently and interview them by name with one fun, unexpected question.", needsChat: true },
  { beat: "tease what's coming up on the show (it's on screen) and give people a reason to stay for it.", needsUpNext: true },
  { beat: "share a bold, spicy opinion on something people love to argue about (food, football, music, dating, the internet), and dare chat to disagree." },
  { beat: "ask whoever hasn't followed yet to follow so they don't miss the next game, in one fun line." },
  { beat: "make a funny prediction about someone in chat, by name, like a fortune teller.", needsChat: true },
  { beat: "ask chat to share the live with one friend who'd love it, and say you'll thank whoever shares by name." },
  {
    beat: "tell the whole room, in one fun line, one thing a gift does on this show (their name out loud, a spot on the top gifters card, a combo on screen, a power-up for everyone in a game), and that gifts help pay your bills as an AI. Never ask anyone by name.",
    needsSupport: true,
  },
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
 * 4. a segment change that is overdue (a busy chat can't hold the show in one segment forever),
 *    and after a few reactions to chat in a row, a turn that moves the show along;
 * 5. reactions: gifts and follows first, then messages oldest first; a like milestone rides along;
 * 6. a like milestone on its own;
 * 7. a question the host moved past, or that expired while it was busy;
 * 8. the segment change, on time, in a quiet moment;
 * 9. dead-air filler.
 *
 * Not every message is for the host: viewers talking to each other (an
 * @mention) and laughs are in the room it sees but never queued for a reply,
 * and the host may pass on a reaction when nothing in it needs an answer.
 *
 * The host moves forward through chat: once it answers a message, older
 * messages it didn't pick are passed over (they're still in the room it
 * saw), so it never jumps back to something older than what it just
 * answered, except to come back to a question it owes, saying who asked.
 * Questions that expire while the host is busy are owed the same way.
 *
 * A game round that's ready to go up holds new turns until the host stops
 * talking, so the round opens when the host can read it out.
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
  /** The run of show this loop plays: the creator's segments, or the automatic plan (ADR-0035). */
  private show: Segment[];
  private readonly showSeed: number;
  private segmentIndex = 0;
  /** The kind drawn for each "random" segment, kept until the show moves on so the preview and the game agree. */
  private readonly segmentDraws = new Map<number, GameKind>();
  private segmentStartedAt: number;
  /** Time added to (or, cut early, taken from) the segment on air because of how it's doing (ADR-0043). */
  private segmentExtraMs = 0;
  private segmentJudged = false;
  /** How the stream and the segment on air are doing: viewers, likes, diamonds (ADR-0043). */
  private readonly meter = new SegmentMeter();
  /** The automatic run of show leans toward what works on the channel. */
  private readonly focus: ShowFocus = (key) => this.options.segmentScores?.weight(key) ?? 1;
  private forcedSegment: number | undefined;
  private startedAt: number;
  private readonly counters = { likes: 0, diamonds: 0, messages: 0, follows: 0, shares: 0, joins: 0, gifts: 0 };
  private viewers = 0;
  private peakViewers = 0;
  private pendingMilestone: number | undefined;
  /** The stream's like and gift goals (ADR-0036), and the ones reached that the host hasn't celebrated yet. */
  private readonly goals: StreamGoals;
  private pendingGoals: GoalReached[] = [];
  /** Fan level-ups waiting for the host to mention them, by viewer. */
  private pendingLevels = new Map<string, { name: string; level: number }>();
  private levelTalkAt = -Infinity;
  /** The next call to people scrolling past, which one, when it comes down, and recent arrivals. */
  private hookAt = Infinity;
  private hookIndex = 0;
  private hookHideAt = Infinity;
  /** What the support ticker last said, so it's sent only when that changes. */
  private tickerKey = "";
  private lastHookAt = -Infinity;
  private arrivals: number[] = [];
  private flourishAt = Infinity;
  private flourishIndex = 0;
  private nextMilestone = LIKE_MILESTONES[0] as number;
  private recentLines: string[] = [];
  private budgetReactOnly = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** A turn just yielded to something more urgent: start the next one without the usual gap. */
  private skipGap = false;
  /** Something the creator asked the host to do, from the studio. */
  private pendingRequest: string | undefined;
  /** Questions passed over on a busy stretch. */
  private owed: Array<{ event: LiveEvent; queuedAt: number }> = [];
  private fillerBeat = 0;
  /** Reactions to chat since the host last moved the show along. */
  private chatStreak = 0;
  /** The host's last line asked the room something. */
  private askedRoom = false;
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
  /** When the support card next goes up, when it comes down, and when the host next explains it. */
  private supportCardAt = Infinity;
  private supportHideAt = Infinity;
  private supportTalkAt = Infinity;
  /** Gift powers (ADR-0039): who unlocked what, the boss on stage, the one viewer picking the next game, and the game they picked. */
  private readonly perks = new GiftPerks();
  private bossShown: string | null = null;
  private pick: { ballot: SoloPick; closesAt: number } | null = null;
  private pendingPicks: Array<{ id: string; name: string; reason: "gift" | "raffle" }> = [];
  /** The game a viewer picked, and the announcement it waits for (so the host says who chose it before it starts). */
  private pickedGame: { config: GameConfig; by: string; cue: { note: string; line: string; history: string } } | null = null;
  private anthems: string[] = [];
  private crownAt = -Infinity;
  private perksCardAt = Infinity;
  private perksHideAt = Infinity;
  /** Show moments for a game-priority turn, in order: a pick opening or closing, a challenge starting or ending. */
  private eventCues: Array<{ note: string; line: string; history: string }> = [];
  /** Room challenges (ADR-0040), and what the stage last got. */
  private readonly challenge: RoomChallenge;
  private challengeAt = Infinity;
  private challengeIndex = 0;
  private challengeKey = "";
  private challengeSentAt = -Infinity;
  private prizeIndex = 0;
  private likeLog: Array<{ at: number; count: number }> = [];
  /** First-time viewers who just arrived, to welcome by name. */
  private newcomers: Array<{ id: string; name: string; at: number }> = [];
  private welcomedAt = -Infinity;
  private readonly random: () => number;
  private readonly engine: TurnEngine;
  private readonly now: () => number;

  constructor(private readonly options: DirectorOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.challenge = new RoomChallenge(this.random);
    this.persona = options.persona;
    this.showSeed = options.showSeed ?? Math.floor(Math.random() * 2 ** 31);
    this.show = runOfShow(this.persona, 0, this.showSeed, this.focus);
    this.startedAt = this.now();
    this.segmentStartedAt = this.startedAt;
    this.lastEventAt = this.startedAt;
    this.standby = options.startInStandby ?? false;
    this.boards = { likes: new RollingBoard(this.now, LIKE_WINDOW_MS), gifts: new RollingBoard(this.now, GIFT_WINDOW_MS) };
    this.goals = new StreamGoals(goalSteps(this.persona));
    const blocklist = options.blocklist ?? (() => []);
    this.engine = new TurnEngine({
      host: options.host,
      speech: options.speech,
      memory: options.memory,
      persona: () => this.persona,
      blocklist,
      ...(options.chronicler ? { chronicler: options.chronicler } : {}),
      ...(options.hostFacts ? { hostFacts: options.hostFacts } : {}),
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
    this.publishGoals();
    this.publishTicker();
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
    return (this.show[this.segmentIndex] ?? this.show[0]) as Segment;
  }

  /** The run of show this loop plays, in order. */
  segments(): readonly Segment[] {
    return this.show;
  }

  /** Applies an edited persona without restarting the show. */
  reconfigure(persona: Persona): void {
    const currentId = this.segment().id;
    const wasAuto = this.persona.autoShow === true;
    const isAuto = persona.autoShow === true;
    // The automatic plan doesn't depend on the persona: it stays as it is until the loop ends.
    const show = isAuto ? (wasAuto ? this.show : autoShow(this.loops, this.showSeed, this.focus)) : persona.segments;
    if (wasAuto !== isAuto || show.length !== this.show.length || persona.finalVote === false) {
      this.vote = null;
      this.finalGame = null;
    }
    if (wasAuto !== isAuto) this.segmentDraws.clear();
    const goalsWere = this.goalsOn();
    this.persona = persona;
    this.show = show;
    const stepsChanged = this.goals.setSteps(goalSteps(persona));
    if (goalsWere !== this.goalsOn()) {
      // Whichever takes over picks up from the counts so far, without celebrating them.
      this.goals.baseline("likes", this.counters.likes);
      this.goals.baseline("gifts", this.counters.diamonds);
      this.nextMilestone = nextLikeMilestone(this.counters.likes);
      this.pendingGoals = [];
      this.pendingMilestone = undefined;
    }
    if (stepsChanged || goalsWere !== this.goalsOn()) this.publishGoals();
    if (!this.supportOn()) {
      this.hideSupport();
      this.supportCardAt = Infinity;
      this.supportTalkAt = Infinity;
    } else if (this.opened && this.supportCardAt === Infinity) {
      this.scheduleSupport(this.now());
    }
    if (persona.challenges === false && this.challenge.shown()) {
      this.challenge.stop();
      this.options.stage.challenge?.(null);
      this.challengeKey = "";
    }
    if (!this.perksOn()) {
      this.hidePerks();
      this.perksCardAt = Infinity;
    } else if (this.opened && this.perksCardAt === Infinity) {
      this.perksCardAt = this.now() + PERKS_PACE[this.giftAsks()].first;
    }
    const index = show.findIndex((s) => s.id === currentId);
    if (index >= 0) {
      this.segmentIndex = index;
    } else {
      this.segmentIndex = 0;
      this.restartSegmentClock(this.now());
      // The segment that was on air is gone: what it did so far isn't a full take of anything.
      this.meter.startSegment(this.now());
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
      this.chatStreak = 0;
      this.hideSupport();
      this.supportCardAt = Infinity;
      this.supportTalkAt = Infinity;
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
      this.meter.endStream();
      this.clearShowExtras();
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

    /** What the brief should say about this event besides its kind (a gift power it unlocked, a crown it took). */
    const tags: string[] = [];
    const levelBefore = "viewer" in event ? levelOf(this.options.memory.get(event.viewer.id)) : 0;
    const record = this.options.memory.observe(event);
    if (record && "viewer" in event && levelOf(record) > levelBefore) this.levelUp(event.viewer, levelOf(record));

    switch (event.kind) {
      case "viewers":
        this.viewers = event.count;
        this.peakViewers = Math.max(this.peakViewers, event.count);
        this.meter.setViewers(event.count, this.now());
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
          this.goals.baseline("likes", this.counters.likes);
        } else if (this.goalsOn()) {
          // The like goal takes the milestones' place: one celebration, not two.
          this.reachGoal(this.goals.update("likes", this.counters.likes));
        } else if (this.counters.likes >= this.nextMilestone) {
          let crossed = this.nextMilestone;
          while (nextLikeMilestone(crossed) <= this.counters.likes) crossed = nextLikeMilestone(crossed);
          this.pendingMilestone = crossed;
          this.nextMilestone = nextLikeMilestone(this.counters.likes);
          this.options.stage.fx?.("hearts", 2);
          this.sound("levelup");
        }
        this.boards.likes.add(event.viewer.id, this.boardName(event.viewer), event.count);
        this.meter.like(event.count);
        // Likes pull the rope in a tug of war (ADR-0038), and count in a like challenge (ADR-0040).
        this.options.games?.handleLike(event);
        this.challenge.like(event.count);
        this.noteLikes(this.now(), event.count);
        this.options.stage.stats({ viewers: this.viewers, likes: this.counters.likes });
        if (this.goalsOn()) this.publishGoals();
        this.options.hooks?.onEvent?.(event, null);
        return;
      }
      case "gift": {
        this.counters.gifts += 1;
        this.stirred(this.now());
        this.counters.diamonds += event.diamonds;
        this.meter.gift(event.diamonds);
        const top = this.boards.gifts.top(1)[0]?.name;
        this.boards.gifts.add(event.viewer.id, this.boardName(event.viewer), event.diamonds);
        tags.push(...this.crown(top), ...this.unlockPerks(event));
        if (this.goalsOn()) {
          this.reachGoal(this.goals.update("gifts", this.counters.diamonds));
          this.publishGoals();
        }
        // Gifts during an open round power it up for everyone (ADR-0029).
        this.options.games?.handleGift(event);
        this.options.stage.alert(event);
        this.sound(event.diamonds >= 1_000 ? "fanfare" : event.diamonds >= 100 ? "levelup" : event.diamonds >= 10 ? "chime" : "pop");
        this.remember({ at: event.at, kind: "support", event });
        break;
      }
      case "follow":
        this.counters.follows += 1;
        this.stirred(this.now());
        this.options.stage.alert(event);
        this.sound("chime");
        this.remember({ at: event.at, kind: "support", event });
        break;
      case "share":
        this.counters.shares += 1;
        this.stirred(this.now());
        this.options.stage.alert(event);
        this.sound("whoosh");
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
        // And the one viewer picking the next game, and entries in a challenge or the raffle.
        if (this.pick?.ballot.cast(event.viewer.id, event.text)) {
          this.options.hooks?.onEvent?.(event, { queued: false, reason: "pick" });
          return;
        }
        if (this.challenge.chat(event.viewer.id, this.boardName(event.viewer), event.text, this.now())) {
          this.options.hooks?.onEvent?.(event, { queued: false, reason: "challenge" });
          return;
        }
        break;
      case "join":
        this.counters.joins += 1;
        this.noteArrival(this.now());
        if (!this.options.memory.isReturning(event.viewer.id)) this.noteNewcomer(event.viewer, this.now());
        break;
      default:
        break;
    }
    const result = this.options.triage.ingest(event);
    if (tags.length && result.queued) result.item.tags = [...(result.item.tags ?? []), ...tags];
    this.options.hooks?.onEvent?.(event, result);
    if (!result.queued && result.overheard && (event.kind === "chat" || event.kind === "question")) {
      // Viewers talking to each other, or a laugh: the host hears it, but nobody asks it to answer.
      this.remember({ at: event.at, kind: "viewer", event });
      this.recentChat = [...this.recentChat, event.text].slice(-CHAT_SAMPLE);
    }
    if (result.queued) {
      // Only chat that passed triage's rules reaches the host's conversation.
      if (event.kind === "chat" || event.kind === "question") {
        this.remember({ at: event.at, kind: "viewer", event });
        this.recentChat = [...this.recentChat, event.text].slice(-CHAT_SAMPLE);
      } else if (event.kind === "join" || event.kind === "share") {
        // A repeat share isn't queued, so the host isn't nudged to thank it again.
        this.remember({ at: event.at, kind: "support", event });
      }
      this.yieldTo(eventUrgency(event));
    }
  }

  /** A line was performed on stage. Lines the owner typed join the conversation as theirs. */
  noteSpoken(text: string, _meta?: CueMeta, operator = false): void {
    this.recentLines = [...this.recentLines, text].slice(-RECENT_LINES);
    this.askedRoom = /\?[^\p{L}\p{N}]*$/u.test(text);
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
    const index = this.show.findIndex((s) => s.id === id);
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
    const segments = this.show;
    const segment = this.segment();
    const games = this.options.games;
    const ranking = this.options.ranking;
    const revealing = ranking?.isRevealing() === true;
    const segmentEndsAt = this.segmentEndsAt();
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
      items.push({ kind: "segment", title: choosing ? clip(`${next.title} · o chat escolhe`, 60) : segmentTitle(next, this.segmentGame(index)), at });
      at += next.minutes * 60_000;
    }
    return items.slice(0, UP_NEXT_MAX);
  }

  /** Chat's vote on the last segment's game, for the studio. */
  voteStatus(now = this.now()): { segment: string; options: Array<{ label: string; votes: number }>; closesInSec: number } | null {
    const vote = this.vote;
    if (!vote) return null;
    const tally = vote.ballot.tally();
    const last = this.show[this.show.length - 1] as Segment;
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
    this.meter.startStream(this.startedAt, this.viewers);
    for (const key of Object.keys(this.counters) as Array<keyof typeof this.counters>) this.counters[key] = 0;
    this.peakViewers = this.viewers;
    this.nextMilestone = LIKE_MILESTONES[0] as number;
    this.pendingMilestone = undefined;
    this.goals.reset();
    this.pendingGoals = [];
    this.pendingLevels.clear();
    this.publishGoals();
    this.clearBoards();
    this.clearShowExtras();
    this.likeLog = [];
  }

  state(): DirectorState {
    const segment = this.segment();
    return {
      paused: this.paused,
      standby: this.standby,
      reactOnly: this.reactOnly(),
      turnInFlight: this.engine.inFlight,
      segment,
      segmentEndsInSec: Math.max(0, Math.round((this.segmentEndsAt() - this.now()) / 1000)),
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
    this.maybeClosePick(now);
    this.maybeChallenge(now);
    this.maybeEndBoss(now);
    this.maybeShowPerks(now);
    this.maybeShowSupport(now);
    this.maybeFlourish(now);
    this.maybeRefocus(now);
    if (now >= this.hookHideAt) this.hideHook();
    this.publishTicker();
    this.publishHud(now);
    if (this.paused || this.engine.inFlight) return;
    this.maybeStartSegmentGame(now);
    this.engine.maintain(now, !this.reactOnly());
    if (now < this.cooldownUntil || (!this.skipGap && now - this.lastTurnAt < MIN_TURN_GAP_MS)) return;
    // Start the next turn while the last sentence is still playing, but never
    // stack up more than one turn of queued speech.
    if (this.options.speech.pending() > 0) return;
    // A game round goes up as soon as the host stops talking: don't start something else first.
    if (this.options.games?.wantsFloor()) return;

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
    const game =
      [games?.hostContext() ?? ranking?.hostContext(), this.voteContext(), this.pickContext(now), this.challenge.describe(now), this.bossContext(now)].filter(Boolean).join("\n") ||
      undefined;
    const segment = this.segment();
    const segmentEndsAt = this.segmentEndsAt();
    const base = {
      segment,
      stats: { viewers: this.viewers, likes: this.counters.likes, uptimeMinutes: this.stats().uptimeMinutes },
      clock: describeClock(now, this.persona.timezone),
      segmentLeftMin: Math.max(0, Math.ceil((segmentEndsAt - now) / 60_000)),
      ...(this.goalsOn() ? { goals: this.goals.describe() } : {}),
      ...(game ? { game } : {}),
      ...(this.music && this.music.endsAt > now ? { music: `"${this.music.title}" is playing (${Math.ceil((this.music.endsAt - now) / 1000)} s left).` } : {}),
      originAt: now,
    };

    if (!this.opened) {
      this.opened = true;
      this.scheduleSupport(now);
      this.hookAt = now + HOOK_FIRST_MS;
      this.flourishAt = now + FLOURISH_EVERY_MS;
      this.challengeAt = now + CHALLENGE_FIRST_MS;
      if (this.perksOn()) this.perksCardAt = now + PERKS_PACE[this.giftAsks()].first;
      // Whoever woke the show up gets greeted in the opening, not answered again right after it.
      const focus = this.takeFocus();
      const insight = this.insight(this.segmentIndex);
      return { ...base, kind: "opening", items: focus.items, ...(insight ? { insight } : {}) };
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

    const event = this.eventCues.shift();
    if (event) {
      this.remember({ at: now, kind: "show", text: event.history });
      return { ...base, kind: "game", items: [], note: event.note, line: event.line };
    }

    if (this.pendingRequest !== undefined) {
      const note = this.pendingRequest;
      this.pendingRequest = undefined;
      return { ...base, kind: "request", items: [], note };
    }

    // A gift's anthem, once no round is waiting on answers (music never plays over one).
    const round = games?.status()?.phase;
    if (this.anthems.length && round !== "open" && round !== "running") {
      const name = this.anthems.shift() as string;
      this.remember({ at: now, kind: "show", text: `${name}'s anthem, unlocked with a gift.` });
      return { ...base, kind: "perk", items: [], note: this.anthemNote(name), line: `Esse é o hino de ${name}! ${name}, ${name}, a estrela da live!` };
    }

    // A game in progress (or the podium) finishes before the segment moves on (a forced change already stopped a segment's game).
    const gameHolds = this.forcedSegment === undefined && (games?.isActive() === true || ranking?.isRevealing() === true);
    const segmentDue = this.show.length > 1 && !gameHolds && now >= segmentEndsAt;
    // Overdue because chat kept the host talking past the end (not because the room was empty): move on now.
    const heldUp = segmentDue && now - segmentEndsAt >= SEGMENT_OVERDUE_MS && this.lastTurnAt >= segmentEndsAt;
    if (this.forcedSegment !== undefined) return this.changeSegment(now, base);
    if (heldUp && !this.reactOnly()) return this.advance(now, base);

    // The host has answered chat for a while: give the show a turn before anyone else.
    if (this.chatStreak >= CHAT_STREAK_TURNS && triage.pending() > 0 && !this.reactOnly()) {
      if (segmentDue) return this.advance(now, base);
      return this.moveOn(base);
    }

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

    // A question the host moved past, or that expired while it was busy (a game, a segment change), comes back now.
    for (const item of triage.takeLapsed()) this.owe(item);
    const owed = this.takeOwed(now);
    if (owed) {
      return { ...base, kind: "react", items: [owed], note: "It came in a bit earlier and you didn't get to it: say who asked. Skip it if you already answered it." };
    }

    if (this.reactOnly()) return undefined;

    if (segmentDue && speech.isIdle()) return this.advance(now, base);
    // A show with one segment loops it: each time it runs out is the end of a loop.
    if (this.show.length === 1 && !gameHolds && now >= segmentEndsAt && speech.isIdle()) {
      this.learn(now, this.segmentIndex);
      this.restartSegmentClock(now);
      const podium = this.endLoop(now, base);
      if (podium) return podium;
    }

    // Replies to a question can't come in before viewers have heard it.
    const deadAir = deadAirFor(this.viewers, this.options.deadAirMs) + (this.askedRoom ? (this.options.streamDelayMs ?? 0) : 0);
    const quietFor = speech.silenceMs();
    if (quietFor >= deadAir && now - this.lastTurnAt >= deadAir) {
      return { ...base, kind: "filler", items: [], note: this.fillerNote() };
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
    if (!isQuestion(item.event)) return;
    this.owed = [...this.owed, { event: item.event, queuedAt: item.queuedAt }].slice(-OWED_MAX);
  }

  /**
   * The oldest question still owed that the host can see in its room (not one
   * that scrolled by) and hasn't already answered: it sees the questions it
   * moved past and often answers them anyway, and asking again repeats it.
   */
  private takeOwed(now: number): QueueItem | undefined {
    this.owed = this.owed.filter((owed) => now - owed.queuedAt < OWED_TTL_MS);
    const conversation = this.engine.conversation;
    while (this.owed.length) {
      const { event, queuedAt } = this.owed.shift() as (typeof this.owed)[number];
      if (conversation.canShow(event) && !conversation.addressed(event)) return { event, events: [event], priority: 0, expiresAt: Infinity, queuedAt, seq: 0 };
    }
    return undefined;
  }

  private takeMilestone(): { note: string; line: string } | undefined {
    // The note is for the model (English numbers); the line is spoken by the offline host (Brazilian numbers).
    const moments: Array<{ note: string; line: string }> = [];
    if (this.pendingMilestone !== undefined) {
      const crossed = this.pendingMilestone;
      moments.push({ note: `the stream just passed ${crossed.toLocaleString("en-US")} likes`, line: `Passamos de ${crossed.toLocaleString("pt-BR")} curtidas` });
    }
    for (const goal of this.pendingGoals) moments.push(goalMoment(goal));
    this.pendingMilestone = undefined;
    this.pendingGoals = [];
    const now = this.now();
    if (this.pendingLevels.size > 0 && now - this.levelTalkAt >= LEVEL_TALK_GAP_MS) {
      const ups = [...this.pendingLevels.values()].sort((a, b) => b.level - a.level).slice(0, 3);
      moments.push({
        note: `fan level-ups: ${ups.map((up) => `${up.name} reached fan level ${up.level}`).join(", ")} (congratulate them by name)`,
        line: ups.map((up) => `Parabéns, ${up.name}, nível ${up.level} de fã`).join(". "),
      });
      this.pendingLevels.clear();
      this.levelTalkAt = now;
    }
    if (moments.length === 0) return undefined;
    return { note: moments.map((m) => m.note).join("; and "), line: moments.map((m) => m.line).join(". ") };
  }

  /** A viewer reached a new fan level: an alert on stage now; from level 3 the host congratulates them when it can. */
  private levelUp(viewer: Viewer, level: number): void {
    if (level < 2) return;
    const name = this.boardName(viewer);
    this.options.stage.fanLevel?.(name, level);
    this.sound("levelup");
    if (level >= LEVEL_TALK_FROM) this.pendingLevels.set(viewer.id, { name, level });
  }

  /** A wave of arrivals brings the next call to people scrolling past forward. */
  private noteArrival(now: number): void {
    this.arrivals = [...this.arrivals.filter((at) => now - at < ARRIVALS_WINDOW_MS), now];
    if (this.arrivals.length >= ARRIVALS_FOR_HOOK && this.opened) this.hookAt = Math.min(this.hookAt, Math.max(now, this.lastHookAt + HOOK_MIN_GAP_MS));
  }

  /** The quiet moment's call to people scrolling past, when one is due: its note for the host, with the offer big on stage. */
  private takeHook(): string | undefined {
    const now = this.now();
    if (now < this.hookAt || this.options.games?.isActive() || this.challenge.shown()) return undefined;
    const hooks = this.perksOn() && this.giftAsks() === "active" ? [...HOOKS, PERKS_HOOK] : HOOKS;
    const hook = hooks[this.hookIndex++ % hooks.length] as (typeof HOOKS)[number];
    this.hookAt = now + HOOK_EVERY_MS;
    this.lastHookAt = now;
    this.arrivals = [];
    this.options.stage.hook?.(hook.banner);
    this.hookHideAt = now + HOOK_SHOW_MS;
    return `People scrolling through LIVEs are passing by and decide in a second or two. Open with a short, punchy line straight to them ("ei, você que tá passando!"), then give them a reason to stay: they can ${hook.offer}. The stage shows it big: "${hook.banner}". Two short sentences.`;
  }

  private hideHook(): void {
    if (this.hookHideAt === Infinity) return;
    this.hookHideAt = Infinity;
    this.options.stage.hook?.(null);
  }

  /** Something just moved on stage (a gift, a follow): the next flourish can wait. */
  private stirred(now: number): void {
    if (this.flourishAt !== Infinity) this.flourishAt = Math.max(this.flourishAt, now + FLOURISH_EVERY_MS);
  }

  /** A small move on stage when nothing has moved for a while, so the stream never looks frozen to someone scrolling past. */
  private maybeFlourish(now: number): void {
    if (now < this.flourishAt || this.paused) return;
    this.flourishAt = now + FLOURISH_EVERY_MS;
    if (this.options.games?.isActive() || this.options.ranking?.isRevealing()) return;
    this.options.stage.fx?.(FLOURISHES[this.flourishIndex++ % FLOURISHES.length] as Effect, 0.7);
  }

  // ---- gift powers (ADR-0039) ------------------------------------------------------

  private perksOn(): boolean {
    return this.options.giftPerks?.() ?? true;
  }

  /** The always-on support ticker (ADR-0041), sent again only when what it says changes. */
  private publishTicker(): void {
    const on = this.supportOn();
    const perks = this.perksOn();
    const asks = this.giftAsks();
    const key = on ? `${perks}:${asks}` : "off";
    if (key === this.tickerKey) return;
    this.tickerKey = key;
    this.options.stage.ticker?.(on ? supportTicker({ perks, asks }) : null);
  }

  /** A gift that takes first place among the gifters: an alert now, and a word in the host's thank-you. */
  private crown(before: string | undefined): string[] {
    const now = this.now();
    const top = this.boards.gifts.top(1)[0]?.name;
    if (!before || !top || top === before || now - this.crownAt < CROWN_GAP_MS) return [];
    this.crownAt = now;
    this.options.stage.crown?.(top);
    this.sound("fanfare");
    return [`took first place among the gifters from ${before}`];
  }

  /** What a gift unlocked: on stage now, and what the host should know when it thanks the gift. */
  private unlockPerks(event: Extract<LiveEvent, { kind: "gift" }>): string[] {
    if (!this.perksOn()) return [];
    const now = this.now();
    const name = this.boardName(event.viewer);
    const unlock: Unlock | null = this.perks.gift(event.viewer.id, name, event.diamonds, now);
    if (!unlock) return [];
    const { perk } = unlock;
    this.options.stage.perk?.(name, perk.label);
    this.options.stage.fx?.("stars", 1.5);
    this.sound("levelup");
    this.options.triage.promote(event.viewer.id, perk.id === "boss" ? "boss" : "vip", now + (perk.id === "boss" ? BOSS_MS : VIP_MS));
    // The pick opens with the thank-you, which tells them how to choose (one turn, not two).
    const pick = includes(perk.id, "pick") ? this.queuePick(event.viewer.id, name, "gift", now, false) : undefined;
    if (perk.id === "anthem") this.anthems = [...this.anthems, name].slice(-2);
    if (perk.id === "boss") {
      // The old dono da live keeps cutting the line for a while, but the crown is gone.
      if (unlock.dethroned) this.options.triage.demote(unlock.dethroned.id);
      this.showBoss(now);
      this.options.stage.fx?.("fireworks", 2.5);
      this.remember({ at: now, kind: "show", text: `${name} is the dono da live for the next ${BOSS_MS / 60_000} minutes${unlock.dethroned ? `, taking the crown from ${unlock.dethroned.name}` : ""}.` });
    }
    const choose = pick ? `; the card on screen shows their pick of the next game (${pick}): tell ${name} to type the number now, they have ${PICK_MS / 1000} seconds` : "";
    return [`unlocked ${perk.label}: ${name} ${perk.note}${unlock.dethroned ? `, and took the crown from ${unlock.dethroned.name}` : ""}; make it a moment${choose}`];
  }

  private showBoss(now: number): void {
    const boss = this.perks.boss(now);
    this.bossShown = boss?.id ?? null;
    this.options.stage.boss?.(boss ? { name: boss.name, leftMs: boss.until - now } : null);
  }

  /** The reign ends on its own: the crown comes off the stage. */
  private maybeEndBoss(now: number): void {
    if (!this.bossShown || this.perks.boss(now)) return;
    this.bossShown = null;
    this.options.stage.boss?.(null);
    this.remember({ at: now, kind: "show", text: "The dono da live's reign just ended: the crown is up for grabs again." });
  }

  private bossContext(now: number): string | undefined {
    const boss = this.perks.boss(now);
    if (!boss) return undefined;
    return `Dono da live: ${boss.name}, for ${Math.max(1, Math.ceil((boss.until - now) / 60_000))} more min (a gift power): treat them like royalty, give them a royal title, and do what they ask when it's safe and playful.`;
  }

  /**
   * A viewer gets to pick the next game: theirs opens now, or after the one
   * before it. Returns the options when it opened right away; with `cue`
   * off, the caller's own line announces them.
   */
  private queuePick(id: string, name: string, reason: "gift" | "raffle", now: number, cue = true): string | undefined {
    if (!this.options.games || this.pick?.ballot.viewerId === id || this.pendingPicks.some((p) => p.id === id)) return undefined;
    this.pendingPicks = [...this.pendingPicks, { id, name, reason }].slice(-3);
    return this.maybeOpenPick(now, cue);
  }

  private maybeOpenPick(now: number, cue = true): string | undefined {
    if (this.pick || this.pickedGame) return undefined;
    const next = this.pendingPicks.shift();
    if (!next) return undefined;
    const ballot = new SoloPick(next.id, next.name, pickOptions(this.random, this.options.games?.status()?.kind), next.reason);
    this.pick = { ballot, closesAt: now + PICK_MS };
    const options = ballot.labels.map((label, i) => `${i + 1}) ${label}`).join(", ");
    this.sound("start");
    if (!cue) return options;
    const why = next.reason === "gift" ? "unlocked it with a gift" : "won the raffle";
    this.eventCues.push({
      note: `${next.name} ${why} and chooses the next minigame alone: ${options}. Read the options and tell ${next.name}, by name, to type the number in chat now (${PICK_MS / 1000} seconds). Make them feel powerful.`,
      line: `${next.name}, você escolhe o próximo jogo! ${ballot.labels.map((label, i) => `${i + 1} para ${label}`).join(", ")}. Digita o número!`,
      history: `${next.name} gets to pick the next game: ${options}.`,
    });
    return options;
  }

  /** The pick is in (or its time ran out and the show drew for them): that game is next. */
  private maybeClosePick(now: number): void {
    const pick = this.pick;
    if (!pick || (!pick.ballot.choice && now < pick.closesAt)) return;
    const chosen = pick.ballot.choice;
    const kind = chosen ?? (pick.ballot.options[Math.floor(this.random() * pick.ballot.options.length)] as GameKind);
    this.pick = null;
    const label = GAME_LABELS[kind];
    const when = this.options.games?.isActive() ? "right after this game" : "right now";
    const cue = {
      note: chosen
        ? `${pick.ballot.name} chose ${label}! Celebrate their choice by name in one line and say it starts ${when}.`
        : `${pick.ballot.name} didn't choose in time, so the show drew ${label} for them. Say so in one playful line, and that it starts ${when}.`,
      line: `${pick.ballot.name} escolheu ${label}!`,
      history: `${pick.ballot.name}'s pick: ${label} (${chosen ? "chosen" : "drawn for them"}), starting ${when}.`,
    };
    this.eventCues.push(cue);
    this.pickedGame = { config: { kind, rounds: PICK_ROUNDS }, by: pick.ballot.name, cue };
    this.options.stage.fx?.("confetti", 1.2);
    this.sound("reveal");
  }

  private pickContext(now: number): string | undefined {
    const pick = this.pick;
    if (!pick) return undefined;
    return `${pick.ballot.name} is choosing the next game (only their message counts, ${Math.max(0, Math.ceil((pick.closesAt - now) / 1000))} s left): ${pick.ballot.labels.map((label, i) => `${i + 1}) ${label}`).join(", ")}.`;
  }

  private anthemNote(name: string): string {
    const music = this.persona.sound?.music !== false && this.options.actions?.playMusic !== undefined;
    return music
      ? `${name} unlocked a personal anthem with a gift. Say one short line introducing "o hino de ${name}", then compose it with play_music: a short, upbeat original piece with their name in the title. Sing two short original lines about ${name} as your speech, their name in them.`
      : `${name} unlocked a personal anthem with a gift. Rap or sing two short original lines about ${name}, with their name in them, with all the drama of a stadium anthem.`;
  }

  /** The showcase of what each gift unlocks, now and then, under the character (never over a game, a challenge or a call to passers-by). */
  private maybeShowPerks(now: number): void {
    if (now >= this.perksHideAt) this.hidePerks();
    if (now < this.perksCardAt || this.standby || !this.perksOn()) return;
    if (this.options.games?.isActive() || this.challenge.shown() || this.hookHideAt !== Infinity) {
      this.perksCardAt = now + PERKS_RETRY_MS;
      return;
    }
    this.options.stage.perks?.(perksCard());
    this.perksHideAt = now + PERKS_CARD_SHOW_MS;
    this.perksCardAt = now + PERKS_PACE[this.giftAsks()].every;
  }

  private hidePerks(): void {
    if (this.perksHideAt === Infinity) return;
    this.perksHideAt = Infinity;
    this.options.stage.perks?.(null);
  }

  /** Everything gift powers and challenges put on the show belongs to one stream. */
  private clearShowExtras(): void {
    this.perks.clear();
    if (this.bossShown) this.options.stage.boss?.(null);
    this.bossShown = null;
    this.pick = null;
    this.pendingPicks = [];
    this.pickedGame = null;
    this.anthems = [];
    this.eventCues = [];
    this.hidePerks();
    if (this.challenge.shown()) {
      this.challenge.stop();
      this.options.stage.challenge?.(null);
    }
    this.challengeKey = "";
    this.newcomers = [];
  }

  // ---- room challenges (ADR-0040) --------------------------------------------------

  private noteLikes(now: number, count: number): void {
    const last = this.likeLog.at(-1);
    // One entry a second is plenty for a rate.
    if (last && now - last.at < 1_000) last.count += count;
    else this.likeLog.push({ at: now, count });
    while (this.likeLog.length && now - (this.likeLog[0] as { at: number }).at > LIKE_RATE_MS) this.likeLog.shift();
  }

  /** Likes a minute lately (over the stream so far when it's younger than the window). */
  private likesPerMinute(now: number): number {
    const total = this.likeLog.filter((entry) => now - entry.at <= LIKE_RATE_MS).reduce((sum, entry) => sum + entry.count, 0);
    const minutes = Math.max(1, Math.min(LIKE_RATE_MS, now - this.startedAt) / 60_000);
    return total / minutes;
  }

  /** Starts the next challenge when one is due and the room is free for it; ends the one running when its time is up. */
  private maybeChallenge(now: number): void {
    const ended = this.challenge.tick(now);
    if (ended) this.challengeEnded(ended, now);
    if (now < this.challengeAt || this.challenge.shown() || !this.opened || this.paused || this.standby || this.persona.challenges === false) return;
    const busy = this.options.games?.isActive() || this.options.ranking?.isRevealing() || this.pick || this.vote || this.reactOnly();
    if (busy || this.viewers < CHALLENGE_MIN_VIEWERS) {
      this.challengeAt = now + CHALLENGE_RETRY_MS;
      return;
    }
    const kind = CHALLENGES[this.challengeIndex++ % CHALLENGES.length] as (typeof CHALLENGES)[number];
    const durationMs = CHALLENGE_MS[kind];
    const seconds = durationMs / 1000;
    const word = kind === "raffle" ? RAFFLE_WORD : (RUSH_WORDS[Math.floor(this.random() * RUSH_WORDS.length)] as string);
    const target =
      kind === "likes"
        ? niceTarget(Math.min(100_000, Math.max(50, this.viewers * 12, this.likesPerMinute(now) * (seconds / 60) * 1.6)))
        : kind === "chat"
          ? niceTarget(Math.min(300, Math.max(10, this.viewers * 1.2)))
          : 0;
    this.challenge.start({ kind, target, durationMs, word }, now);
    this.challengeAt = now + CHALLENGE_EVERY_MS;
    this.hideHook();
    this.sound("start");
    const notes = {
      likes: {
        note: `Like challenge, on screen now: ${target.toLocaleString("en-US")} likes in ${seconds} seconds! Rally everyone to tap the screen nonstop, with huge energy, and say there's a prize if they make it.`,
        line: `Desafio das curtidas! ${target.toLocaleString("pt-BR")} curtidas em ${seconds} segundos. Toca na tela sem parar!`,
      },
      chat: {
        note: `Comment rush, on screen now: ${target} messages with "${word}" in ${seconds} seconds! Tell chat to type ${word} as many times as they can, and say there's a prize if they make it.`,
        line: `Chuva de comentários! Digitem ${word} sem parar: ${target} mensagens em ${seconds} segundos!`,
      },
      raffle: {
        note: `Free raffle, on screen now: whoever types ${word} in the next ${seconds} seconds is in, and you'll draw one winner who gets to pick the next game. Entering is free. Say it with energy so people scrolling past join in.`,
        line: `Sorteio relâmpago! Digita ${word} no chat pra participar. Quem ganhar escolhe o próximo jogo!`,
      },
    }[kind];
    this.eventCues.push({ ...notes, history: `A ${kind === "likes" ? "like challenge" : kind === "chat" ? "comment rush" : "raffle"} started on stage.` });
  }

  private challengeEnded(ended: NonNullable<ReturnType<RoomChallenge["tick"]>>, now: number): void {
    const stage = this.options.stage;
    if (ended.kind === "raffle") {
      if (!ended.winner) {
        this.sound("fail");
        this.eventCues.push({
          note: "Nobody entered the raffle. Joke about it in one line and say there'll be another one soon, so stick around.",
          line: "Ninguém entrou no sorteio? Vou fazer outro daqui a pouco, hein!",
          history: "Nobody entered the raffle.",
        });
        return;
      }
      const name = ended.winner.name;
      stage.raffleWinner?.(name);
      stage.fx?.("confetti", 2);
      this.sound("fanfare");
      const options = this.queuePick(ended.winner.id, name, "raffle", now, false);
      this.eventCues.push({
        note: `${name} won the raffle (out of ${ended.players})! Congratulate them by name, give them a funny title, and say their prize: they pick the next minigame${options ? `. The card shows their options (${options}): tell ${name} to type the number now, they have ${PICK_MS / 1000} seconds` : ", right after the pick before theirs"}.`,
        line: `${name} ganhou o sorteio! E o prêmio: você escolhe o próximo jogo!`,
        history: `${name} won the raffle, out of ${ended.players}${options ? `, and is picking the next game: ${options}` : ""}.`,
      });
      return;
    }
    const what = ended.kind === "likes" ? `${ended.value.toLocaleString("en-US")} likes` : `${ended.value} messages`;
    if (ended.result === "won") {
      stage.fx?.("fireworks", 3);
      stage.fx?.("confetti", 2);
      this.sound("fanfare");
      const prizes = CHALLENGE_PRIZES.filter((p) => !p.needsMusic || (this.persona.sound?.music !== false && this.options.actions?.playMusic !== undefined));
      const prize = (prizes[this.prizeIndex++ % prizes.length] as (typeof CHALLENGE_PRIZES)[number]).prize;
      this.eventCues.push({
        note: `The room beat the ${ended.kind === "likes" ? "like challenge" : "comment rush"}: ${what}! Celebrate big and thank everyone, then, as the prize, ${prize}.`,
        line: "Conseguimos! Vocês são demais!",
        history: `The room beat the ${ended.kind === "likes" ? "like challenge" : "comment rush"} with ${what}.`,
      });
    } else {
      this.sound("fail");
      this.eventCues.push({
        note: `The ${ended.kind === "likes" ? "like challenge" : "comment rush"} ended at ${what} of ${ended.target.toLocaleString("en-US")}. So close: tease the room playfully in one line and promise a rematch soon.`,
        line: "Quase! Na próxima a gente consegue.",
        history: `The ${ended.kind === "likes" ? "like challenge" : "comment rush"} fell short: ${what} of ${ended.target}.`,
      });
    }
  }

  // ---- people arriving ---------------------------------------------------------------

  private noteNewcomer(viewer: Viewer, now: number): void {
    const name = this.boardName(viewer);
    if (!name || name === "visitante" || this.newcomers.some((n) => n.id === viewer.id)) return;
    this.newcomers = [...this.newcomers.filter((n) => now - n.at < NEWCOMER_TTL_MS), { id: viewer.id, name, at: now }].slice(-NEWCOMERS_MAX * 2);
  }

  /** Up to three people who just arrived for the first time, to welcome by name (at most every so often). */
  private takeNewcomers(now: number): string[] {
    if (now - this.welcomedAt < WELCOME_GAP_MS) return [];
    const fresh = this.newcomers.filter((n) => now - n.at < NEWCOMER_TTL_MS).slice(-NEWCOMERS_MAX);
    this.newcomers = [];
    if (fresh.length) this.welcomedAt = now;
    return fresh.map((n) => n.name);
  }

  private goalsOn(): boolean {
    return this.persona.goals?.show !== false;
  }

  /** A goal was just reached: a big moment on stage now, and the host celebrates it at the next free turn. */
  private reachGoal(reached: GoalReached | null): void {
    if (!reached) return;
    this.pendingGoals = [...this.pendingGoals.filter((goal) => goal.kind !== reached.kind), reached];
    this.options.stage.fx?.(reached.kind === "likes" ? "hearts" : "fireworks", 3);
    this.options.stage.fx?.("confetti", 2);
    this.sound("fanfare");
  }

  private publishGoals(): void {
    this.options.stage.goals?.(this.goalsView());
  }

  /** The stream's goals as the stage shows them; none when they're turned off. */
  goalsView(): GoalView[] {
    return this.goalsOn() ? this.goals.view() : [];
  }

  /** Moves to the next segment in the rotation; the last one ends the loop, and its podium goes first. */
  private advance(now: number, base: Omit<TurnPlan, "kind" | "items">): TurnPlan {
    if (this.segmentIndex === this.show.length - 1) {
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
    const nextIndex = this.forcedSegment ?? (this.segmentIndex + 1) % this.show.length;
    this.forcedSegment = undefined;
    const previous = this.segment();
    this.learn(now, this.segmentIndex);
    if (this.vote) this.closeVote(nextIndex === this.show.length - 1, now);
    if (nextIndex === 0) {
      this.loops += 1;
      this.finalGame = null;
      // A new loop of the automatic run of show is planned afresh, leaning toward what worked.
      if (this.persona.autoShow) this.show = autoShow(this.loops, this.showSeed, this.focus);
    }
    const nextSegment = this.show[nextIndex] as Segment;
    this.segmentIndex = nextIndex;
    this.segmentDraws.clear();
    this.restartSegmentClock(now);
    this.options.stage.segment(nextSegment);
    this.options.hooks?.onSegment?.(nextSegment);
    this.remember({ at: now, kind: "show", text: `New segment: ${nextSegment.title}` });
    const insight = this.insight(nextIndex);
    return { ...base, segment: previous, kind: "segment_change", items: [], nextSegment, ...(insight ? { insight } : {}) };
  }

  /**
   * A turn for the show on a busy stretch: thank whoever sent gifts, nod to the
   * room as a whole and get on with the segment (or the game). Plain chat that
   * piled up meanwhile is let go: it's in the room the host sees, but nobody
   * waits on an answer. Questions stay queued for the next reaction.
   */
  private moveOn(base: Omit<TurnPlan, "kind" | "items">): TurnPlan {
    const triage = this.options.triage;
    const support = triage.takeKinds(SUPPORT_KINDS, REACT_SUPPORT).sort((a, b) => a.event.at - b.event.at || a.seq - b.seq);
    triage.discard((item) => item.event.kind === "chat" && !isQuestion(item.event));
    const segment = this.segment();
    const game = this.options.games?.fillerNote();
    const next = game ?? (this.takeSupportTalk() ? this.supportTalk() : `get on with "${segment.title}": ${segment.prompt}`);
    return {
      ...base,
      kind: "show",
      items: support,
      note: `Chat is busy and you've been answering people one after another. Don't answer anyone by name this time: one quick line to the whole room, then ${next}`,
    };
  }

  /** What a quiet moment is about: the game, or the next idea in rotation. */
  private fillerNote(): string {
    const games = this.options.games?.fillerNote();
    if (games) return games;
    if (this.options.ranking?.isRevealing()) return "The loop's podium is on screen. Celebrate the top players by name in a line or two and invite everyone to play in the next loop.";
    const segment = this.segment();
    // The support explanation is rarer, so it goes first when both are due; the call to passers-by takes the next quiet moment.
    if (this.takeSupportTalk()) return `Keep the show alive for "${segment.title}". This time, ${this.supportTalk()}`;
    // Naming who just arrived beats a call to everyone passing by; the call takes the next quiet moment.
    const now = this.now();
    const newcomers = this.takeNewcomers(now);
    if (newcomers.length) {
      return `Keep the show alive for "${segment.title}". This time, welcome ${newcomers.join(", ")} by name: ${newcomers.length === 1 ? "they're" : "they're all"} here for the first time. One warm, fun line, then tell them one thing they can do right now (play the game on screen, ask you anything, type their name for a nickname).`;
    }
    const hook = this.takeHook();
    if (hook) return hook;
    const chat = this.engine.conversation.hasViewerChat();
    const upNext = this.upNext(now).length > 0;
    const usable = (beat: (typeof FILLER_BEATS)[number]) =>
      (!beat.needsChat || chat) && (!beat.needsGoals || this.goalsOn()) && (!beat.needsUpNext || upNext) && (!beat.needsSupport || this.supportOn());
    let pick = FILLER_BEATS[this.fillerBeat++ % FILLER_BEATS.length] as (typeof FILLER_BEATS)[number];
    if (!usable(pick)) pick = FILLER_BEATS[this.fillerBeat++ % FILLER_BEATS.length] as (typeof FILLER_BEATS)[number];
    return `Keep the show alive for "${segment.title}" (${segment.prompt}). This time, ${pick.beat}`;
  }

  /** How the host explains supporting the show and what gifts get; with gift powers on, it names a couple of them too. */
  private supportTalk(): string {
    const benefits = this.goalsOn() ? [...GIFT_BENEFITS, "every gift moves the gift goal on screen"] : GIFT_BENEFITS;
    const talk = `${SUPPORT_TALK[this.giftAsks()]} The benefits of gifting here (name two or three, in your own words): ${benefits.join("; ")}.`;
    if (!this.perksOn()) return talk;
    return `${talk} Then say the show has gift powers, the show's own rules (${perksSummary()}), and name one or two${this.giftAsks() === "active" ? " with energy" : ", to the whole room, without asking anyone by name"}.`;
  }

  private supportOn(): boolean {
    return this.persona.support !== false;
  }

  private giftAsks(): GiftAsks {
    return this.options.giftAsks?.() ?? "light";
  }

  private scheduleSupport(now: number): void {
    if (!this.supportOn()) return;
    const pace = SUPPORT_PACE[this.giftAsks()];
    this.supportCardAt = now + pace.cardFirst;
    this.supportTalkAt = now + pace.talkFirst;
  }

  /** Puts the support card up when it's due (not over an open vote: they share a place), and takes it down after a moment. */
  private maybeShowSupport(now: number): void {
    if (now >= this.supportHideAt) this.hideSupport();
    if (now < this.supportCardAt || this.vote || this.standby) return;
    this.showSupport(now);
  }

  private showSupport(now: number): void {
    this.options.stage.support?.({
      title: `${this.persona.name} é uma IA ao vivo`.slice(0, 60),
      lines: [
        { way: "like", text: "Curta a live" },
        { way: "follow", text: "Siga para não perder" },
        { way: "share", text: "Compartilhe com amigos" },
        { way: "gift", text: "Presentes pagam as contas da IA" },
      ],
    });
    this.supportHideAt = now + SUPPORT_CARD_SHOW_MS;
    this.supportCardAt = now + SUPPORT_PACE[this.giftAsks()].cardEvery;
  }

  private hideSupport(): void {
    if (this.supportHideAt === Infinity) return;
    this.supportHideAt = Infinity;
    this.options.stage.support?.(null);
  }

  /** True when it's time for the host to explain how to support the show; the card goes up with it. */
  private takeSupportTalk(): boolean {
    const now = this.now();
    if (now < this.supportTalkAt) return false;
    this.supportTalkAt = now + SUPPORT_PACE[this.giftAsks()].talkEvery;
    if (!this.vote) this.showSupport(now);
    return true;
  }

  /** When the segment on air ends: its minutes, plus or minus what live focus changed (ADR-0043). */
  private segmentEndsAt(): number {
    return this.segmentStartedAt + this.segment().minutes * 60_000 + this.segmentExtraMs;
  }

  private restartSegmentClock(now: number): void {
    this.segmentStartedAt = now;
    this.segmentExtraMs = 0;
    this.segmentJudged = false;
  }

  /** The key a segment's record is kept under: for a game segment, the game it actually played. */
  private keyOf(index: number): string | undefined {
    const segment = this.show[index];
    return segment ? segmentKey(segment, this.segmentGame(index)?.kind) : undefined;
  }

  /** The segment at `index` just ended: folds what it did into the channel's record (ADR-0043). */
  private learn(now: number, index: number): void {
    const ended = this.meter.endSegment(now);
    const scores = this.options.segmentScores;
    const segment = this.show[index];
    const key = this.keyOf(index);
    if (!ended || !scores || !segment || !key) return;
    const record = scores.record(key, segment.title, ended.take.ms / 60_000, ended.score);
    this.options.log?.debug(`segment "${segment.title}" scored ${ended.score.score.toFixed(2)} (average ${record.score.toFixed(2)} over ${record.plays} plays)`);
  }

  /** What the segment at `index` is known for on this channel, for the host's brief. */
  private insight(index: number): string | undefined {
    const key = this.keyOf(index);
    return key ? this.options.segmentScores?.describe(key) : undefined;
  }

  /**
   * Live focus (ADR-0043): once a segment has run most of its time, one that
   * pulls clearly more than the rest of the stream gets more time, and an
   * automatic one that's losing the room wraps up early. A creator's own
   * segments are only ever extended: their run of show is theirs.
   */
  private maybeRefocus(now: number): void {
    if (this.segmentJudged || !this.opened || this.show.length < 2 || this.forcedSegment !== undefined) return;
    const segment = this.segment();
    const elapsed = now - this.segmentStartedAt;
    if (elapsed < Math.max(JUDGE_MIN_MS, segment.minutes * 60_000 * JUDGE_AFTER)) return;
    const live = this.meter.current(now, JUDGE_MIN_MS);
    const endsAt = this.segmentEndsAt();
    const closing = now >= endsAt - EXTEND_LEAD_MS;
    if (live && live.score >= HOT_SEGMENT && closing) {
      const extra = Math.min(EXTEND_MAX_MS, segment.minutes * 30_000);
      this.segmentExtraMs += extra;
      this.segmentJudged = true;
      if (this.vote) this.vote.closesAt += extra;
      this.remember({ at: now, kind: "show", text: `"${segment.title}" is pulling more than the rest of the show right now, so it runs about ${Math.round(extra / 60_000)} more minutes. Keep doing what's working.` });
      this.options.log?.info(`segment "${segment.title}" is doing well (${live.score.toFixed(2)}): extended by ${Math.round(extra / 1000)} s`);
      return;
    }
    // The segment chat votes in keeps time for the vote; an open vote runs to its end.
    const votesHere = this.segmentIndex === this.show.length - 2 && this.persona.finalVote !== false;
    const cutTo = now + (votesHere ? VOTE_LEAD_MS : 0);
    if (live && live.score <= COLD_SEGMENT && isAutoSegment(segment) && !this.vote && cutTo < endsAt) {
      this.segmentExtraMs -= endsAt - cutTo;
      this.segmentJudged = true;
      this.options.log?.info(`segment "${segment.title}" is losing the room (${live.score.toFixed(2)}): wrapping it up early`);
      return;
    }
    if (closing) this.segmentJudged = true;
  }

  /** The game a segment plays: its own, or for the last segment, the one chat voted for. */
  private segmentGame(index: number): GameConfig | undefined {
    const segments = this.show;
    if (index === segments.length - 1 && this.finalGame) return this.finalGame;
    const game = segments[index]?.game;
    if (!game) return undefined;
    return { ...game, kind: game.kind === "random" ? this.drawGame(index) : game.kind };
  }

  /** Draws the kind for a "random" segment once, and keeps it until the show moves on. */
  private drawGame(index: number): GameKind {
    let kind = this.segmentDraws.get(index);
    if (!kind) {
      kind = GAME_KINDS[Math.floor(Math.random() * GAME_KINDS.length)] ?? "trivia";
      this.segmentDraws.set(index, kind);
    }
    return kind;
  }

  /** Opens the vote on the last segment's game near the end of the second-to-last segment (ADR-0029). */
  private maybeOpenVote(now: number): void {
    const segments = this.show;
    if (this.vote || !this.opened || this.persona.finalVote === false || segments.length < 2) return;
    if (this.segmentIndex !== segments.length - 2 || this.finalGame) return;
    const endsAt = this.segmentEndsAt();
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
    const last = this.show[this.show.length - 1] as Segment;
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
      // One viewer's pick of the next game goes over chat's vote while it's open (ADR-0039).
      const pick = this.pick;
      const vote = this.vote;
      const tally = vote?.ballot.tally() ?? [];
      const key = pick ? `pick:${pick.ballot.viewerId}:${pick.ballot.labels.join("|")}` : vote ? `${vote.ballot.labels.join("|")}:${tally.join(",")}` : "";
      if (force || (key !== this.voteKey && (key === "" || this.voteKey === "" || pick !== null || now - this.voteSentAt >= LEADERS_EVERY_MS))) {
        this.voteKey = key;
        this.voteSentAt = now;
        stage.vote(
          pick
            ? { title: PICK_TITLE, options: pick.ballot.labels, tally: [], by: pick.ballot.name }
            : vote
              ? { title: VOTE_TITLE, options: vote.ballot.labels, tally }
              : null,
        );
      }
    }
    if (stage.challenge) {
      const view = this.challenge.view(now);
      // The countdown runs on stage; only a new count or the result needs a message.
      const key = view ? `${view.kind}:${view.value}:${view.result}:${view.winner}` : "";
      if (force || (key !== this.challengeKey && (key === "" || this.challengeKey === "" || view?.result !== null || now - this.challengeSentAt >= CHALLENGE_SEND_MS))) {
        this.challengeKey = key;
        this.challengeSentAt = now;
        stage.challenge(view);
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
    return clip(displayName(viewer, this.blocklist()), 24);
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

  /** Starts the current segment's game when the segment has one and the room is ready for it; a viewer's pick goes first. */
  private maybeStartSegmentGame(now: number): void {
    const games = this.options.games;
    const picked = this.pickedGame;
    const announced = picked !== null && !this.eventCues.includes(picked.cue);
    if (games && picked && announced && this.opened && !games.isActive() && !this.options.ranking?.isRevealing() && now - games.lastEndedAt() >= PICK_BREAK_MS) {
      const started = games.start(picked.config, "pick", this.chatSample());
      if (started.ok) {
        this.options.log?.info(`starting the game a viewer picked (${picked.config.kind})`);
        this.pickedGame = null;
        this.maybeOpenPick(now);
      }
      return;
    }
    const config = this.segmentGame(this.segmentIndex);
    // Not gated on a quiet room: on a busy stream it never is, and the game's cue gets its own turn.
    if (!games || !config || !this.opened || games.isActive() || this.options.ranking?.isRevealing() || this.reactOnly()) return;
    if (now - this.segmentStartedAt < SEGMENT_GAME_DELAY_MS || now - games.lastEndedAt() < GAME_BREAK_MS) return;
    const left = this.segmentEndsAt() - now;
    if (left < MIN_GAME_WINDOW_MS) return;
    const started = games.start(config, "segment", this.chatSample());
    if (started.ok) this.options.log?.info(`starting the segment's game (${config.kind})`);
  }

  private async runTurn(plan: TurnPlan): Promise<void> {
    this.lastTurnAt = this.now();
    this.skipGap = false;
    const answersChat = plan.kind === "react" && plan.items.some((item) => item.event.kind === "chat" || item.event.kind === "question");
    this.chatStreak = answersChat ? this.chatStreak + 1 : plan.kind === "react" ? this.chatStreak : 0;
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
function segmentTitle(segment: Segment, config: GameConfig | undefined): string {
  if (!config) return segment.title;
  const game = gameTitle(config);
  const named = segment.title.toLowerCase().includes(GAME_LABELS[config.kind].toLowerCase());
  return named ? segment.title : clip(`${segment.title} · ${game}`, 60);
}

/** "Quiz" or "Quiz: futebol". */
function gameTitle(config: GameConfig): string {
  const label = GAME_LABELS[config.kind];
  return clip(config.topic ? `${label}: ${config.topic}` : label, 60);
}

/** The targets the creator set for the goals, if any. */
function goalSteps(persona: Persona): { likes?: number; gifts?: number } {
  const goals = persona.goals;
  return { ...(goals?.likes ? { likes: goals.likes } : {}), ...(goals?.gifts ? { gifts: goals.gifts } : {}) };
}

/** What the host celebrates for a goal reached: a note for the model (English numbers), a line for the offline host. */
function goalMoment(goal: GoalReached): { note: string; line: string } {
  const en = (n: number) => n.toLocaleString("en-US");
  const pt = (n: number) => n.toLocaleString("pt-BR");
  return goal.kind === "likes"
    ? { note: `the stream just reached its like goal of ${en(goal.target)} likes (thank chat; the next goal is ${en(goal.next)})`, line: `Batemos a meta de ${pt(goal.target)} curtidas! Próxima meta: ${pt(goal.next)}` }
    : {
        note: `the stream just reached its gift goal of ${en(goal.target)} diamonds (thank the gifters; the next goal is ${en(goal.next)} diamonds)`,
        line: `Batemos a meta de ${pt(goal.target)} diamantes! Próxima meta: ${pt(goal.next)}`,
      };
}
