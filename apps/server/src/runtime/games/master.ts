import {
  BOOST_DIAMONDS,
  BOOST_KINDS,
  BOOST_LABELS,
  GAME_LABELS,
  OPTION_LETTERS,
  viewerName,
  type BoostKind,
  type Effect,
  type GameConfig,
  type GameKind,
  type GameScene,
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
  contentKey,
  guessLanguage,
  makeMath,
  makeNumber,
  pickFromBank,
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
}

interface ActiveGame {
  config: GameConfig;
  source: "segment" | "studio";
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
};

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
  /** Rounds used this stream, so games don't repeat themselves. */
  private readonly used = new Set<string>();
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

  source(): "segment" | "studio" | null {
    return this.game?.source ?? null;
  }

  start(config: GameConfig, source: "segment" | "studio", chatSample: string[] = []): { ok: true } | { ok: false; error: string } {
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
    if (config.kind === "number" || config.kind === "math") {
      game.readyAt = now;
    } else {
      void this.prepare(game, config.kind, chatSample);
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
    }
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
        if (round && now - round.openedAt >= round.durationMs + (this.options.streamDelayMs ?? 0)) this.reveal(game, now);
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
      answers: round ? round.answers.size + round.guesses : 0,
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
      const answers = `${round.answers.size + round.guesses} answers so far`;
      lines.push(`On screen: ${promptOf(round)}`);
      lines.push(
        left > 0
          ? `Open for ${left} more seconds; ${answers}. Don't reveal or hint at the answer.`
          : `Time is up on screen; the last answers are still coming in (${answers}). Don't reveal or hint at the answer yet.`,
      );
    }
    if (round && game.phase === "reveal") lines.push(`Just revealed: ${promptOf(round)} Answer: ${answerOf(round.content) ?? "(a vote)"}.`);
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
            avoid: [...this.used].slice(-30).map((key) => key.slice(key.indexOf(":") + 1)),
          },
          prep.signal,
        );
        rounds = await this.vet(written.filter((round) => !this.used.has(contentKey(round))));
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
      const taken = new Set([...this.used, ...rounds.map(contentKey)]);
      rounds.push(...pickFromBank(language, kind, wanted - rounds.length, taken, this.random));
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

  private hasNextRound(game: ActiveGame): boolean {
    const kind = game.config.kind;
    return kind === "number" || kind === "math" || game.index < game.queue.length;
  }

  private openRound(game: ActiveGame): void {
    const now = this.now();
    const kind = game.config.kind;
    const content: RoundContent =
      kind === "number" ? makeNumber(this.random) : kind === "math" ? makeMath(game.index + 1, this.random) : (game.queue[game.index] as RoundContent);
    this.used.add(contentKey(content));
    const round: Round = {
      content,
      openedAt: now,
      durationMs: OPEN_MS[kind],
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
      closesAt: now + round.durationMs,
    });
    this.options.onChange?.();
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
    if (content.kind !== "poll") {
      this.sound(won ? "win" : "fail");
      if (won) this.options.stage.fx("confetti", 1);
    } else {
      this.sound("reveal");
    }
    // A power-up's thank-you is old news once the answer is out.
    this.cues = this.cues.filter((cue) => !(cue.boost && cue.round === game.index));
    // A round won before the host read it out: skip the question, go straight to the answer.
    const unread = this.cues.findIndex((cue) => cue.phase === "open" && cue.round === game.index && !cue.boost);
    if (unread !== -1) this.cues.splice(unread, 1);
    const early = unread !== -1 ? "The round ended before you could read it out, so don't read the question now. " : "";
    this.cues.push({
      note: `${early}Reveal for round ${game.index + 1} of ${game.config.rounds}. ${summary} Announce it with energy${won && content.kind !== "poll" ? " and congratulate the winner by name" : ""}${content.kind === "poll" ? " and give a playful take on the result" : ""}.`,
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

  /** An open round's cue goes stale once the round closes; the others after a while. */
  private dropStaleCues(): void {
    const game = this.game;
    const now = this.now();
    this.cues = this.cues.filter((cue) =>
      cue.phase === "open" ? game?.phase === "open" && game.index === cue.round : now - cue.at < CUE_TTL_MS,
    );
  }

  /** Applies a power-up to the round; false when it does nothing for this kind of game. */
  private applyBoost(round: Round, boost: BoostKind): boolean {
    const content = round.content;
    switch (boost) {
      case "time":
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
        title: `Placar final · ${GAME_LABELS[game.config.kind]}`.slice(0, 60),
        rows: this.leaderboard(game).slice(0, 5),
      };
    }
    const round = game.round;
    if (!round || game.phase === "preparing") return null;
    const revealed = game.phase === "reveal";
    const base = {
      round: game.index + 1,
      rounds: game.config.rounds,
      phase: revealed ? ("reveal" as const) : ("open" as const),
      remainingMs: revealed ? 0 : Math.max(0, round.openedAt + round.durationMs - now),
      durationMs: round.durationMs,
      ...(round.boosts.length ? { boosts: [...round.boosts] } : {}),
    };
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
          answer: revealed ? (content.answers[0] ?? "").slice(0, 40) : null,
          winner: round.winner?.name ?? null,
        };
      case "fastest":
        return { kind: "fastest", ...base, word: content.word.toUpperCase(), winner: round.winner?.name ?? null, winnerMs: round.winner?.ms ?? null };
    }
  }

  private sound(sound: Sound): void {
    if (this.options.sounds()) this.options.stage.sfx(sound);
  }

  private nameOf(viewer: Viewer): string {
    return displayName(viewer, this.options.blocklist()).slice(0, 24) || viewerName(viewer).slice(0, 24);
  }
}

/** Double points power-up. */
function multiplier(round: Round): number {
  return round.boosts.includes("double") ? 2 : 1;
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
