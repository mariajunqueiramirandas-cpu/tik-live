import { describe, expect, it } from "bun:test";
import type { GameScene, Sound } from "@tik-live/shared";
import { GameMaster } from "../../src/runtime/games/master";
import { LoopRanking } from "../../src/runtime/games/ranking";
import { fakeClock, viewer } from "./helpers";

function setup() {
  const clock = fakeClock();
  const scenes: Array<GameScene | null> = [];
  const sounds: Sound[] = [];
  const fx: string[] = [];
  const stage = { game: (scene: GameScene | null) => scenes.push(scene), fx: (name: string) => fx.push(name), sfx: (sound: Sound) => sounds.push(sound) };
  const ranking = new LoopRanking({ stage, sounds: () => true, now: clock.now });
  const podiums = () => scenes.filter((scene): scene is Extract<GameScene, { kind: "podium" }> => scene?.kind === "podium");
  /** Ticks with the host idle until the reveal moves on, taking cues as the host would. */
  const step = () => {
    const before = scenes.length;
    for (let i = 0; i < 400 && scenes.length === before; i++) {
      ranking.takeCue();
      clock.advance(250);
      ranking.tick(true);
    }
  };
  return { clock, ranking, scenes, podiums, sounds, fx, stage, step };
}

describe("LoopRanking", () => {
  it("adds up points from every game in the loop", () => {
    const { ranking } = setup();
    ranking.add("a", "ana", 15);
    ranking.add("b", "bia", 20);
    ranking.add("a", "ana", 10);
    ranking.gameFinished();
    expect(ranking.status()).toEqual({
      rows: [
        { name: "ana", points: 25 },
        { name: "bia", points: 20 },
      ],
      games: 1,
      revealing: false,
    });
  });

  it("breaks ties by who got there first", () => {
    const { ranking, clock } = setup();
    ranking.add("b", "bia", 10);
    clock.advance(1_000);
    ranking.add("a", "ana", 10);
    expect(ranking.rows().map((row) => row.name)).toEqual(["bia", "ana"]);
  });

  it("reveals third, then second, then first, each after a drumroll, then starts over", () => {
    const { ranking, podiums, sounds, fx, step, scenes } = setup();
    ranking.add("a", "ana", 50);
    ranking.add("b", "bia", 30);
    ranking.add("c", "caio", 20);
    ranking.add("d", "duda", 5);
    expect(ranking.startReveal()).toBe(true);
    expect(ranking.isRevealing()).toBe(true);
    const opening = ranking.takeCue();
    expect(opening?.note).toContain("third place");
    expect(opening?.note).not.toContain("ana");
    expect(podiums().at(-1)).toEqual({ kind: "podium", title: "Pódio geral", places: [null, null, null], suspense: 3 });
    expect(sounds).toEqual(["drumroll"]);

    // Third place, with only what's on screen in the host's context.
    step();
    expect(podiums().at(-1)?.places).toEqual([null, null, { name: "caio", points: 20 }]);
    expect(podiums().at(-1)?.suspense).toBeNull();
    expect(ranking.hostContext()).toContain("caio");
    expect(ranking.hostContext()).not.toContain("ana");

    step();
    expect(podiums().at(-1)?.suspense).toBe(2);
    step();
    expect(podiums().at(-1)?.places).toEqual([null, { name: "bia", points: 30 }, { name: "caio", points: 20 }]);
    step();
    expect(podiums().at(-1)?.suspense).toBe(1);
    expect(ranking.hostContext()).not.toContain("ana");
    step();
    expect(podiums().at(-1)?.places[0]).toEqual({ name: "ana", points: 50 });
    expect(sounds.filter((s) => s === "drumroll")).toHaveLength(3);
    expect(sounds).toContain("fanfare");
    expect(fx).toContain("fireworks");

    // The celebration, then back to the show with a fresh ranking.
    step();
    step();
    expect(scenes.at(-1)).toBeNull();
    expect(ranking.isRevealing()).toBe(false);
    expect(ranking.status()).toEqual({ rows: [], games: 0, revealing: false });
  });

  it("waits for the host to finish before showing the next place", () => {
    const { ranking, podiums, clock } = setup();
    ranking.add("a", "ana", 10);
    ranking.add("b", "bia", 5);
    ranking.startReveal();
    ranking.takeCue();
    clock.advance(10_000);
    ranking.tick(false);
    expect(podiums().at(-1)?.places).toEqual([null, null]);
    ranking.tick(true);
    expect(podiums().at(-1)?.places).toEqual([null, { name: "bia", points: 5 }]);
  });

  it("reveals only as many places as people scored", () => {
    const { ranking, podiums, step } = setup();
    ranking.add("a", "ana", 10);
    ranking.startReveal();
    expect(podiums().at(-1)).toMatchObject({ places: [null], suspense: 1 });
    step();
    expect(podiums().at(-1)?.places).toEqual([{ name: "ana", points: 10 }]);
  });

  it("skips the podium when nobody scored", () => {
    const { ranking, scenes } = setup();
    ranking.gameFinished();
    expect(ranking.startReveal()).toBe(false);
    expect(scenes).toEqual([]);
    expect(ranking.status().games).toBe(0);
  });

  it("gets every point from the game master, and holds new games during the reveal", async () => {
    const { ranking, stage, clock } = setup();
    const games = new GameMaster({
      writer: null,
      gate: { check: async () => ({ safe: true }) },
      stage,
      blocklist: () => [],
      language: () => "en",
      sounds: () => false,
      ranking,
      now: clock.now,
    });
    expect(games.start({ kind: "math", rounds: 1 }, "studio")).toEqual({ ok: true });
    const status = games.status();
    const answer = Number(status?.answer);
    games.handleChat({ kind: "chat", at: 0, viewer: viewer("ana"), text: String(answer) });
    expect(ranking.rows()).toEqual([{ name: "ana", points: 15 }]);
    expect(games.hostContext()).toContain("Ranking across every game this loop");
    for (let i = 0; i < 200 && games.isActive(); i++) {
      games.takeCue();
      clock.advance(500);
      games.tick(true);
    }
    expect(ranking.status().games).toBe(1);

    ranking.startReveal();
    expect(games.start({ kind: "math", rounds: 1 }, "studio").ok).toBe(false);
    ranking.stop();
    expect(ranking.isRevealing()).toBe(false);
    expect(ranking.rows()).toEqual([]);
  });
});
