import type { GameKind, GameStatus } from "@tik-live/shared";

/** One line on how viewers play each game, for pickers and hints. */
export const GAME_HOW: Record<GameKind, string> = {
  trivia: "A question with up to four options. Viewers type the letter.",
  poll: "Chat votes between two to four options. No winners, just opinions.",
  scramble: "Unscramble the word. The first viewer to type it wins.",
  number: "Guess the secret number. The stage narrows the range after each guess.",
  truefalse: "True or false? Viewers type T or F.",
  math: "Solve the sum. The first right answer wins.",
  riddle: "Answer the riddle. The first right answer wins.",
  fastest: "Type the word on screen. The fastest typer wins.",
};

/** What one entry from chat is called, per game: "12 votes", "3 guesses". */
export const ANSWER_WORD: Record<GameKind, [one: string, many: string]> = {
  trivia: ["answer", "answers"],
  poll: ["vote", "votes"],
  scramble: ["guess", "guesses"],
  number: ["guess", "guesses"],
  truefalse: ["answer", "answers"],
  math: ["answer", "answers"],
  riddle: ["guess", "guesses"],
  fastest: ["try", "tries"],
};

export const TOPIC_PLACEHOLDER = "Anything, or e.g. 90s cartoons";

/** "Round 2 of 5", or "Writing questions…" before the first one. */
export function gamePhase(game: GameStatus): string {
  switch (game.phase) {
    case "preparing":
      return "Writing questions…";
    case "open":
      return `Round ${game.round} of ${game.rounds}`;
    case "reveal":
      return "Revealing the answer";
    case "results":
      return "Final scores";
  }
}
