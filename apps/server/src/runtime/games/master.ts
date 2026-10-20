import {
  clip,
  BOOST_DIAMONDS,
  BOOST_KINDS,
  BOOST_LABELS,
  GAME_LABELS,
  GENERATED_KINDS,
  OPTION_LETTERS,
  viewerName,
  type BoostKind,
  type Effect,
  type GameConfig,
  type GameKind,
  type GeneratedKind,
  type GameScene,
  type GameSource,
  type GameStatus,
  type LiveEvent,
  type Sound,
  type Viewer,
} from "@tik-live/shared";
import type { Logger } from "../../log";
import { displayName } from "../brain/prompt";
import type { SafetyVerdict } from "../safety/gate";
import { matchesAnswer, normalize, readNumber, readOption, readTrueFalse, readWord } from "./answers";
import {
  FUSE_MAX_MS,
  GRAB_COOLDOWN_MS,
  makePotato,
  makeRace,
  makeTug,
  makeWheel,
  POTATO_MAX_POINTS,
  PULL,
  PULL_LIKES_MAX,
  RACE_MS,
  RACE_POINTS,
  raceLeader,
  raceProgress,
  readGrab,
  readPick,
  readPull,
  ropePosition,
  SPIN_MS,
  TUG_POINTS,
  WHEEL_POINTS,
  wheelResult,
} from "./chance";
import {
  avoidLine,
  guessLanguage,
  makeMath,
  makeNumber,
  pickFromBank,
  pickThemes,
  sameIdea,
  scrambleLetters,
  type RoundContent,
  type WrittenKind,
} from "./content";
import type { LoopRanking } from "./ranking";
import type { GameWriter } from "./writer";

/** What the host should say about a game moment. */
export interface GameCue {
  /** Instructions for the model: what happened and what to say. */
  note: string;
  /** A plain line for the offline scripted host. */
  line: string;
  /** One line for the host's conversation memory. */
  history: string;
}

export interface GameStage {
  game(scene: GameScene | null): void;
  fx(fx: Effect, intensity?: number): void;
  sfx(sound: Sound): void;
  /** A gift powered up the round (the stage's own moment for it). */
  boost?(boost: BoostKind, by: string): void;
}

export interface GameMasterOptions {
  /** Writes questions; null uses the offline bank only. */
  writer: GameWriter | null;
  /** Written rounds are shown on stage, so they pass the same gate as speech. */
  gate: { check(text: string, context?: string): Promise<SafetyVerdict> };
  stage: GameStage;
  blocklist: () => readonly string[];
  /** The voice's only language, if it has one. */
  language: () => string | undefined;
  /** Whether the stage may play sounds for game moments. */
  sounds: () => boolean;
  /** Adds every point to the loop's ranking (ADR-0028). */
  ranking?: LoopRanking;
  /** The game's status changed (for the studio). */
  onChange?: () => void;
  /**
   * How far behind real time viewers watch the stream. A round keeps taking
   * answers this long after its timer runs out, since viewers still see time
   * on the clock and their answers arrive late.
   */
  streamDelayMs?: number;
  now?: () => number;
  random?: () => number;
  log?: Logger;
}

type Phase = GameStatus["phase"];

/** A cue waiting for the host, with what it's about so stale ones can be dropped. */
interface PendingCue extends GameCue {
  round: number;
  phase: Phase;
  at: number;
  /** An open round's cue: when its timer runs out, to tell the host how long is left when it reads the round. */
  closesAt?: number;
  /** A thank-you for a power-up, not the round's question. */
  boost?: true;
}

/** A tug of war player: their team and how much they pulled. */
interface Puller {
  team: 0 | 1;
  name: string;
  pulls: number;
}

interface Answer {
  value: number | boolean;
  at: number;
  name: string;
}

interface Round {
  content: RoundContent;
  openedAt: number;
  durationMs: number;
  /** First answer per viewer (option games). */
  answers: Map<string, Answer>;
  guesses: number;
  /** Who won a first-to-answer round, and how long it took them. */
  winner: { id: string; name: string; ms: number } | null;
  /** Number game: the window the secret is known to be in, and the last guess. */
  low: number;
  high: number;
  last: { name: string; value: number; hint: "higher" | "lower" | "exact" } | null;
  lastGuessAt: Map<string, number>;
  /** Scramble: the letters as shown. */
  letters: string;
  /** Diamonds gifted while this round was open, and the power-ups they unlocked (ADR-0029). */
  gifted: number;
  boosts: BoostKind[];
  /** Trivia: wrong options a 50/50 took away. */
  removed: number[];
  /** A hint power-up showed the hint early. */
  hintEarly: boolean;
  /** Race and wheel: when the race started (or the strip began to spin), and the race's latest moment (ADR-0038). */
  ranAt: number;
  leader: number;
  event: string | null;
  eventAt: number;
  finalStretch: boolean;
  /** Tug of war: who's on which team, and each team's pulls. */
  pullers: Map<string, Puller>;
  pulls: [number, number];
  /** Hot potato: who has it and since when, and how long each player has held it so far. */
  holder: { id: string; name: string; since: number } | null;
  held: Map<string, { name: string; ms: number }>;
  grabs: number;
  exploded: { name: string; lost: number } | null;
  /** When the board last went out (the potato's heat climbs between grabs). */
  heatAt: number;
}

interface ActiveGame {
  config: GameConfig;
  source: GameSource;
  phase: Phase;
  /** Rounds ready to play (written ones fill in once preparation finishes). */
  queue: RoundContent[];
  index: number;
  round: Round | null;
  phaseAt: number;
  /** When the first round could open; it waits for the host to stop talking. */
  readyAt: number | null;
  scores: Map<string, { name: string; points: number }>;
  prep: AbortController | null;
}

/** How long viewers have to answer, per game. */
const OPEN_MS: Record<GameKind, number> = {
  trivia: 25_000,
  poll: 20_000,
  scramble: 45_000,
  number: 60_000,
  truefalse: 18_000,
  math: 30_000,
  riddle: 45_000,
  fastest: 20_000,
  // Betting time; the race or the spin comes after.
  race: 25_000,
  wheel: 20_000,
  tug: 40_000,
  // The potato's fuse is drawn every round (this is the longest).
  potato: FUSE_MAX_MS,
};

/** First right answer ends the round. */
const FIRST_WINS: ReadonlySet<GameKind> = new Set(["scramble", "number", "math", "riddle", "fastest"]);

const HOW_TO_ANSWER: Record<GameKind, string> = {
  trivia: "type the letter of their answer (A, B, C or D)",
  poll: "vote by typing the letter of their pick",
  scramble: "type the unscrambled word",
  number: "type a number; the screen narrows the range after every guess",
  truefalse: "type V for true (verdadeiro) or F for false (falso)",
  math: "type the result",
  riddle: "type the answer",
  fastest: "type the word on screen as fast as they can",
  race: "bet by typing the number of a racer (1 to 5); long shots pay the most",
  wheel: "bet by typing the number of a color (1 to 4); the rarer the color, the more it pays",
  tug: "join a team by typing 1 or 2, then pull the rope by tapping likes, typing PUXA, or sending gifts",
  potato: "type PEGA to grab the hot potato: every second they hold it is a point, but whoever holds it when it blows up loses all of theirs",
};

/** Games with a race or a spin between the bets and the result. */
const RUNS: ReadonlySet<GameKind> = new Set(["race", "wheel"]);
const GENERATED: ReadonlySet<GameKind> = new Set(GENERATED_KINDS);

const POINTS = { correct: 10, fastestBonus: 5, truefalse: 5, solo: 15, number: 20, fastest: 10 };

