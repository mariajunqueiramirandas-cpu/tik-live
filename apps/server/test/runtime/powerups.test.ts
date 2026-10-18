import { describe, expect, it } from "bun:test";
import type { BoostKind, GameScene, LiveEvent } from "@tik-live/shared";
import { GameMaster } from "../../src/runtime/games/master";
import type { RoundContent } from "../../src/runtime/games/content";
import type { GameWriter } from "../../src/runtime/games/writer";
import { fakeClock, viewer } from "./helpers";

function gift(handle: string, diamonds: number): Extract<LiveEvent, { kind: "gift" }> {
  return { kind: "gift", at: 0, viewer: viewer(handle), giftName: "Rose", count: 1, diamonds };
}

const trivia: RoundContent = { kind: "trivia", question: "Which planet is the largest?", options: ["Saturn", "Jupiter", "Neptune", "Earth"], correct: 1 };

function setup(rounds: RoundContent[] = [trivia]) {
  const clock = fakeClock();
  const scenes: Array<GameScene | null> = [];
  const boosts: Array<{ boost: BoostKind; by: string }> = [];
  const writer: GameWriter = { name: "fake", write: async () => rounds };
  const games = new GameMaster({
    writer,
    gate: { check: async () => ({ safe: true }) },
    stage: { game: (scene) => scenes.push(scene), fx: () => {}, sfx: () => {}, boost: (boost, by) => boosts.push({ boost, by }) },
    blocklist: () => [],
    language: () => "en",
    sounds: () => false,
    now: clock.now,
    random: () => 0.5,
  });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  const last = () => scenes.at(-1);
  return { clock, games, scenes, boosts, flush, last };
}

describe("gift power-ups (ADR-0029)", () => {
  it("adds gifts up during a round and unlocks boosts for everyone at each threshold", async () => {
    const { games, boosts, flush, last } = setup();
    games.start({ kind: "trivia", rounds: 1 }, "studio");
    await flush();
    expect(last()).toMatchObject({ kind: "trivia", phase: "open", durationMs: 25_000 });
    expect(games.handleGift(gift("ana", 5))).toEqual([]);
    expect(games.handleGift(gift("bia", 5))).toEqual(["time"]);
    expect(last()).toMatchObject({ durationMs: 35_000, boosts: ["time"] });
    expect(games.handleGift(gift("caio", 40))).toEqual(["hint"]);
    const scene = last();
    if (scene?.kind !== "trivia") throw new Error("expected trivia");
    // A 50/50: two wrong options gone, never the right one.
    expect(scene.removed).toHaveLength(2);
    expect(scene.removed).not.toContain(1);
    expect(games.handleGift(gift("duda", 100))).toEqual(["double"]);
    expect(games.status()?.boosts).toEqual(["time", "hint", "double"]);
    expect(boosts.map((b) => `${b.boost}:${b.by}`)).toEqual(["time:bia", "hint:caio", "double:duda"]);
    // Each one is thanked by name, without the answer.
    const cues = [games.takeCue(), games.takeCue(), games.takeCue(), games.takeCue()].filter(Boolean);
    expect(cues.some((cue) => cue?.note.includes("bia's gift"))).toBe(true);
    for (const cue of cues) if (cue?.note.includes("gift")) expect(cue.note).not.toContain("Jupiter");
  });

  it("doubles the points for everyone who gets the round right, not for the gifter", async () => {
    const { games, flush, clock } = setup();
    games.start({ kind: "trivia", rounds: 1 }, "studio");
    await flush();
    games.handleGift(gift("rich", 1_000));
    games.handleChat({ kind: "chat", at: 0, viewer: viewer("ana"), text: "B" });
    games.handleChat({ kind: "chat", at: 0, viewer: viewer("rich"), text: "A" });
    clock.advance(36_000);
    games.tick(true);
    expect(games.status()?.leaderboard).toEqual([{ name: "ana", points: 30 }]);
  });

  it("ignores gifts outside an open round, and boosts that don't fit the game", async () => {
    const { games, flush } = setup([{ kind: "fastest", word: "PARALELEPIPEDO" } as RoundContent]);
    expect(games.handleGift(gift("ana", 500))).toEqual([]);
    games.start({ kind: "fastest", rounds: 1 }, "studio");
    await flush();
    // No hint in a typing race: time and double points only.
    expect(games.handleGift(gift("ana", 500))).toEqual(["time", "double"]);
  });

  it("narrows the number game's window around the secret", () => {
    const { games, last } = setup();
    games.start({ kind: "number", rounds: 1 }, "studio");
    const before = last();
    if (before?.kind !== "number") throw new Error("expected number");
    games.handleGift(gift("ana", 50));
    const after = last();
    if (after?.kind !== "number") throw new Error("expected number");
    const secret = Number(games.status()?.answer);
    expect(after.high - after.low).toBeLessThan(before.high - before.low);
    expect(secret).toBeGreaterThanOrEqual(after.low);
    expect(secret).toBeLessThanOrEqual(after.high);
  });
});
