import { describe, expect, it } from "bun:test";
import type { GameScene, LiveEvent } from "@tik-live/shared";
import {
  FUSE_MAX_MS,
  FUSE_MIN_MS,
  makePotato,
  makeRace,
  makeTug,
  makeWheel,
  RACE_MS,
  raceLeader,
  raceOdds,
  raceProgress,
  readGrab,
  readPick,
  readPull,
  ropePosition,
  SPIN_MS,
  wheelResult,
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

describe("reading bets, grabs and pulls", () => {
  it("reads a pick by number or name, and leaves chat alone", () => {
    const racers = ["Relâmpago", "Pé de Pano", "Faísca", "Trovão", "Pipoca"];
    expect(readPick("3", racers)).toBe(2);
    expect(readPick("#2", racers)).toBe(1);
    expect(readPick("aposto no 5", racers)).toBe(4);
    expect(readPick("relampago", racers)).toBe(0);
    expect(readPick("Pé de pano!", racers)).toBe(1);
    expect(readPick("9", racers)).toBeUndefined();
    expect(readPick("eu acho que o 3 ganha fácil hein", racers)).toBeUndefined();
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
  it("draws races with odds that follow the chances, a winner that crosses first, and lead changes", () => {
    expect(raceOdds(0.32)).toBe(3);
    expect(raceOdds(0.1)).toBe(10);
    const random = seeded(11);
    const wins = new Array<number>(5).fill(0);
    let leadChanges = 0;
    for (let n = 0; n < 400; n++) {
      const race = makeRace(random);
      expect(race.racers).toHaveLength(5);
      expect(new Set(race.racers.map((r) => r.name)).size).toBe(5);
      const finish = race.splits.map((splits) => splits.at(-1) as number);
      expect(finish[race.winner]).toBe(RACE_MS);
      for (const [i, at] of finish.entries()) if (i !== race.winner) expect(at).toBeGreaterThan(RACE_MS);
      expect(raceProgress(race.splits[race.winner] as number[], RACE_MS)).toBe(1);
      expect(raceLeader(race, RACE_MS - 1)).toBe(race.winner);
      // Odds in the long run: the ×3 favorite wins about three times as often as the ×10 long shot.
      const odds = race.racers[race.winner]?.odds as number;
      wins[odds === 3 ? 0 : odds === 4 ? 1 : odds === 5 ? 2 : odds === 7 ? 3 : 4]! += 1;
      let leader = -1;
      for (let t = 500; t < RACE_MS; t += 500) {
        const now = raceLeader(race, t);
        if (leader !== -1 && now !== leader) leadChanges++;
        leader = now;
      }
    }
    expect(wins[0]).toBeGreaterThan(wins[4] as number);
    expect(leadChanges).toBeGreaterThan(400);
  });

  it("spins a wheel whose odds are the strip's own", () => {
    const wheel = makeWheel(seeded(5));
    expect(wheel.strip).toHaveLength(20);
    expect(wheel.strip.filter((sector) => sector === 3)).toHaveLength(1);
    expect(wheel.sectors.map((s) => s.odds)).toEqual([2, 3, 5, 20]);
    expect(wheelResult(wheel)).toBe(wheel.strip[wheel.landing] as number);
  });

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
  it("runs a race: bets, the race on stage, payouts by the odds, into the loop ranking", () => {
    const { clock, games, last, ranking, fx } = setup();
    games.start({ kind: "race", rounds: 1 }, "studio");
    games.tick(true);
    const open = last("race");
    expect(open.stage).toBe("bets");
    expect(open.winner).toBeNull();
    expect(games.takeCue()?.note).toContain("Corrida maluca");
    expect(games.hostContext()).not.toMatch(/win|result/i); // the host never learns who's going to win

    const winner = open.racers.findIndex((racer) => racer.name === games.status()?.answer);
    const loser = (winner + 1) % 5;
    expect(games.handleChat(say("ana", String(winner + 1)))).toBe(true);
    expect(games.handleChat(say("bia", String(loser + 1)))).toBe(true);
    expect(games.handleChat(say("ana", String(loser + 1)))).toBe(true); // one bet each: the first counts
    expect(games.handleChat(say("caio", "que corrida"))).toBe(false);
    games.tick(false);
    clock.advance(300);
    games.tick(false);
    expect(last("race").racers[winner]?.bets).toBe(1);

    clock.advance(25_000);
    games.tick(false);
    expect(games.status()?.phase).toBe("running");
    expect(last("race").stage).toBe("running");
    expect(games.takeCue()?.note).toContain("the race is on");
    expect(games.handleChat(say("late", "1"))).toBe(false); // bets are closed
    for (let t = 0; t < RACE_MS - 300; t += 250) {
      clock.advance(250);
      games.tick(false);
    }
    const running = last("race");
    expect(running.stage).toBe("running");
    expect(running.racers.some((racer) => racer.progress > 0.5)).toBe(true);
    expect(running.event).not.toBeNull();
    clock.advance(500);
    games.tick(false);
    const finish = last("race");
    expect(finish.stage).toBe("finish");
    expect(finish.winner).toBe(winner);
    expect(finish.racers[winner]?.progress).toBe(1);
    expect(finish.winners).toEqual(["ana"]);
    expect(fx).toContain("confetti");
    const odds = open.racers[winner]?.odds as number;
    expect(ranking.status().rows).toEqual([{ name: "ana", points: 3 * odds }]);
    expect(games.takeCue()?.note).toContain("won the race");
  });

  it("plays every round of a generated game, not just the first", () => {
    for (const kind of ["race", "wheel", "tug", "potato"] as const) {
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

  it("spins the wheel after the bets and pays the color it stops on", () => {
    const { clock, games, last, ranking } = setup(9);
    games.start({ kind: "wheel", rounds: 1 }, "studio");
    games.tick(true);
    const result = last("wheel").sectors.findIndex((sector) => sector.label === games.status()?.answer);
    expect(games.handleChat(say("ana", String(result + 1)))).toBe(true);
    expect(games.handleChat(say("bia", "ouro"))).toBe(true);
    clock.advance(20_000);
    games.tick(false);
    const spinning = last("wheel");
    expect(spinning.stage).toBe("running");
    expect(spinning.landing).not.toBeNull();
    expect(spinning.result).toBeNull();
    expect(spinning.spinLeftMs).toBe(SPIN_MS);
    clock.advance(SPIN_MS);
    games.tick(false);
    const done = last("wheel");
    expect(done.stage).toBe("finish");
    expect(done.result).toBe(result);
    const odds = done.sectors[result]?.odds as number;
    const rows = ranking.status().rows;
    expect(rows.find((row) => row.name === "ana")?.points).toBe(4 * odds);
    if (result !== 3) expect(rows.some((row) => row.name === "bia")).toBe(false);
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
    games.start({ kind: "race", rounds: 1 }, "studio");
    games.tick(true);
    expect(games.handleGift(gift("ana", 100))).toEqual(["time", "double"]);
  });

  it("takes bets during the stream delay, then runs the race", () => {
    const { clock, games } = setup(7, 5_000);
    games.start({ kind: "race", rounds: 1 }, "studio");
    games.tick(true);
    clock.advance(26_000);
    games.tick(false);
    expect(games.status()?.phase).toBe("open");
    expect(games.handleChat(say("ana", "2"))).toBe(true);
    clock.advance(5_000);
    games.tick(false);
    expect(games.status()?.phase).toBe("running");
  });
});