/** The reveal stays up at least this long, and the host gets this long to finish talking about it. */
const REVEAL_MIN_MS = 7_000;
const REVEAL_MAX_MS = 25_000;
const RESULTS_MIN_MS = 10_000;
const RESULTS_MAX_MS = 30_000;
/** The first round waits this long at most for the host to stop talking. */
const READY_MAX_MS = 15_000;
/** Below this, the host is told to hurry chat instead of reading out the time. */
const HURRY_MS = 5_000;
/** Writing questions takes this long at most before the bank fills in. */
const PREP_TIMEOUT_MS = 20_000;
/** How many of a kind's past rounds the writer is told to stay away from. */
const AVOID_MAX = 60;
/** How many past rounds a stream remembers, so a long stream doesn't repeat itself. */
const PLAYED_MAX = 600;
const PUBLISH_EVERY_MS = 250;
const GUESS_COOLDOWN_MS = 2_500;
/** Hints show up after this share of the round. */
const HINT_AT = 0.5;
/** How much time the time power-up adds. */
const BOOST_TIME_MS = 10_000;
const BOOST_NOTES: Record<BoostKind, string> = {
  time: "10 more seconds to answer",
  hint: "a hint (in a quiz, two wrong options are gone)",
  double: "double points this round",
};
/** A reveal or results cue the host hasn't got to in this long is old news. */
const CUE_TTL_MS = 40_000;
/** A race's lead changes make news at most this often. */
const RACE_EVENT_MS = 1_500;
/** The potato's board goes out at least this often, so the heat keeps climbing on stage. */
const HEAT_EVERY_MS = 1_000;

/**
 * Runs chat minigames (ADR-0023): prepares the rounds, turns chat messages
 * into answers, keeps score, drives the stage's game scene, and tells the
 * director what the host should announce at each moment.
 *
 * Time moves forward in `tick`, which the director calls several times a
 * second, so everything is testable with a fake clock.
 */
export class GameMaster {
  private game: ActiveGame | null = null;
  /** What the host should announce, in order: a round, its reveal, the next round, the results. */
  private cues: PendingCue[] = [];
  private dirty = false;
  private publishedAt = 0;
  private endedAt = -Infinity;
  /** Rounds played this stream, so games don't repeat themselves. */
  private played: RoundContent[] = [];
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: GameMasterOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  isActive(): boolean {
    return this.game !== null;
  }

  /** When the last game ended (for spacing out segment games). */
  lastEndedAt(): number {
    return this.endedAt;
  }

  source(): GameSource | null {
    return this.game?.source ?? null;
  }

  start(config: GameConfig, source: GameSource, chatSample: string[] = []): { ok: true } | { ok: false; error: string } {
    if (this.game) return { ok: false, error: "Já tem um jogo rolando. Pare esse primeiro." };
    if (this.options.ranking?.isRevealing()) return { ok: false, error: "O pódio da rodada está sendo revelado. Espere terminar." };
    const now = this.now();
    const game: ActiveGame = {
      config,
      source,
      phase: "preparing",
      queue: [],
      index: 0,
      round: null,
      phaseAt: now,
      readyAt: null,
      scores: new Map(),
      prep: null,
    };
    this.game = game;
    this.cues = [];
    const kind = config.kind;
    if (isGenerated(kind)) {
      game.readyAt = now;
    } else {
      void this.prepare(game, kind, chatSample);
    }
    this.options.onChange?.();
    return { ok: true };
  }

  /** Ends the game now (the creator stopped it, the segment changed, the stream ended). */
  stop(): void {
    const game = this.game;
    if (!game) return;
    game.prep?.abort();
    this.finish();
  }

  /** The next cue for the host's game turns, oldest first. Taking it removes it. */
  takeCue(): GameCue | null {
    this.dropStaleCues();
    const cue = this.cues.shift();
    if (!cue) return null;
    // How long is left when the host gets to it, not when the round opened.
    const left = cue.closesAt === undefined ? undefined : cue.closesAt - this.now();
    const time = left === undefined ? "" : left >= HURRY_MS ? ` They have about ${Math.round(left / 1000)} seconds left.` : " Time is almost up: tell them to answer right now.";
    return { note: `${cue.note}${time}`, line: cue.line, history: cue.history };
  }

  /**
   * A round is ready to go up as soon as the host stops talking. The director
   * holds new turns meanwhile, so the round opens when the host can read it
   * and its timer doesn't run while the host talks about something else.
   */
  wantsFloor(): boolean {
    const game = this.game;
    if (!game || this.hasCue()) return false;
    if (game.phase === "preparing") return game.readyAt !== null;
    return game.phase === "reveal" && this.now() - game.phaseAt >= REVEAL_MIN_MS && game.index + 1 < game.config.rounds && this.hasNextRound(game);
  }

  /** True while a game moment is waiting to be announced. */
  hasCue(): boolean {
    this.dropStaleCues();
    return this.cues.length > 0;
  }

  /**
   * Reads a chat message as an answer. Returns true when the game took it,
   * so it isn't also queued for the host to react to.
   */
  handleChat(event: Extract<LiveEvent, { kind: "chat" | "question" }>): boolean {
    const game = this.game;
    const round = game?.round;
    if (!game || !round || game.phase !== "open") return false;
    const now = this.now();
    const viewer = event.viewer;
    const name = this.nameOf(viewer);
    const content = round.content;
    switch (content.kind) {
      case "trivia":
      case "poll": {
        const choice = readOption(event.text, content.options);
        if (choice === undefined) return false;
        if (!round.answers.has(viewer.id)) {
          round.answers.set(viewer.id, { value: choice, at: now, name });
          this.dirty = true;
        }
        return true;
      }
      case "truefalse": {
        const choice = readTrueFalse(event.text);
        if (choice === undefined) return false;
        if (!round.answers.has(viewer.id)) {
          round.answers.set(viewer.id, { value: choice, at: now, name });
          this.dirty = true;
        }
        return true;
      }
      case "math": {
        const value = readNumber(event.text);
        if (value === undefined) return false;
        this.guess(game, round, viewer, name, value === content.answer, now);
        return true;
      }
      case "number": {
        const value = readNumber(event.text);
        if (value === undefined) return false;
        const last = round.lastGuessAt.get(viewer.id) ?? -Infinity;
        if (now - last < GUESS_COOLDOWN_MS) return true;
        round.lastGuessAt.set(viewer.id, now);
        const hint = value === content.secret ? "exact" : value < content.secret ? "higher" : "lower";
        if (hint === "higher") round.low = Math.max(round.low, Math.min(value + 1, content.secret));
        if (hint === "lower") round.high = Math.min(round.high, Math.max(value - 1, content.secret));
        round.last = { name, value, hint };
        this.guess(game, round, viewer, name, hint === "exact", now);
        return true;
      }
      case "scramble":
      case "fastest": {
        const word = readWord(event.text);
        if (!word) return false;
        const target = normalize(content.word);
        if (word === target) {
          this.guess(game, round, viewer, name, true, now);
          return true;
        }
        // Near-misses count as guesses; anything else is just chat.
        if (Math.abs(word.length - target.length) > 2) return false;
        this.guess(game, round, viewer, name, false, now);
        return true;
      }
      case "riddle": {
        const words = normalize(event.text).split(" ").length;
        if (words > 4) return false;
        if (matchesAnswer(event.text, content.answers)) {
          this.guess(game, round, viewer, name, true, now);
          return true;
        }
        // Wrong guesses stay in chat: the host can tease them (without giving it away).
        round.guesses += 1;
        this.dirty = true;
        return false;
      }
      case "race":
      case "wheel": {
        const labels = content.kind === "race" ? content.racers.map((racer) => racer.name) : content.sectors.map((sector) => sector.label);
        const choice = readPick(event.text, labels);
        if (choice === undefined) return false;
        // One bet each: the first one counts.
        if (!round.answers.has(viewer.id)) {
          round.answers.set(viewer.id, { value: choice, at: now, name });
          this.dirty = true;
        }
        return true;
      }
      case "tug": {
        const member = round.pullers.get(viewer.id);
        const team = readPick(event.text, content.teams);
        if (!member) {
          if (team === undefined) return false;
          round.pullers.set(viewer.id, { team: team as 0 | 1, name, pulls: 0 });
          this.pull(round, viewer.id, PULL.message);
          return true;
        }
        if (team === undefined && !readPull(event.text)) return false;
        // Typing pulls too, but not faster than a pull every couple of seconds.
        const last = round.lastGuessAt.get(viewer.id) ?? -Infinity;
        if (now - last >= GUESS_COOLDOWN_MS) {
          round.lastGuessAt.set(viewer.id, now);
          this.pull(round, viewer.id, PULL.message);
        }
        return true;
      }
      case "potato": {
        if (!readGrab(event.text)) return false;
        if (round.holder?.id === viewer.id) return true;
        const last = round.lastGuessAt.get(viewer.id) ?? -Infinity;
        if (now - last < GRAB_COOLDOWN_MS) return true;
        round.lastGuessAt.set(viewer.id, now);
        this.letGo(round, now);
        round.holder = { id: viewer.id, name, since: now };
        round.grabs += 1;
        this.dirty = true;
        return true;
      }
    }
  }

