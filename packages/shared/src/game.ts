import { z } from "zod";
import "./zod-pt-br";

/**
 * Chat minigames (ADR-0023). The host runs a game, viewers answer in chat,
 * and the stage switches to that game's scene.
 *
 * - trivia: a question with up to four options; type the letter.
 * - poll: "this or that" with two to four options; type the letter. No winners.
 * - scramble: unscramble the word; the first to type it wins.
 * - number: guess the secret number; the stage narrows the range after each guess.
 * - truefalse: is the statement true or false? Type T or F (V or F works too).
 * - math: solve the sum; the first right answer wins.
 * - riddle: answer the riddle; the first right answer wins.
 * - fastest: type the word on screen; the fastest typer wins.
 *
 * Games of chance and parties (ADR-0038), made up in code:
 * - race: bet on a racer (type its number); the long shots pay the most.
 * - wheel: bet on a color (type its number); the strip spins and stops on one.
 * - tug: join a team (type 1 or 2); likes, "puxa" and gifts pull the rope.
 * - potato: type "pega" to grab the hot potato; points for every second you
 *   hold it, and whoever holds it when it blows up loses them all.
 */
export const GAME_KINDS = ["trivia", "poll", "scramble", "number", "truefalse", "math", "riddle", "fastest", "race", "wheel", "tug", "potato"] as const;
export type GameKind = (typeof GAME_KINDS)[number];

export const GAME_LABELS: Record<GameKind, string> = {
  trivia: "Quiz",
  poll: "Isso ou aquilo",
  scramble: "Palavra embaralhada",
  number: "Adivinhe o número",
  truefalse: "Verdadeiro ou falso",
  math: "Conta rápida",
  riddle: "Charadas",
  fastest: "Dedo mais rápido",
  race: "Corrida maluca",
  wheel: "Roleta da sorte",
  tug: "Cabo de guerra",
  potato: "Batata quente",
};

/** Games made up in code on the spot: no questions to write, nothing to moderate. */
export const GENERATED_KINDS = ["number", "math", "race", "wheel", "tug", "potato"] as const satisfies readonly GameKind[];
export type GeneratedKind = (typeof GENERATED_KINDS)[number];

/** How a game is set up: by the creator in a segment, or from the studio. */
export const gameConfigSchema = z.object({
  kind: z.enum(GAME_KINDS),
  /** Rounds in one game. */
  rounds: z.number().int().min(1).max(10).default(5),
  /** Optional theme for the questions, e.g. "90s cartoons" or "Brazilian food". */
  topic: z.string().trim().max(80).optional(),
});
export type GameConfig = z.infer<typeof gameConfigSchema>;

/** A segment's game. "random" draws one of the kinds each time the segment comes around (each loop). */
export const segmentGameSchema = gameConfigSchema.extend({
  kind: z.enum([...GAME_KINDS, "random"] as const),
});
export type SegmentGame = z.infer<typeof segmentGameSchema>;

/**
 * Gift power-ups (ADR-0029): gifts during an open round add up, and each
 * threshold unlocks a boost for everyone playing, never for the gifter
 * alone: more time, a hint (a 50/50 in a quiz), double points.
 */
export const BOOST_KINDS = ["time", "hint", "double"] as const;
export type BoostKind = (typeof BOOST_KINDS)[number];
/** Diamonds sent during one round that unlock each boost. */
export const BOOST_DIAMONDS: Record<BoostKind, number> = { time: 10, hint: 50, double: 100 };
export const BOOST_LABELS: Record<BoostKind, string> = { time: "+10 segundos", hint: "Dica liberada", double: "Pontos em dobro" };

/** Letters viewers type to pick an option. */
export const OPTION_LETTERS = ["A", "B", "C", "D"] as const;

const name = z.string().max(40);
const round = {
  round: z.number().int().min(1),
  rounds: z.number().int().min(1),
  /** "open": viewers are answering; "reveal": the answer is on screen. */
  phase: z.enum(["open", "reveal"]),
  /** Time left to answer when the message was sent (0 once revealed). */
  remainingMs: z.number().min(0),
  /** How long the round was open for in total (draws the timer bar). */
  durationMs: z.number().min(0),
  /** Power-ups gifts unlocked for this round. */
  boosts: z.array(z.enum(BOOST_KINDS)).max(3).optional(),
};

/**
 * Where a betting round is (ADR-0038): chat is betting, the race is on (or
 * the strip spins), or it's over. The round's phase is "open" while chat
 * bets and "reveal" from the start.
 */
