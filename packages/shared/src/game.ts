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
 */
export const GAME_KINDS = ["trivia", "poll", "scramble", "number", "truefalse", "math", "riddle", "fastest"] as const;
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
};

/** How a game is set up: by the creator in a segment, or from the studio. */
export const gameConfigSchema = z.object({
  kind: z.enum(GAME_KINDS),
  /** Rounds in one game. */
  rounds: z.number().int().min(1).max(10).default(5),
  /** Optional theme for the questions, e.g. "90s cartoons" or "Brazilian food". */
  topic: z.string().trim().max(80).optional(),
});
export type GameConfig = z.infer<typeof gameConfigSchema>;

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

/** The game as the studio sees it. */
export interface GameStatus {
  kind: GameKind;
  topic: string | null;
  /** "preparing": writing the questions; "results": showing the final scores. */
  phase: "preparing" | "open" | "reveal" | "results";
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
  /** Started by a segment (ends with it) or by the creator from the studio. */
  source: "segment" | "studio";
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