  /**
   * Likes pull the rope for the liker's team in a tug of war (ADR-0038).
   * Anything else ignores them.
   */
  handleLike(event: Extract<LiveEvent, { kind: "like" }>): void {
    const round = this.game?.round;
    if (!round || this.game?.phase !== "open" || round.content.kind !== "tug" || !round.pullers.has(event.viewer.id)) return;
    this.pull(round, event.viewer.id, Math.min(PULL_LIKES_MAX, event.count) * PULL.like);
  }

  /**
   * A gift during an open round counts toward its power-ups (ADR-0029):
   * each threshold of diamonds unlocks a boost for everyone playing. The
   * gifter gets thanked, never points or the answer.
   */
  handleGift(event: Extract<LiveEvent, { kind: "gift" }>): BoostKind[] {
    const game = this.game;
    const round = game?.round;
    if (!game || !round || game.phase !== "open") return [];
    // A tug of war is a team battle, like TikTok's own: a gift pulls hard for the gifter's team (ADR-0038).
    if (round.content.kind === "tug" && round.pullers.has(event.viewer.id)) this.pull(round, event.viewer.id, event.diamonds * PULL.diamond);
    round.gifted += event.diamonds;
    const by = this.nameOf(event.viewer);
    const unlocked: BoostKind[] = [];
    for (const boost of BOOST_KINDS) {
      if (round.boosts.includes(boost) || round.gifted < BOOST_DIAMONDS[boost]) continue;
      if (!this.applyBoost(round, boost)) continue;
      round.boosts.push(boost);
      unlocked.push(boost);
    }
    if (!unlocked.length) return [];
    // More time: the host's still-unread question tells chat the new time left.
    if (unlocked.includes("time")) {
      for (const cue of this.cues) if (cue.phase === "open" && cue.round === game.index && cue.closesAt !== undefined) cue.closesAt += BOOST_TIME_MS;
    }
    const now = this.now();
    this.options.stage.boost?.(unlocked[unlocked.length - 1] as BoostKind, by);
    this.options.stage.fx("sparkles", 1.5);
    this.sound("levelup");
    this.publish();
    const what = unlocked.map((boost) => BOOST_NOTES[boost]).join(", and ");
    this.cues.push({
      note: `${by}'s gift just powered up this round for everyone: ${what}. Thank ${by} by name and hype it in one short line. Don't hint at the answer beyond what's on screen.`,
      line: `Valeu, ${by}! ${unlocked.map((boost) => BOOST_LABELS[boost]).join(" e ")}!`,
      history: `${by}'s gift powered up round ${game.index + 1}: ${unlocked.join(", ")}.`,
      round: game.index,
      phase: "open",
      at: now,
      boost: true,
    });
    this.options.onChange?.();
    return unlocked;
  }

  /** Advances timers. Call several times a second; `speechIdle` says the host finished talking. */
  tick(speechIdle: boolean): void {
    const game = this.game;
    if (!game) return;
    const now = this.now();
    const round = game.round;
    switch (game.phase) {
      case "open":
        if (!round) break;
        // The potato blows up when it blows up: the fuse runs on the server's clock, not the viewers'.
        if (now - round.openedAt >= round.durationMs + (round.content.kind === "potato" ? 0 : (this.options.streamDelayMs ?? 0))) {
          if (RUNS.has(round.content.kind)) this.run(game, now);
          else this.reveal(game, now);
        } else if (round.content.kind === "potato" && now - round.heatAt >= HEAT_EVERY_MS) this.dirty = true;
        break;
      case "running":
        if (round) this.running(game, round, now);
        break;
      case "reveal": {
        // The next round waits until the host has announced this one's answer.
        const shown = now - game.phaseAt;
        if ((shown >= REVEAL_MIN_MS && speechIdle && !this.hasCue()) || shown >= REVEAL_MAX_MS) {
          if (game.index + 1 < game.config.rounds && this.hasNextRound(game)) {
            game.index += 1;
            this.openRound(game);
          } else {
            this.results(game, now);
          }
        }
        break;
      }
      case "results": {
        const shown = now - game.phaseAt;
        if ((shown >= RESULTS_MIN_MS && speechIdle && !this.hasCue()) || shown >= RESULTS_MAX_MS) this.finish();
        break;
      }
      case "preparing":
        if (game.readyAt !== null && (speechIdle || now - game.readyAt >= READY_MAX_MS)) this.openRound(game);
        break;
    }
    if (this.dirty && now - this.publishedAt >= PUBLISH_EVERY_MS) this.publish();
  }

  status(): GameStatus | null {
    const game = this.game;
    if (!game) return null;
    const round = game.round;
    const now = this.now();
    return {
      kind: game.config.kind,
      topic: game.config.topic ?? null,
      phase: game.phase,
      round: game.index + 1,
      rounds: game.config.rounds,
      prompt: round ? promptOf(round) : "",
      answer: round ? answerOf(round.content) : null,
      remainingSec: round && game.phase === "open" ? Math.max(0, Math.ceil((round.openedAt + round.durationMs - now) / 1000)) : 0,
      answers: round ? entries(round) : 0,
      boosts: round ? [...round.boosts] : [],
      leaderboard: this.leaderboard(game).slice(0, 5),
      source: game.source,
    };
  }

  /** The game as the host may see it: never an open round's answer. */
  hostContext(): string | undefined {
    const game = this.game;
    if (!game) return undefined;
    const label = GAME_LABELS[game.config.kind];
    const lines = [`${label}${game.config.topic ? ` about ${game.config.topic}` : ""}, round ${game.index + 1} of ${game.config.rounds}. Viewers ${HOW_TO_ANSWER[game.config.kind]}.`];
    const round = game.round;
    if (game.phase === "preparing") lines.push(game.readyAt === null ? "Setting up the questions right now." : "The first round goes up as soon as you finish talking.");
    if (round && game.phase === "open") {
      const left = Math.ceil((round.openedAt + round.durationMs - this.now()) / 1000);
      const answers = `${entries(round)} answers so far`;
      lines.push(`On screen: ${promptOf(round)}`);
      const live = liveState(round, this.now());
      if (live) lines.push(live);
      if (round.content.kind === "potato") lines.push("The fuse is secret, even to you: never guess when it blows.");
      else
        lines.push(
          left > 0
            ? `Open for ${left} more seconds; ${answers}. Don't reveal or hint at the answer.`
            : `Time is up on screen; the last answers are still coming in (${answers}). Don't reveal or hint at the answer yet.`,
        );
    }
    if (round && game.phase === "running") {
      lines.push(`On screen: ${promptOf(round)}`);
      lines.push(liveState(round, this.now()) ?? "It's running.");
      lines.push("Bets are closed. Nobody knows how it ends yet: don't guess the result.");
    }
    if (round && game.phase === "reveal") lines.push(`Just revealed: ${promptOf(round)} Result: ${resultOf(round) ?? "(a vote)"}.`);
    if (game.phase === "results") lines.push("The game just ended.");
    const board = this.leaderboard(game).slice(0, 3);
    if (board.length) lines.push(`Leaderboard: ${board.map((row) => `${row.name} ${row.points}`).join(", ")}.`);
    const standings = this.options.ranking?.standings();
    if (standings) lines.push(standings);
    return lines.join("\n");
  }