export const BET_STAGES = ["bets", "running", "finish"] as const;
export type BetStage = (typeof BET_STAGES)[number];

/** What the stage draws for a game. Each kind has its own scene. */
export const gameSceneSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("trivia"),
    ...round,
    question: z.string().max(200),
    options: z.array(z.string().max(80)).min(2).max(4),
    /** How many viewers answered so far. */
    answers: z.number().int().min(0),
    /** Answers per option; only sent at the reveal so the crowd doesn't give it away. */
    tally: z.array(z.number().int().min(0)).nullable(),
    correct: z.number().int().min(0).max(3).nullable(),
    /** Who got it right, fastest first. */
    winners: z.array(name).max(5),
    /** Wrong options a 50/50 power-up took away. */
    removed: z.array(z.number().int().min(0).max(3)).max(2).optional(),
  }),
  z.object({
    kind: z.literal("poll"),
    ...round,
    question: z.string().max(200),
    options: z.array(z.string().max(80)).min(2).max(4),
    /** Live votes per option. */
    tally: z.array(z.number().int().min(0)),
  }),
  z.object({
    kind: z.literal("scramble"),
    ...round,
    /** The shuffled letters, uppercase. */
    letters: z.string().max(24),
    /** Shown from halfway through the round. */
    hint: z.string().max(80).nullable(),
    guesses: z.number().int().min(0),
    /** The word, at the reveal. */
    word: z.string().max(24).nullable(),
    winner: name.nullable(),
  }),
  z.object({
    kind: z.literal("number"),
    ...round,
    min: z.number().int(),
    max: z.number().int(),
    /** The range the secret is known to be in, narrowed by guesses. */
    low: z.number().int(),
    high: z.number().int(),
    guesses: z.number().int().min(0),
    last: z.object({ name, value: z.number().int(), hint: z.enum(["higher", "lower", "exact"]) }).nullable(),
    answer: z.number().int().nullable(),
    winner: name.nullable(),
  }),
  z.object({
    kind: z.literal("truefalse"),
    ...round,
    statement: z.string().max(200),
    answers: z.number().int().min(0),
    /** [true votes, false votes], only at the reveal. */
    tally: z.tuple([z.number().int().min(0), z.number().int().min(0)]).nullable(),
    correct: z.boolean().nullable(),
    winners: z.array(name).max(5),
  }),
  z.object({
    kind: z.literal("math"),
    ...round,
    /** As shown, e.g. "7 × 8 + 3". */
    expression: z.string().max(40),
    guesses: z.number().int().min(0),
    answer: z.number().int().nullable(),
    winner: name.nullable(),
  }),
  z.object({
    kind: z.literal("riddle"),
    ...round,
    riddle: z.string().max(220),
    hint: z.string().max(80).nullable(),
    guesses: z.number().int().min(0),
    answer: z.string().max(40).nullable(),
    winner: name.nullable(),
  }),
  z.object({
    kind: z.literal("fastest"),
    ...round,
    /** The word to type, uppercase. */
    word: z.string().max(24),
    winner: name.nullable(),
    /** How long the winner took, from the word appearing. */
    winnerMs: z.number().int().min(0).nullable(),
  }),
  /**
   * A race chat bets on: five racers, each with the multiplier it pays.
   * Progress goes from 0 at the start to 1 at the finish line; the server
   * sends it a few times a second while the race runs.
   */
  z.object({
    kind: z.literal("race"),
    ...round,
    stage: z.enum(BET_STAGES),
    racers: z
      .array(
        z.object({
          name: z.string().max(20),
          /** What a right bet pays: points are three times this. */
          odds: z.number().int().min(2).max(50),
          /** Bets on this racer so far. */
          bets: z.number().int().min(0),
          progress: z.number().min(0).max(1),
        }),
      )
      .min(2)
      .max(5),
    bets: z.number().int().min(0),
    /** The racer that won, at the finish. */
    winner: z.number().int().min(0).max(4).nullable(),
    /** Who bet on the winner, first bets first. */
    winners: z.array(name).max(5),
    /** The latest moment in the race ("Faísca assumiu a ponta!"), while it runs. */
    event: z.string().max(60).nullable(),
  }),
  /**
   * A strip of colored tiles that spins under a pointer (ADR-0038). Chat bets
   * on a color; rarer colors pay more. From the spin on, `landing` is the
   * tile it stops on and `spinLeftMs` how long the spin has left, relative
   * to receipt, so the stage animates it on its own.
   */
  z.object({
    kind: z.literal("wheel"),
    ...round,
    stage: z.enum(BET_STAGES),
    sectors: z
      .array(
        z.object({
          label: z.string().max(20),
          /** What a right bet pays: points are four times this. */
          odds: z.number().int().min(2).max(100),
          bets: z.number().int().min(0),
        }),
      )
      .min(2)
      .max(4),
    /** The strip's tiles, as sector indexes, in order (it repeats around). */
    strip: z.array(z.number().int().min(0).max(3)).min(4).max(24),
    /** The tile (index into `strip`) the spin stops on; null while chat bets. */
    landing: z.number().int().min(0).max(23).nullable(),
    spinMs: z.number().min(0),
    spinLeftMs: z.number().min(0),
    bets: z.number().int().min(0),
    /** The sector it stopped on, at the finish. */
    result: z.number().int().min(0).max(3).nullable(),
    winners: z.array(name).max(5),
  }),
  /**
   * Tug of war (ADR-0038): two teams, a rope between them. `rope` goes from
   * -1 (team 1 pulled it all the way) to 1 (team 2).
   */
  z.object({
    kind: z.literal("tug"),
    ...round,
    teams: z
      .array(
        z.object({
          name: z.string().max(24),
          members: z.number().int().min(0),
          pulls: z.number().int().min(0),
        }),
      )
      .length(2),
    rope: z.number().min(-1).max(1),
    /** The team that won, at the reveal; null before it and on a tie. */
    winner: z.number().int().min(0).max(1).nullable(),
    /** Who pulled the most for the winning team. */
    mvp: name.nullable(),
  }),
  /**
   * Hot potato (ADR-0038): the fuse is secret, so `durationMs` is 0 and the
   * board shows no timer, only how hot it's getting.
   */
  z.object({
    kind: z.literal("potato"),
    ...round,
    holder: name.nullable(),
    /** How long the holder has had it, when the message was sent. */
    heldMs: z.number().min(0),
    /** 0 to 1: time since the round opened over the longest fuse there is (never the real one). */
    heat: z.number().min(0).max(1),
    grabs: z.number().int().min(0),
    /** Seconds held so far, most first. */
    leaders: z.array(z.object({ name, seconds: z.number().int().min(0) })).max(3),
    /** At the reveal: who held it when it blew up, and the points that cost them. */
    exploded: z.object({ name, lost: z.number().int().min(0) }).nullable(),
  }),
  z.object({
    kind: z.literal("scoreboard"),
    title: z.string().max(60),
    rows: z.array(z.object({ name, points: z.number().int().min(0) })).max(5),
  }),
  /**
   * The loop's top three, revealed one place at a time (third, second, then
   * first) once every segment in the run of show has played.
   */
  z.object({
    kind: z.literal("podium"),
    title: z.string().max(60),
    /** First, second and third place; null while that place is still hidden. Shorter when fewer people scored. */
    places: z.array(z.object({ name, points: z.number().int().min(0) }).nullable()).min(1).max(3),
    /** The place (1 to 3) the drumroll is building up to, or null between reveals and at the end. */
    suspense: z.number().int().min(1).max(3).nullable(),
  }),
]);
export type GameScene = z.infer<typeof gameSceneSchema>;
export type GameSceneKind = GameScene["kind"];

