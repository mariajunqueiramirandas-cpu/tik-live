import { GAME_LABELS, type GameKind } from "@tik-live/shared";
import { normalize } from "./answers";

/** Games chat can pick for the loop's last segment (a poll has no winners, so it's not one). */
export const VOTABLE: readonly GameKind[] = ["trivia", "riddle", "fastest", "scramble", "truefalse", "math", "number"];
export const VOTE_OPTIONS = 3;

/** "2", "#2", "2!", or the option's name ("charadas"); undefined for anything else. */
export function readBallot(text: string, labels: readonly string[]): number | undefined {
  const digit = /^#?\s*([1-9])\s*!*$/.exec(text.trim());
  if (digit) {
    const index = Number(digit[1]) - 1;
    return index < labels.length ? index : undefined;
  }
  const said = normalize(text);
  if (!said) return undefined;
  const index = labels.findIndex((label) => normalize(label) === said);
  return index === -1 ? undefined : index;
}

/** The options for a loop: a different trio of games each loop, in a fixed rotation. */
export function voteOptions(loop: number): GameKind[] {
  const out: GameKind[] = [];
  for (let i = 0; i < VOTE_OPTIONS; i++) out.push(VOTABLE[(loop * VOTE_OPTIONS + i) % VOTABLE.length] as GameKind);
  return out;
}

/**
 * Chat picks the minigame the loop's last segment plays (ADR-0029). One
 * ballot per viewer (the first counts), read from a number or the game's
 * name; a game round's own answers are the game's first.
 */
export class FinalVote {
  private readonly ballots = new Map<string, number>();
  private readonly counts: number[];

  constructor(readonly options: readonly GameKind[]) {
    this.counts = options.map(() => 0);
  }

  get labels(): string[] {
    return this.options.map((kind) => GAME_LABELS[kind]);
  }

  /** Counts a chat message as a ballot. True when it was one (so it isn't queued for the host). */
  cast(viewerId: string, text: string): boolean {
    const choice = readBallot(text, this.labels);
    if (choice === undefined) return false;
    if (!this.ballots.has(viewerId)) {
      this.ballots.set(viewerId, choice);
      this.counts[choice] = (this.counts[choice] ?? 0) + 1;
    }
    return true;
  }

  tally(): number[] {
    return [...this.counts];
  }

  total(): number {
    return this.ballots.size;
  }

  /** The most-voted game (a tie goes to the first listed), or null when nobody voted. */
  winner(): GameKind | null {
    if (this.ballots.size === 0) return null;
    const best = Math.max(...this.counts);
    return this.options[this.counts.indexOf(best)] ?? null;
  }
}