  /** What a quiet moment should be about while a game runs. */
  fillerNote(): string | undefined {
    const game = this.game;
    if (!game) return undefined;
    const label = GAME_LABELS[game.config.kind];
    switch (game.phase) {
      case "preparing":
        return `You're setting up a round of ${label}. Tease it in a line or two and tell chat to get ready.`;
      case "open":
        return `A ${label} round is open. Hype it in one or two short lines, say how much time is left if it's getting close, and remind chat to ${HOW_TO_ANSWER[game.config.kind]}. Never hint at the answer.`;
      case "running":
        return `The ${label} is running: build the suspense in one short line, without guessing how it ends.`;
      default:
        return `The ${label} game is between rounds. Banter about it briefly: who's leading, who almost had it.`;
    }
  }

  // ---- flow ----------------------------------------------------------------

  private async prepare(game: ActiveGame, kind: WrittenKind, chatSample: string[]): Promise<void> {
    const prep = new AbortController();
    game.prep = prep;
    const timeout = setTimeout(() => prep.abort(), PREP_TIMEOUT_MS);
    const wanted = game.config.rounds;
    let rounds: RoundContent[] = [];
    try {
      if (this.options.writer) {
        const written = await this.options.writer.write(
          {
            kind,
            count: wanted + 2,
            ...(game.config.topic ? { topic: game.config.topic } : {}),
            ...(this.options.language() ? { language: this.options.language() as string } : {}),
            chatSample: chatSample.slice(-12),
            avoid: this.played
              .filter((round) => round.kind === kind)
              .slice(-AVOID_MAX)
              .map(avoidLine),
            ...(game.config.topic ? {} : { themes: pickThemes(kind, this.random) }),
          },
          prep.signal,
        );
        // Models reword what they wrote before: drop a round that's an old one in new words, or a twin of another in the batch.
        const fresh: RoundContent[] = [];
        for (const round of written) if (!this.wasPlayed(round) && !fresh.some((kept) => sameIdea(kept, round))) fresh.push(round);
        rounds = await this.vet(fresh);
      }
    } catch (err) {
      if (this.game === game) this.options.log?.warn("couldn't write game rounds; using the built-in ones", err);
    } finally {
      clearTimeout(timeout);
      game.prep = null;
    }
    if (this.game !== game) return;
    if (rounds.length < wanted) {
      const language = guessLanguage(this.options.language(), chatSample);
      const queued = rounds;
      rounds.push(...pickFromBank(language, kind, wanted - rounds.length, (item) => this.wasPlayed(item) || queued.some((round) => sameIdea(round, item)), this.random));
    }
    game.queue = rounds.slice(0, wanted);
    if (game.queue.length === 0) {
      this.options.log?.warn("no rounds available for this game");
      this.finish();
      return;
    }
    game.config = { ...game.config, rounds: Math.min(game.config.rounds, game.queue.length) };
    // The first round goes up once the host stops talking (see tick).
    game.readyAt = this.now();
    this.options.onChange?.();
  }

  /** Runs written rounds through the safety gate (they're shown and read out). Drops what fails. */
  private async vet(rounds: RoundContent[]): Promise<RoundContent[]> {
    const verdicts = await Promise.all(
      rounds.map((round) =>
        this.options.gate.check(textOf(round), "A round written for a chat minigame on the stream.").catch(() => ({ safe: false as const, reason: "moderator unavailable" })),
      ),
    );
    return rounds.filter((round, i) => {
      const verdict = verdicts[i];
      if (verdict && !verdict.safe) this.options.log?.info(`dropped a game round (${verdict.reason})`);
      return verdict?.safe === true;
    });
  }

  private wasPlayed(round: RoundContent): boolean {
    return this.played.some((old) => sameIdea(old, round));
  }

  private hasNextRound(game: ActiveGame): boolean {
    const kind = game.config.kind;
    // Generated kinds make each round as it opens; their queue stays empty.
    return isGenerated(kind) || game.index < game.queue.length;
  }

  private openRound(game: ActiveGame): void {
    const now = this.now();
    const kind = game.config.kind;
    const content: RoundContent = isGenerated(kind) ? this.generate(kind, game.index + 1) : (game.queue[game.index] as RoundContent);
    this.played = [...this.played, content].slice(-PLAYED_MAX);
    const round: Round = {
      content,
      openedAt: now,
      durationMs: content.kind === "potato" ? content.fuseMs : OPEN_MS[kind],
      answers: new Map(),
      guesses: 0,
      winner: null,
      low: content.kind === "number" ? content.min : 0,
      high: content.kind === "number" ? content.max : 0,
      last: null,
      lastGuessAt: new Map(),
      letters: content.kind === "scramble" ? scrambleLetters(content.word, this.random) : "",
      gifted: 0,
      boosts: [],
      removed: [],
      hintEarly: false,
      ranAt: -1,
      leader: -1,
      event: null,
      eventAt: -Infinity,
      finalStretch: false,
      pullers: new Map(),
      pulls: [0, 0],
      holder: null,
      held: new Map(),
      grabs: 0,
      exploded: null,
      heatAt: now,
    };
    game.round = round;
    game.phase = "open";
    game.phaseAt = now;
    this.publish();
    this.sound("start");
    const first = game.index === 0;
    const label = GAME_LABELS[kind];
    const intro = first
      ? `This is the start of a ${label} game with ${game.config.rounds} rounds${game.config.topic ? ` about ${game.config.topic}` : ""}: say in one short line how it works (viewers ${HOW_TO_ANSWER[kind]}). `
      : "";
    this.cues.push({
      note: `${intro}Round ${game.index + 1} of ${game.config.rounds} is on screen now: ${promptOf(round)} ${openInstruction(content)}`,
      line: first ? `${label}! Rodada ${game.index + 1}. ${spokenPrompt(round)}` : `Rodada ${game.index + 1}! ${spokenPrompt(round)}`,
      history: `${label} round ${game.index + 1} of ${game.config.rounds} opened: ${promptOf(round)}`,
      round: game.index,
      phase: "open",
      at: now,
      // The potato's fuse is secret: its cue never says how long is left.
      ...(content.kind === "potato" ? {} : { closesAt: now + round.durationMs }),
    });
    this.options.onChange?.();
  }

  /** Makes up a round of a generated game, steering clear of what this stream already played. */
  private generate(kind: GeneratedKind, round: number): RoundContent {
    switch (kind) {
      case "number":
        return makeNumber(this.random);
      case "math":
        return makeMath(round, this.random);
      case "race":
        return makeRace(this.random);
      case "wheel":
        return makeWheel(this.random);
      case "tug":
        return makeTug(this.random, (pair) => this.wasPlayed(pair));
      case "potato":
        return makePotato(this.random);
    }
  }

