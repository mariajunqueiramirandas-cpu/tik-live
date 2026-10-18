import { GAME_LABELS, type GameKind } from "@tik-live/shared";
import { normalize } from "./answers";

/** Games chat can pick for the loop's last segment (a poll has no winners, so it's not one). */
export const VOTABLE: readonly GameKind[] = ["trivia", "race", "riddle", "potato", "fastest", "wheel", "scramble", "tug", "truefalse", "math", "number"];
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

/** Party games: a viewer's own pick always offers one of them (ADR-0039). */
const PARTY: readonly GameKind[] = ["race", "wheel", "tug", "potato"];

/** Three different games for a viewer to pick from, one of them a party game, never the one that just played. */
export function pickOptions(random: () => number, exclude?: GameKind): GameKind[] {
  const pool = VOTABLE.filter((kind) => kind !== exclude);
  const party = PARTY.filter((kind) => kind !== exclude);
  const first = party[Math.floor(random() * party.length)] as GameKind;
  const rest = pool.filter((kind) => kind !== first);
  const out = [first];
  while (out.length < VOTE_OPTIONS && rest.length) out.push(rest.splice(Math.floor(random() * rest.length), 1)[0] as GameKind);
  // The party game isn't always first.
  return out.sort(() => random() - 0.5);
}

/**
 * One viewer picks the next game (ADR-0039): a gift power, or the raffle's
 * prize. Only their message counts, by number or by the game's name.
 */
export class SoloPick {
  choice: GameKind | null = null;

  constructor(
    readonly viewerId: string,
    readonly name: string,
    readonly options: readonly GameKind[],
    readonly reason: "gift" | "raffle",
  ) {}

  get labels(): string[] {
    return this.options.map((kind) => GAME_LABELS[kind]);
  }

  /** Their choice, if this is it. True when the message was their pick (so it isn't queued for the host). */
  cast(viewerId: string, text: string): boolean {
    if (viewerId !== this.viewerId || this.choice) return false;
    const index = readBallot(text, this.labels);
    if (index === undefined) return false;
    this.choice = this.options[index] ?? null;
    return true;
  }
}
