import { describe, expect, it } from "bun:test";
import type { GameScene, LiveEvent } from "@tik-live/shared";
import {
  FUSE_MAX_MS,
  FUSE_MIN_MS,
  makePotato,
  makeTug,
  readGrab,
  readPick,
  readPull,
  ropePosition,
} from "../../src/runtime/games/chance";
import { GameMaster } from "../../src/runtime/games/master";
import { LoopRanking } from "../../src/runtime/games/ranking";
import { fakeClock, viewer } from "./helpers";

function say(handle: string, text: string): Extract<LiveEvent, { kind: "chat" }> {
  return { kind: "chat", at: 0, viewer: viewer(handle), text };
}

function like(handle: string, count: number): Extract<LiveEvent, { kind: "like" }> {
  return { kind: "like", at: 0, viewer: viewer(handle), count };
}

function gift(handle: string, diamonds: number): Extract<LiveEvent, { kind: "gift" }> {
  return { kind: "gift", at: 0, viewer: viewer(handle), giftName: "Rosa", count: 1, diamonds };
}

function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function setup(seed = 7, streamDelayMs = 0) {
  const clock = fakeClock();
  const scenes: Array<GameScene | null> = [];
  const fx: string[] = [];
  const ranking = new LoopRanking({ stage: { game: () => {}, fx: () => {}, sfx: () => {} }, sounds: () => false, now: clock.now });
  const games = new GameMaster({
    writer: null,
    gate: { check: async () => ({ safe: true }) },
    stage: { game: (scene) => scenes.push(scene), fx: (name) => fx.push(name), sfx: () => {} },
    blocklist: () => [],
    language: () => "pt-BR",
    sounds: () => true,
    ranking,
    streamDelayMs,
    now: clock.now,
    random: seeded(seed),
  });
  const last = <K extends GameScene["kind"]>(kind: K): Extract<GameScene, { kind: K }> => {
    const scene = scenes.at(-1);
    if (scene?.kind !== kind) throw new Error(`expected a ${kind} scene, got ${scene?.kind ?? "none"}`);
    return scene as Extract<GameScene, { kind: K }>;
  };
  return { clock, games, scenes, fx, ranking, last };
}

describe("reading picks, grabs and pulls", () => {
  it("reads a pick by number or name, and leaves chat alone", () => {
    const options = ["Pão de queijo", "Pão de batata", "Café", "Chá", "Açaí"];
    expect(readPick("3", options)).toBe(2);
    expect(readPick("#2", options)).toBe(1);
    expect(readPick("voto no 5", options)).toBe(4);
    expect(readPick("acai", options)).toBe(4);
    expect(readPick("Pão de queijo!", options)).toBe(0);
    expect(readPick("9", options)).toBeUndefined();
    expect(readPick("eu acho que o 3 ganha fácil hein", options)).toBeUndefined();
    expect(readPick("time 2", ["Coxinha", "Pastel"])).toBe(1);
    expect(readPick("time coxinha", ["Coxinha", "Pastel"])).toBe(0);
    expect(readPick("oi gente", ["Coxinha", "Pastel"])).toBeUndefined();
  });

  it("reads grabbing the potato and pulling the rope", () => {
    expect(readGrab("pega")).toBe(true);
    expect(readGrab("PEGUEIII")).toBe(true);
    expect(readGrab("é minha")).toBe(true);
    expect(readGrab("passa pra mim")).toBe(true);
    expect(readGrab("pega a batata")).toBe(true);
    expect(readGrab("que jogo legal")).toBe(false);
    expect(readPull("puxa")).toBe(true);
    expect(readPull("PUXAAAAA")).toBe(true);
    expect(readPull("força time")).toBe(true);
    expect(readPull("vai vai vai")).toBe(true);
    expect(readPull("o pastel é melhor")).toBe(false);
  });
});

describe("making rounds", () => {
  it("draws teams and fuses, and moves the rope with the pulls", () => {
    const tug = makeTug(seeded(2));
    expect(tug.teams).toHaveLength(2);
    expect(makeTug(seeded(2), (pair) => pair.teams.join() === tug.teams.join()).teams).not.toEqual(tug.teams);
    const fuse = makePotato(seeded(3)).fuseMs;
    expect(fuse).toBeGreaterThanOrEqual(FUSE_MIN_MS);
    expect(fuse).toBeLessThanOrEqual(FUSE_MAX_MS);
    expect(ropePosition([0, 0])).toBe(0);
    expect(ropePosition([30, 10])).toBeLessThan(0);
    expect(ropePosition([0, 500])).toBe(1);
  });
});