  /** Bets are in: the race starts (or the strip spins). The result comes when it's over. */
  private run(game: ActiveGame, now: number): void {
    const round = game.round;
    if (!round) return;
    game.phase = "running";
    game.phaseAt = now;
    round.ranAt = now;
    const content = round.content;
    const label = GAME_LABELS[content.kind];
    const bets = round.answers.size;
    const favorite = this.favorite(round);
    this.publish();
    this.sound("start");
    // The question nobody read out is old news: the race is on.
    this.cues = this.cues.filter((cue) => !(cue.round === game.index && cue.phase === "open"));
    if (content.kind === "race") {
      this.cues.push({
        note: `Bets are closed (${bets} bet${bets === 1 ? "" : "s"}${favorite ? `, most on ${favorite}` : ""}) and the race is on: about ${Math.round(RACE_MS / 1000)} seconds. Narrate it like a frantic horse-racing caster in two short, punchy lines ("E LARGARAM!"). You don't know who wins: don't guess.`,
        line: "E largaram! Quem vai levar essa?",
        history: `${label} round ${game.index + 1}: bets closed (${bets}), the race started.`,
        round: game.index,
        phase: "running",
        at: now,
      });
    } else {
      this.cues.push({
        note: `Bets are closed (${bets} bet${bets === 1 ? "" : "s"}${favorite ? `, most on ${favorite}` : ""}) and the wheel is spinning. Build the suspense in one short line. You don't know where it stops: don't guess.`,
        line: "Girando, girando... onde será que para?",
        history: `${label} round ${game.index + 1}: bets closed (${bets}), the wheel is spinning.`,
        round: game.index,
        phase: "running",
        at: now,
      });
    }
    this.options.onChange?.();
  }

  /** A race or a spin under way: the lead changes hands, and the result comes once it's over. */
  private running(game: ActiveGame, round: Round, now: number): void {
    const content = round.content;
    const elapsed = now - round.ranAt;
    if (content.kind === "wheel") {
      if (elapsed >= SPIN_MS) this.reveal(game, now);
      return;
    }
    if (content.kind !== "race") return;
    const finish = content.splits[content.winner]?.at(-1) ?? RACE_MS;
    if (elapsed >= finish) {
      this.reveal(game, now);
      return;
    }
    this.dirty = true;
    const leader = raceLeader(content, elapsed);
    const lead = raceProgress(content.splits[leader] ?? [], elapsed);
    if (!round.finalStretch && lead >= 0.8) {
      round.finalStretch = true;
      round.event = `Reta final! ${content.racers[leader]?.name} na frente!`;
      round.eventAt = now;
    } else if (leader !== round.leader && now - round.eventAt >= RACE_EVENT_MS) {
      round.event = round.leader === -1 ? `${content.racers[leader]?.name} larga na frente!` : `${content.racers[leader]?.name} assumiu a ponta!`;
      round.eventAt = now;
    }
    round.leader = leader;
  }

  /** The option most bets went to, if any. */
  private favorite(round: Round): string | undefined {
    const content = round.content;
    if (content.kind !== "race" && content.kind !== "wheel") return undefined;
    const labels = content.kind === "race" ? content.racers.map((racer) => racer.name) : content.sectors.map((sector) => sector.label);
    const tally = this.tally(round, labels.length);
    const top = Math.max(...tally);
    return top > 0 ? labels[tally.indexOf(top)] : undefined;
  }

  /** Adds pulls for a tug of war player's team. */
  private pull(round: Round, viewerId: string, amount: number): void {
    const puller = round.pullers.get(viewerId);
    if (!puller || amount <= 0) return;
    puller.pulls += amount;
    round.pulls[puller.team] += amount;
    this.dirty = true;
  }

  /** Whoever has the potato lets go: the time they held it is theirs to keep (unless it blows up on them later). */
  private letGo(round: Round, now: number): void {
    const holder = round.holder;
    if (!holder) return;
    const row = round.held.get(holder.id) ?? { name: holder.name, ms: 0 };
    row.ms += now - holder.since;
    round.held.set(holder.id, row);
    round.holder = null;
  }

  private guess(game: ActiveGame, round: Round, viewer: Viewer, name: string, correct: boolean, now: number): void {
    round.guesses += 1;
    this.dirty = true;
    if (!correct || round.winner) return;
    round.winner = { id: viewer.id, name, ms: now - round.openedAt };
    const kind = round.content.kind;
    this.award(game, viewer.id, name, multiplier(round) * (kind === "number" ? POINTS.number : kind === "fastest" ? POINTS.fastest : POINTS.solo));
    if (FIRST_WINS.has(kind)) this.reveal(game, now);
  }