export const GAME_SOURCES = ["segment", "studio", "pick"] as const;
export type GameSource = (typeof GAME_SOURCES)[number];

/** The game as the studio sees it. */
export interface GameStatus {
  kind: GameKind;
  topic: string | null;
  /** "preparing": writing the questions; "running": a race or a spin is on (bets are closed); "results": showing the final scores. */
  phase: "preparing" | "open" | "running" | "reveal" | "results";
  round: number;
  rounds: number;
  /** The current question or prompt, as shown on stage. */
  prompt: string;
  /** For the creator only: the answer to the open round. */
  answer: string | null;
  remainingSec: number;
  answers: number;
  /** Power-ups gifts unlocked for the round on screen. */
  boosts: BoostKind[];
  leaderboard: Array<{ name: string; points: number }>;
  /** Started by a segment (ends with it), by the creator from the studio, or picked by a viewer (a gift or the raffle, ADR-0039). */
  source: GameSource;
}

/** Points across every game in one loop of the run of show (all segments), reset once its podium is revealed. */
export interface LoopRankingStatus {
  /** Everyone who scored this loop, best first (top 10). */
  rows: Array<{ name: string; points: number }>;
  /** Games that finished this loop. */
  games: number;
  /** The top three are being revealed on stage right now. */
  revealing: boolean;
}