describe("party games in the GameMaster", () => {
  it("plays every round of a generated game, not just the first", () => {
    for (const kind of ["tug", "potato"] as const) {
      const { clock, games } = setup();
      games.start({ kind, rounds: 3 }, "studio");
      for (let t = 0; t < 180_000 && (games.status()?.round ?? 0) < 2; t += 250) {
        clock.advance(250);
        games.tick(true);
        while (games.takeCue()) {}
      }
      expect(games.status()?.round).toBe(2);
    }
  });

  it("pulls the rope with likes, PUXA and gifts, and scores the winning team", () => {
    const { clock, games, last, ranking } = setup();
    games.start({ kind: "tug", rounds: 1 }, "studio");
    games.tick(true);
    expect(games.handleChat(say("ana", "1"))).toBe(true);
    expect(games.handleChat(say("bia", "2"))).toBe(true);
    expect(games.handleChat(say("caio", "1"))).toBe(true);
    games.handleLike(like("ana", 20));
    games.handleLike(like("bia", 10));
    games.handleLike(like("zé", 500)); // not on a team: nothing
    clock.advance(3_000);
    expect(games.handleChat(say("bia", "PUXAAA"))).toBe(true);
    expect(games.handleChat(say("bia", "puxa"))).toBe(true); // taken, but too soon to pull again
    expect(games.handleChat(say("ana", "o pastel é melhor"))).toBe(false);
    games.handleGift(gift("bia", 5)); // a team battle: the gift pulls for bia's team
    clock.advance(300);
    games.tick(false);
    const scene = last("tug");
    expect(scene.teams.map((team) => team.members)).toEqual([2, 1]);
    expect(scene.teams[0]?.pulls).toBe(5 + 5 + 20); // ana and caio joined (5 each), ana's likes
    expect(scene.teams[1]?.pulls).toBe(5 + 10 + 5 + 50);
    expect(scene.rope).toBeGreaterThan(0);
    expect(games.hostContext()).toContain("pulls");

    clock.advance(40_000);
    games.tick(false);
    const reveal = last("tug");
    expect(reveal.winner).toBe(1);
    expect(reveal.mvp).toBe("bia");
    // Everyone on the winning team scores, and the MVP scores again.
    expect(ranking.status().rows).toEqual([{ name: "bia", points: 20 }]);
  });

  it("blows the potato up on whoever holds it, and pays the others for the time they held it", () => {
    const { clock, games, last, ranking, fx } = setup(4);
    games.start({ kind: "potato", rounds: 1 }, "studio");
    games.tick(true);
    const open = last("potato");
    expect(open.durationMs).toBe(0); // the fuse is secret: no timer on stage
    expect(open.remainingMs).toBe(0);
    expect(games.takeCue()?.note).not.toContain("seconds left");
    const fuse = Number(games.status()?.answer?.match(/\d+/)?.[0]) * 1000;

    expect(games.handleChat(say("ana", "pega"))).toBe(true);
    clock.advance(8_000);
    expect(games.handleChat(say("bia", "PEGUEI"))).toBe(true);
    clock.advance(1_000);
    expect(games.handleChat(say("ana", "pega"))).toBe(true); // ana grabs it back: bia keeps her second
    expect(games.handleChat(say("bia", "pega"))).toBe(true); // too soon after her last grab: no change
    clock.advance(300);
    games.tick(false);
    const held = last("potato");
    expect(held.holder).toBe("ana");
    expect(held.leaders[0]).toEqual({ name: "ana", seconds: 8 });
    expect(games.hostContext()).toContain("never guess when it blows");

    clock.advance(fuse);
    games.tick(false);
    const boom = last("potato");
    expect(boom.phase).toBe("reveal");
    expect(boom.exploded?.name).toBe("ana");
    expect(boom.exploded?.lost).toBeGreaterThan(8);
    expect(fx).toContain("shake");
    expect(ranking.status().rows).toEqual([{ name: "bia", points: 1 }]);
    expect(games.takeCue()?.note).toContain("blew up in ana's hands");
  });

  it("gives party games the power-ups that make sense for them", () => {
    const { games, last } = setup();
    games.start({ kind: "potato", rounds: 1 }, "studio");
    games.tick(true);
    expect(games.handleGift(gift("ana", 100))).toEqual(["double"]); // no extra time on a secret fuse, no hint
    expect(last("potato").boosts).toEqual(["double"]);
    games.stop();
    games.start({ kind: "tug", rounds: 1 }, "studio");
    games.tick(true);
    expect(games.handleGift(gift("ana", 100))).toEqual(["time", "double"]);
  });

  it("keeps a tug of war open through the stream delay, so late pulls still count", () => {
    const { clock, games } = setup(7, 5_000);
    games.start({ kind: "tug", rounds: 1 }, "studio");
    games.tick(true);
    clock.advance(41_000);
    games.tick(false);
    expect(games.status()?.phase).toBe("open");
    expect(games.handleChat(say("ana", "2"))).toBe(true);
    clock.advance(5_000);
    games.tick(false);
    expect(games.status()?.phase).toBe("reveal");
  });
});