  private reveal(game: ActiveGame, now: number): void {
    const round = game.round;
    if (!round) return;
    game.phase = "reveal";
    game.phaseAt = now;
    const content = round.content;
    const label = GAME_LABELS[content.kind];
    let summary: string;
    let line: string;
    let won = false;
    switch (content.kind) {
      case "trivia":
      case "truefalse": {
        const right = [...round.answers.entries()]
          .filter(([, answer]) => answer.value === (content.kind === "trivia" ? content.correct : content.answer))
          .sort((a, b) => a[1].at - b[1].at);
        const each = content.kind === "trivia" ? POINTS.correct : POINTS.truefalse;
        right.forEach(([id, answer], i) => this.award(game, id, answer.name, multiplier(round) * (each + (i === 0 ? POINTS.fastestBonus : 0))));
        const total = round.answers.size;
        won = right.length > 0;
        summary = `The answer: ${answerOf(content)}. ${won ? `${right[0]?.[1].name} was fastest; ${right.length} of ${total} got it right.` : total ? `Nobody of ${total} got it.` : "Nobody answered."}`;
        line = `Era ${answerOf(content)}! ${won ? `${right[0]?.[1].name} acertou primeiro.` : "Ninguém acertou dessa vez."}`;
        break;
      }
      case "poll": {
        const tally = this.tally(round, content.options.length);
        const total = tally.reduce((a, b) => a + b, 0);
        const results = content.options.map((option, i) => `${OPTION_LETTERS[i]}) ${option}: ${tally[i]} vote${tally[i] === 1 ? "" : "s"}${total ? ` (${Math.round(((tally[i] ?? 0) / total) * 100)}%)` : ""}`);
        const top = tally.indexOf(Math.max(...tally));
        summary = total ? `Votes are in. ${results.join("; ")}.` : "Nobody voted.";
        line = total ? `Votação encerrada, e ${content.options[top]} venceu!` : "Ninguém votou? Sério?";
        won = total > 0;
        break;
      }
      case "race":
      case "wheel": {
        const result = content.kind === "race" ? content.winner : wheelResult(content);
        const option = content.kind === "race" ? content.racers[result] : content.sectors[result];
        const name = content.kind === "race" ? content.racers[result]?.name : content.sectors[result]?.label;
        const odds = option?.odds ?? 2;
        const each = (content.kind === "race" ? RACE_POINTS : WHEEL_POINTS) * odds;
        const right = [...round.answers.entries()].filter(([, answer]) => answer.value === result).sort((a, b) => a[1].at - b[1].at);
        right.forEach(([id, answer]) => this.award(game, id, answer.name, multiplier(round) * each));
        const total = round.answers.size;
        won = right.length > 0;
        const what = content.kind === "race" ? `${name} won the race` : `The wheel stopped on ${name}`;
        summary = `${what} (it paid ×${odds}, ${multiplier(round) * each} points). ${won ? `${right.length} of ${total} bet on it, ${right[0]?.[1].name} first.` : total ? `Nobody of ${total} bet on it.` : "Nobody bet."}`;
        line = content.kind === "race" ? `${name} venceu a corrida!${won ? ` ${right[0]?.[1].name} apostou certo!` : ""}` : `Parou no ${name}!${won ? ` ${right[0]?.[1].name} acertou!` : ""}`;
        break;
      }
      case "tug": {
        const [a, b] = round.pulls;
        const team = a === b ? null : a > b ? 0 : 1;
        if (team !== null) {
          const members = [...round.pullers.entries()].filter(([, puller]) => puller.team === team);
          members.forEach(([id, puller]) => this.award(game, id, puller.name, multiplier(round) * TUG_POINTS));
          const mvp = members.sort((x, y) => y[1].pulls - x[1].pulls)[0];
          if (mvp) this.award(game, mvp[0], mvp[1].name, multiplier(round) * TUG_POINTS);
          won = members.length > 0;
          summary = `Team ${content.teams[team]} won the tug of war, ${Math.max(a, b)} pulls to ${Math.min(a, b)}${mvp ? `; ${mvp[1].name} pulled the most` : ""}. Everyone on the team scores.`;
          line = `Vitória do time ${content.teams[team]}!${mvp ? ` ${mvp[1].name} puxou mais que todo mundo.` : ""}`;
        } else {
          summary = round.pullers.size ? `A tie, ${a} pulls each: nobody scores.` : "Nobody joined a team.";
          line = round.pullers.size ? "Empate! Que cabo de guerra!" : "Ninguém entrou num time? Bora na próxima!";
        }
        break;
      }
      case "potato": {
        const holder = round.holder;
        this.letGo(round, now);
        const seconds = (ms: number) => Math.min(POTATO_MAX_POINTS, Math.floor(ms / 1000));
        if (holder) {
          // It blew up in their hands: everything they held this round is gone.
          round.exploded = { name: holder.name, lost: multiplier(round) * seconds(round.held.get(holder.id)?.ms ?? 0) };
          round.held.delete(holder.id);
        }
        const safe = [...round.held.entries()].filter(([, row]) => seconds(row.ms) > 0).sort((a, b) => b[1].ms - a[1].ms);
        safe.forEach(([id, row]) => this.award(game, id, row.name, multiplier(round) * seconds(row.ms)));
        won = safe.length > 0;
        const best = safe[0]?.[1];
        const rest = best ? `${best.name} banked the most: ${multiplier(round) * seconds(best.ms)} points.` : "Nobody else banked any points.";
        summary = holder
          ? `BOOM! The potato blew up in ${holder.name}'s hands, and they lose their ${round.exploded?.lost ?? 0} points. ${rest}`
          : `BOOM! It blew up with nobody holding it. ${rest}`;
        line = holder ? `BUM! Explodiu na mão de ${holder.name}!` : "BUM! Explodiu sozinha!";
        break;
      }
      case "number":
        won = round.winner !== null;
        summary = won
          ? `${round.winner?.name} guessed it: ${content.secret}, after ${round.guesses} guesses in total.`
          : `Time's up. Nobody got it: the number was ${content.secret}${round.guesses ? `, and the closest window was ${round.low} to ${round.high}` : ""}.`;
        line = won ? `${round.winner?.name} acertou! Era ${content.secret}.` : `Tempo esgotado! Era ${content.secret}.`;
        break;
      default: {
        won = round.winner !== null;
        const answer = answerOf(content);
        const speed = round.winner ? ` in ${(round.winner.ms / 1000).toFixed(1)} seconds` : "";
        summary = won ? `${round.winner?.name} got it first${speed}: ${answer}.` : `Time's up, nobody got it. The answer was ${answer}.`;
        line = won ? `${round.winner?.name} acertou! ${answer}.` : `Tempo esgotado! Era ${answer}.`;
      }
    }
    this.publish();
    if (content.kind === "potato") {
      this.options.stage.fx("shake", 2);
      this.options.stage.fx("fireworks", 1.5);
      this.sound("fail");
    } else if (content.kind !== "poll") {
      this.sound(won ? "win" : "fail");
      if (won) this.options.stage.fx("confetti", 1);
    } else {
      this.sound("reveal");
    }
    // A power-up's thank-you is old news once the answer is out.
    this.cues = this.cues.filter((cue) => !(cue.boost && cue.round === game.index));
    // A round won before the host read it out: skip the question, go straight to the answer. A race already over needs no commentary.
    const unread = this.cues.findIndex((cue) => cue.phase === "open" && cue.round === game.index && !cue.boost);
    if (unread !== -1) this.cues.splice(unread, 1);
    this.cues = this.cues.filter((cue) => !(cue.phase === "running" && cue.round === game.index));
    const early = unread !== -1 ? "The round ended before you could read it out, so don't read the question now. " : "";
    const cheer =
      content.kind === "potato"
        ? " Make the explosion a big moment: tease whoever it blew up on (playfully) and praise who banked the most"
        : content.kind === "tug"
          ? " and cheer the winning team"
          : won && content.kind !== "poll"
            ? " and congratulate the winner by name"
            : content.kind === "poll"
              ? " and give a playful take on the result"
              : "";
    this.cues.push({
      note: `${early}Reveal for round ${game.index + 1} of ${game.config.rounds}. ${summary} Announce it with energy${cheer}.`,
      line,
      history: `${label} round ${game.index + 1}: ${summary}`,
      round: game.index,
      phase: "reveal",
      at: now,
    });
    this.options.onChange?.();
  }

  private results(game: ActiveGame, now: number): void {
    game.phase = "results";
    game.phaseAt = now;
    const board = this.leaderboard(game);
    const label = GAME_LABELS[game.config.kind];
    const scored = board.length > 0 && game.config.kind !== "poll";
    this.options.ranking?.gameFinished();
    this.publish();
    this.sound(scored ? "fanfare" : "chime");
    if (scored) this.options.stage.fx("fireworks", 2);
    const top = board.slice(0, 3).map((row, i) => `${i + 1}. ${row.name} (${row.points} points)`).join(", ");
    const cue = scored
      ? {
          note: `Game over! Final scores: ${top}. Crown the winner, celebrate the top players, and thank everyone who played.`,
          line: `Fim de jogo! Quem venceu foi ${board[0]?.name}! Valeu por jogarem, galera.`,
          history: `${label} game over. Final scores: ${top}.`,
        }
      : {
          note: `That was the last round of ${label}. Thank everyone who played and say you'll do another one later.`,
          line: "Fim de jogo! Valeu por jogarem.",
          history: `${label} game over.`,
        };
    this.cues.push({ ...cue, round: game.index, phase: "results", at: now });
    this.options.onChange?.();
  }

  private finish(): void {
    this.game = null;
    this.cues = [];
    this.endedAt = this.now();
    this.dirty = false;
    this.options.stage.game(null);
    this.options.onChange?.();
  }

  /** An open round's cue goes stale once the round closes, a race's once it's over; the others after a while. */
  private dropStaleCues(): void {
    const game = this.game;
    const now = this.now();
    this.cues = this.cues.filter((cue) =>
      cue.phase === "open" || cue.phase === "running" ? game?.phase === cue.phase && game.index === cue.round : now - cue.at < CUE_TTL_MS,
    );
  }

  /** Applies a power-up to the round; false when it does nothing for this kind of game. */
  private applyBoost(round: Round, boost: BoostKind): boolean {
    const content = round.content;
    switch (boost) {
      case "time":
        // The potato's fuse is secret: more time would be invisible.
        if (content.kind === "potato") return false;
        round.durationMs += BOOST_TIME_MS;
        return true;
      case "double":
        return content.kind !== "poll";
      case "hint":
        switch (content.kind) {
          case "trivia": {
            // A 50/50: take away wrong options until two are left.
            const wrong = content.options.map((_, i) => i).filter((i) => i !== content.correct);
            const keep = wrong[Math.floor(this.random() * wrong.length)];
            round.removed = wrong.filter((i) => i !== keep).slice(0, Math.max(0, content.options.length - 2));
            return round.removed.length > 0;
          }
          case "scramble":
          case "riddle":
            if (round.hintEarly || this.now() - round.openedAt >= round.durationMs * HINT_AT) return false;
            round.hintEarly = true;
            return true;
          case "number": {
            // Halve the window around the secret.
            const span = Math.max(1, Math.floor((round.high - round.low) / 4));
            round.low = Math.max(round.low, content.secret - span);
            round.high = Math.min(round.high, content.secret + span);
            return true;
          }
          default:
            return false;
        }
    }
  }

  // ---- scoring and scenes -------------------------------------------------

