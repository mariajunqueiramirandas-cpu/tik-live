import { clip, type Challenge, type ChallengeKind } from "@tik-live/shared";
import { normalize } from "./games/answers";

/**
 * Short challenges for the whole room (ADR-0040), the moments that make a
 * LIVE's numbers jump: tap likes to a target before the clock runs out,
 * flood the chat with a word, or enter a free raffle by typing EU. Nothing
 * here costs a viewer anything; the raffle's prize is a moment on stream.
 */

export interface ChallengeSetup {
  kind: ChallengeKind;
  /** Likes or messages to reach; ignored for a raffle. */
  target: number;
  durationMs: number;
  /** The word chat types: the comment rush's, or EU for the raffle. */
  word: string;
}

interface Running extends ChallengeSetup {
  value: number;
  startedAt: number;
  entrants: Map<string, string>;
  lastAt: Map<string, number>;
  result: "won" | "lost" | null;
  winner: { id: string; name: string } | null;
  endedAt: number;
}

/** In a comment rush, one viewer counts at most once this often. */
export const RUSH_MESSAGE_MS = 1_500;
/** After it ends, the result stays up this long. */
export const RESULT_MS = 6_000;

const TITLES: Record<ChallengeKind, string> = {
  likes: "DESAFIO DAS CURTIDAS",
  chat: "CHUVA DE COMENTÁRIOS",
  raffle: "SORTEIO RELÂMPAGO",
};

/** "EU", "eu!", "euuu", "eu quero": entering the raffle; "LIVE", "live live": the rush's word. */
export function saysWord(text: string, word: string): boolean {
  const plain = normalize(text).replace(/(\p{L})\1+/gu, "$1");
  const target = normalize(word).replace(/(\p{L})\1+/gu, "$1");
  if (!plain || !target) return false;
  const words = plain.split(" ");
  return words.length <= 4 && words[0] === target;
}

/** Rounds a target to a number that reads well on stage: 50, 120, 1.500. */
export function niceTarget(n: number): number {
  if (n <= 100) return Math.max(10, Math.ceil(n / 10) * 10);
  if (n <= 1_000) return Math.ceil(n / 50) * 50;
  if (n <= 10_000) return Math.ceil(n / 500) * 500;
  return Math.ceil(n / 5_000) * 5_000;
}

export class RoomChallenge {
  private current: Running | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  start(setup: ChallengeSetup, now: number): void {
    this.current = { ...setup, value: 0, startedAt: now, entrants: new Map(), lastAt: new Map(), result: null, winner: null, endedAt: 0 };
  }

  /** Taking part right now (the clock is running). */
  running(): boolean {
    return this.current !== null && this.current.result === null;
  }

  /** On stage at all (running, or showing how it ended). */
  shown(): boolean {
    return this.current !== null;
  }

  kind(): ChallengeKind | null {
    return this.current?.kind ?? null;
  }

  word(): string | null {
    return this.current?.word ?? null;
  }

  stop(): void {
    this.current = null;
  }

  /** Likes count toward a like challenge. */
  like(count: number): boolean {
    const c = this.current;
    if (!c || c.result !== null || c.kind !== "likes") return false;
    c.value += count;
    return true;
  }

  /** Reads a chat message: true when the challenge took it (so it isn't queued for the host). */
  chat(viewerId: string, name: string, text: string, now: number): boolean {
    const c = this.current;
    if (!c || c.result !== null || c.kind === "likes" || !saysWord(text, c.word)) return false;
    if (c.kind === "raffle") {
      if (!c.entrants.has(viewerId)) {
        c.entrants.set(viewerId, name);
        c.value = c.entrants.size;
      }
      return true;
    }
    const last = c.lastAt.get(viewerId) ?? -Infinity;
    if (now - last >= RUSH_MESSAGE_MS) {
      c.lastAt.set(viewerId, now);
      c.entrants.set(viewerId, name);
      c.value += 1;
    }
    return true;
  }

  /**
   * Moves time on. Returns the challenge once, the moment it ends (the
   * target reached, or the clock out), and drops it once its result has
   * been up long enough.
   */
  tick(now: number): { kind: ChallengeKind; result: "won" | "lost"; value: number; target: number; players: number; winner: { id: string; name: string } | null } | null {
    const c = this.current;
    if (!c) return null;
    if (c.result !== null) {
      if (now - c.endedAt >= RESULT_MS) this.current = null;
      return null;
    }
    const reached = c.kind !== "raffle" && c.value >= c.target;
    if (!reached && now - c.startedAt < c.durationMs) return null;
    c.endedAt = now;
    if (c.kind === "raffle") {
      const entrants = [...c.entrants.entries()];
      const pick = entrants[Math.floor(this.random() * entrants.length)];
      c.winner = pick ? { id: pick[0], name: pick[1] } : null;
      c.result = c.winner ? "won" : "lost";
    } else c.result = reached ? "won" : "lost";
    return { kind: c.kind, result: c.result, value: c.value, target: c.target, players: c.entrants.size, winner: c.winner };
  }

  /** What the stage shows; times are relative to now. */
  view(now: number): Challenge | null {
    const c = this.current;
    if (!c) return null;
    const detail = c.kind === "likes" ? "toque na tela sem parar" : c.kind === "raffle" ? `digite ${c.word} pra participar` : `digite ${c.word} no chat`;
    return {
      kind: c.kind,
      title: TITLES[c.kind],
      detail: clip(detail, 60),
      value: c.value,
      target: c.kind === "raffle" ? 0 : c.target,
      remainingMs: c.result === null ? Math.max(0, c.startedAt + c.durationMs - now) : 0,
      durationMs: c.durationMs,
      result: c.result,
      winner: c.winner ? clip(c.winner.name, 40) : null,
    };
  }

  /** The challenge as the host may see it. */
  describe(now: number): string | undefined {
    const c = this.current;
    if (!c || c.result !== null) return undefined;
    const left = Math.max(0, Math.ceil((c.startedAt + c.durationMs - now) / 1000));
    switch (c.kind) {
      case "likes":
        return `Like challenge on screen: ${c.value} of ${c.target} likes, ${left} s left. Chat taps the screen to like.`;
      case "chat":
        return `Comment rush on screen: ${c.value} of ${c.target} messages with "${c.word}", ${left} s left.`;
      case "raffle":
        return `Raffle on screen: ${c.entrants.size} entered by typing ${c.word}, ${left} s left. The winner is drawn at random; entering is free.`;
    }
  }
}