  private award(game: ActiveGame, id: string, name: string, points: number): void {
    const row = game.scores.get(id) ?? { name, points: 0 };
    row.name = name;
    row.points += points;
    game.scores.set(id, row);
    this.options.ranking?.add(id, name, points);
  }

  private leaderboard(game: ActiveGame): Array<{ name: string; points: number }> {
    return [...game.scores.values()].filter((row) => row.points > 0).sort((a, b) => b.points - a.points);
  }

  private tally(round: Round, size: number): number[] {
    const tally = new Array<number>(size).fill(0);
    for (const answer of round.answers.values()) {
      const index = typeof answer.value === "boolean" ? (answer.value ? 0 : 1) : answer.value;
      tally[index] = (tally[index] ?? 0) + 1;
    }
    return tally;
  }

  private publish(): void {
    this.dirty = false;
    this.publishedAt = this.now();
    if (this.game?.round) this.game.round.heatAt = this.publishedAt;
    const scene = this.scene();
    if (scene) this.options.stage.game(scene);
  }

  private scene(): GameScene | null {
    const game = this.game;
    if (!game) return null;
    const now = this.now();
    if (game.phase === "results") {
      return {
        kind: "scoreboard",
        title: clip(`Placar final · ${GAME_LABELS[game.config.kind]}`, 60),
        rows: this.leaderboard(game).slice(0, 5),
      };
    }
    const round = game.round;
    if (!round || game.phase === "preparing") return null;
    const revealed = game.phase === "reveal";
    // Bets are closed once a race or a spin starts: on stage that's the reveal.
    const closed = revealed || game.phase === "running";
    const secret = round.content.kind === "potato";
    const base = {
      round: game.index + 1,
      rounds: game.config.rounds,
      phase: closed ? ("reveal" as const) : ("open" as const),
      remainingMs: closed || secret ? 0 : Math.max(0, round.openedAt + round.durationMs - now),
      durationMs: secret ? 0 : round.durationMs,
      ...(round.boosts.length ? { boosts: [...round.boosts] } : {}),
    };
    const stage = revealed ? ("finish" as const) : game.phase === "running" ? ("running" as const) : ("bets" as const);
    const hintShown = revealed || round.hintEarly || now - round.openedAt >= round.durationMs * HINT_AT;
    const content = round.content;
    const winners = () =>
      [...round.answers.values()]
        .filter((a) => a.value === (content.kind === "trivia" ? content.correct : content.kind === "truefalse" ? content.answer : -1))
        .sort((a, b) => a.at - b.at)
        .slice(0, 5)
        .map((a) => a.name);
    switch (content.kind) {
      case "trivia":
        return {
          kind: "trivia",
          ...base,
          question: content.question,
          options: content.options,
          answers: round.answers.size,
          tally: revealed ? this.tally(round, content.options.length) : null,
          correct: revealed ? content.correct : null,
          winners: revealed ? winners() : [],
          ...(round.removed.length ? { removed: [...round.removed] } : {}),
        };
      case "poll":
        return { kind: "poll", ...base, question: content.question, options: content.options, tally: this.tally(round, content.options.length) };
      case "truefalse": {
        const tally = this.tally(round, 2);
        return {
          kind: "truefalse",
          ...base,
          statement: content.statement,
          answers: round.answers.size,
          tally: revealed ? [tally[0] ?? 0, tally[1] ?? 0] : null,
          correct: revealed ? content.answer : null,
          winners: revealed ? winners() : [],
        };
      }
      case "scramble":
        return {
          kind: "scramble",
          ...base,
          letters: round.letters,
          hint: hintShown ? content.hint : null,
          guesses: round.guesses,
          word: revealed ? content.word.toUpperCase() : null,
          winner: round.winner?.name ?? null,
        };
      case "number":
        return {
          kind: "number",
          ...base,
          min: content.min,
          max: content.max,
          low: round.low,
          high: round.high,
          guesses: round.guesses,
          last: round.last,
          answer: revealed ? content.secret : null,
          winner: round.winner?.name ?? null,
        };
      case "math":
        return { kind: "math", ...base, expression: content.expression, guesses: round.guesses, answer: revealed ? content.answer : null, winner: round.winner?.name ?? null };
      case "riddle":
        return {
          kind: "riddle",
          ...base,
          riddle: content.riddle,
          hint: hintShown ? content.hint : null,
          guesses: round.guesses,
          answer: revealed ? clip(content.answers[0] ?? "", 40) : null,
          winner: round.winner?.name ?? null,
        };
      case "fastest":
        return { kind: "fastest", ...base, word: content.word.toUpperCase(), winner: round.winner?.name ?? null, winnerMs: round.winner?.ms ?? null };
      case "race": {
        const tally = this.tally(round, content.racers.length);
        // At the finish the race stands still where the winner crossed the line.
        const elapsed = stage === "bets" ? 0 : Math.min(now - round.ranAt, revealed ? (content.splits[content.winner]?.at(-1) ?? RACE_MS) : Infinity);
        return {
          kind: "race",
          ...base,
          stage,
          racers: content.racers.map((racer, i) => ({
            name: racer.name,
            odds: racer.odds,
            bets: tally[i] ?? 0,
            progress: raceProgress(content.splits[i] ?? [], elapsed),
          })),
          bets: round.answers.size,
          winner: revealed ? content.winner : null,
          winners: revealed ? this.rightBets(round, content.winner) : [],
          event: stage === "running" ? round.event : null,
        };
      }
      case "wheel": {
        const tally = this.tally(round, content.sectors.length);
        return {
          kind: "wheel",
          ...base,
          stage,
          sectors: content.sectors.map((sector, i) => ({ label: sector.label, odds: sector.odds, bets: tally[i] ?? 0 })),
          strip: [...content.strip],
          landing: stage === "bets" ? null : content.landing,
          spinMs: SPIN_MS,
          spinLeftMs: stage === "running" ? Math.max(0, round.ranAt + SPIN_MS - now) : 0,
          bets: round.answers.size,
          result: revealed ? wheelResult(content) : null,
          winners: revealed ? this.rightBets(round, wheelResult(content)) : [],
        };
      }
      case "tug": {
        const [a, b] = round.pulls;
        const members = [0, 0];
        for (const puller of round.pullers.values()) members[puller.team] = (members[puller.team] ?? 0) + 1;
        const team = revealed && a !== b ? (a > b ? 0 : 1) : null;
        const mvp = team === null ? null : ([...round.pullers.values()].filter((puller) => puller.team === team).sort((x, y) => y.pulls - x.pulls)[0]?.name ?? null);
        return {
          kind: "tug",
          ...base,
          teams: content.teams.map((name, i) => ({ name: clip(name, 24), members: members[i] ?? 0, pulls: round.pulls[i] ?? 0 })),
          rope: ropePosition(round.pulls),
          winner: team,
          mvp,
        };
      }
      case "potato": {
        const leaders = [...round.held.values()]
          .filter((row) => row.ms >= 1000)
          .sort((x, y) => y.ms - x.ms)
          .slice(0, 3)
          .map((row) => ({ name: row.name, seconds: Math.min(POTATO_MAX_POINTS, Math.floor(row.ms / 1000)) }));
        return {
          kind: "potato",
          ...base,
          holder: revealed ? null : (round.holder?.name ?? null),
          heldMs: !revealed && round.holder ? now - round.holder.since : 0,
          heat: revealed ? 1 : Math.min(1, (now - round.openedAt) / FUSE_MAX_MS),
          grabs: round.grabs,
          leaders,
          exploded: round.exploded,
        };
      }
    }
  }

  /** Who bet on the result, first bets first. */
  private rightBets(round: Round, result: number): string[] {
    return [...round.answers.values()]
      .filter((answer) => answer.value === result)
      .sort((a, b) => a.at - b.at)
      .slice(0, 5)
      .map((answer) => answer.name);
  }

  private sound(sound: Sound): void {
    if (this.options.sounds()) this.options.stage.sfx(sound);
  }

  private nameOf(viewer: Viewer): string {
    return clip(displayName(viewer, this.options.blocklist()), 24) || clip(viewerName(viewer), 24);
  }
}

/** Double points power-up. */
function multiplier(round: Round): number {
  return round.boosts.includes("double") ? 2 : 1;
}

function isGenerated(kind: GameKind): kind is GeneratedKind {
  return GENERATED.has(kind);
}

/** How many viewers took part in a round so far: answers and guesses, bets, team members, grabs. */
function entries(round: Round): number {
  switch (round.content.kind) {
    case "tug":
      return round.pullers.size;
    case "potato":
      return round.grabs;
    default:
      return round.answers.size + round.guesses;
  }
}

/** What's happening in a party game right now, for the host (never a result that's coming). */
function liveState(round: Round, now: number): string | undefined {
  const content = round.content;
  switch (content.kind) {
    case "race":
      if (round.ranAt < 0) return `${round.answers.size} bets so far.`;
      return round.leader >= 0 ? `${content.racers[round.leader]?.name} is in front right now.` : "They just started.";
    case "wheel":
      return round.ranAt < 0 ? `${round.answers.size} bets so far.` : "The strip is spinning.";
    case "tug": {
      const [a, b] = round.pulls;
      return `Team ${content.teams[0]} ${a} pulls, team ${content.teams[1]} ${b} pulls (${round.pullers.size} players).`;
    }
    case "potato":
      return round.holder
        ? `${round.holder.name} has the potato (for ${Math.round((now - round.holder.since) / 1000)} seconds; ${round.grabs} grabs so far).`
        : "Nobody has grabbed the potato yet.";
    default:
      return undefined;
  }
}

/** A round's outcome in words, at the reveal. */
function resultOf(round: Round): string | null {
  const content = round.content;
  switch (content.kind) {
    case "tug": {
      const [a, b] = round.pulls;
      return a === b ? "a tie" : `team ${content.teams[a > b ? 0 : 1]} won`;
    }
    case "potato":
      return round.exploded ? `it blew up on ${round.exploded.name}` : "it blew up with nobody holding it";
    default:
      return answerOf(content);
  }
}

/** The round as text: what's on screen. */
function promptOf(round: Round): string {
  const content = round.content;
  switch (content.kind) {
    case "trivia":
    case "poll":
      return `"${content.question}" ${content.options.map((option, i) => `${OPTION_LETTERS[i]}) ${option}`).join("  ")}`;
    case "truefalse":
      return `Verdadeiro ou falso: "${content.statement}"`;
    case "scramble":
      return `Desembaralhe: ${round.letters}`;
    case "number":
      return `Adivinhe o número de ${content.min} a ${content.max} (agora entre ${round.low} e ${round.high})`;
    case "math":
      return `${content.expression} = ?`;
    case "riddle":
      return `Charada: "${content.riddle}"`;
    case "fastest":
      return `Digite primeiro: ${content.word.toUpperCase()}`;
    case "race":
      return `Corrida maluca, apostas: ${content.racers.map((racer, i) => `${i + 1}) ${racer.name} paga ×${racer.odds}`).join("  ")}`;
    case "wheel":
      return `Roleta da sorte, apostas: ${content.sectors.map((sector, i) => `${i + 1}) ${sector.label} paga ×${sector.odds}`).join("  ")}`;
    case "tug":
      return `Cabo de guerra: 1) Time ${content.teams[0]} contra 2) Time ${content.teams[1]}`;
    case "potato":
      return "Batata quente: digite PEGA pra pegar a batata";
  }
}

/** What the offline host reads out. */
function spokenPrompt(round: Round): string {
  const content = round.content;
  switch (content.kind) {
    case "trivia":
    case "poll":
      return `${content.question} ${content.options.map((option, i) => `${OPTION_LETTERS[i]}, ${option}.`).join(" ")}`;
    case "truefalse":
      return `Verdadeiro ou falso? ${content.statement}`;
    case "scramble":
      return "Desembaralhe a palavra na tela!";
    case "number":
      return `Pensei num número de ${content.min} a ${content.max}. Adivinha!`;
    case "math":
      return `Rápido, quanto é ${content.expression.replace("×", "vezes").replace("−", "menos")}?`;
    case "riddle":
      return content.riddle;
    case "fastest":
      return "Digite a palavra da tela, rápido!";
    case "race":
      return `Apostem no número do cavalo! ${content.racers.map((racer, i) => `${i + 1}, ${racer.name}.`).join(" ")}`;
    case "wheel":
      return "Apostem na cor! Um azul, dois verde, três roxo, quatro ouro. O ouro paga vinte vezes!";
    case "tug":
      return `Digite um pro time ${content.teams[0]} ou dois pro time ${content.teams[1]}, e curtam pra puxar a corda!`;
    case "potato":
      return "Digite pega pra pegar a batata! Quem estiver com ela quando explodir perde tudo!";
  }
}

function openInstruction(content: RoundContent): string {
  switch (content.kind) {
    case "trivia":
      return "Read the question and the four options out loud, then tell chat to type the letter.";
    case "poll":
      return "Ask it with some drama and tell chat to vote with the letter.";
    case "truefalse":
      return "Read the statement and tell chat to type V (verdadeiro) or F (falso).";
    case "scramble":
      return "Say the scrambled letters are on screen and tell chat to type the word. Never say the word or spell it out.";
    case "number":
      return "Say you're thinking of a secret number and chat should type guesses. Never say the number.";
    case "math":
      return "Read the sum out loud and tell chat to type the result. Don't say the result.";
    case "riddle":
      return "Read the riddle out loud, slowly, and tell chat to type the answer. Don't hint at it.";
    case "fastest":
      return "Shout that the word is on screen and the fastest typer wins. You may read the word out.";
    case "race":
      return "Read the five racers and what each pays (the ×), then tell chat to bet by typing the racer's number, one bet each. Hype the long shots: they pay the most.";
    case "wheel":
      return "Say the four colors and what each pays, then tell chat to bet by typing the color's number, one bet each. Gold is the rarest and pays ×20.";
    case "tug":
      return "Announce the two teams with drama, tell chat to type 1 or 2 to join one, and that every like, every PUXA in chat and every gift pulls the rope for their team.";
    case "potato":
      return "Explain it fast and with energy: type PEGA to grab the potato, every second holding it is a point, and whoever holds it when it blows up loses all of theirs. Nobody knows when it blows, not even you.";
  }
}

/** The answer in words, or null for a vote. */
function answerOf(content: RoundContent): string | null {
  switch (content.kind) {
    case "trivia":
      return `${OPTION_LETTERS[content.correct]}) ${content.options[content.correct]}`;
    case "poll":
      return null;
    case "truefalse":
      return content.answer ? "verdadeiro" : "falso";
    case "scramble":
    case "fastest":
      return content.word.toUpperCase();
    case "number":
      return String(content.secret);
    case "math":
      return String(content.answer);
    case "riddle":
      return content.answers[0] ?? "";
    // For the creator in the studio: how the round will end (the host never sees it before the reveal).
    case "race":
      return content.racers[content.winner]?.name ?? null;
    case "wheel":
      return content.sectors[wheelResult(content)]?.label ?? null;
    case "tug":
      return null;
    case "potato":
      return `explode em ${Math.round(content.fuseMs / 1000)} s`;
  }
}

/** All of a round's text, for moderation. */
function textOf(content: RoundContent): string {
  switch (content.kind) {
    case "trivia":
    case "poll":
      return `${content.question} ${content.options.join(" / ")}`;
    case "truefalse":
      return content.statement;
    case "scramble":
      return `${content.word}: ${content.hint}`;
    case "riddle":
      return `${content.riddle} ${content.answers.join(" / ")} (${content.hint})`;
    case "fastest":
      return content.word;
    default:
      return "";
  }
}
