import { describe, expect, it } from "bun:test";
import type { GameScene, LiveEvent, Sound } from "@tik-live/shared";
import { matchesAnswer, normalize, readNumber, readOption, readTrueFalse } from "../../src/runtime/games/answers";
import { BANK, guessLanguage, makeMath, scrambleLetters, type RoundContent } from "../../src/runtime/games/content";
import { GameMaster } from "../../src/runtime/games/master";
import type { GameWriter } from "../../src/runtime/games/writer";
import { fakeClock, viewer } from "./helpers";

function say(handle: string, text: string): Extract<LiveEvent, { kind: "chat" }> {
  return { kind: "chat", at: 0, viewer: viewer(handle), text };
}

/** A seeded random source, so shuffles and secrets are reproducible. */
function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function setup(options: { writer?: GameWriter | null; unsafe?: (text: string) => boolean } = {}) {
  const clock = fakeClock();
  const scenes: Array<GameScene | null> = [];
  const sounds: Sound[] = [];
  const fx: string[] = [];
  const games = new GameMaster({
    writer: options.writer ?? null,
    gate: { check: async (text) => (options.unsafe?.(text) ? { safe: false, reason: "test" } : { safe: true }) },
    stage: { game: (scene) => scenes.push(scene), fx: (name) => fx.push(name), sfx: (sound) => sounds.push(sound) },
    blocklist: () => ["badword"],
    language: () => "en",
    sounds: () => true,
    now: clock.now,
    random: seeded(),
  });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  return { clock, games, scenes, sounds, fx, flush };
}

describe("reading answers", () => {
  it("understands letters, numbers, option text and true/false in two languages", () => {
    const options = ["Saturn", "Jupiter", "Neptune", "Earth"];
    expect(readOption("B", options)).toBe(1);
    expect(readOption(" b) ", options)).toBe(1);
    expect(readOption("letra C", options)).toBe(2);
    expect(readOption("4", options)).toBe(3);
    expect(readOption("júpiter", ["Saturno", "Júpiter"])).toBe(1);
    expect(readOption("e", ["yes", "no"])).toBeUndefined();
    expect(readOption("I think it's jupiter honestly", options)).toBeUndefined();
    expect(readTrueFalse("V")).toBe(true);
    expect(readTrueFalse("falso!")).toBe(false);
    expect(readTrueFalse("maybe")).toBeUndefined();
    expect(readNumber(" 42! ")).toBe(42);
    expect(readNumber("42 maybe")).toBeUndefined();
    expect(normalize("Violão!!")).toBe("violao");
    expect(matchesAnswer("Um relógio", ["relogio"])).toBe(true);
    expect(matchesAnswer("the towel", ["towel"])).toBe(true);
    expect(matchesAnswer("tower", ["towel"])).toBe(false);
  });

  it("guesses chat's language and keeps math whole and positive", () => {
    expect(guessLanguage(undefined, ["oi tudo bem", "que madrugada loka"])).toBe("pt");
    expect(guessLanguage(undefined, ["hi what is this"])).toBe("en");
    expect(guessLanguage("pt-BR", [])).toBe("pt");
    const random = seeded(3);
    for (let round = 1; round <= 8; round++) {
      const sum = makeMath(round, random);
      expect(Number.isInteger(sum.answer)).toBe(true);
      expect(sum.answer).toBeGreaterThan(0);
    }
    expect(scrambleLetters("PLANET", seeded(1))).not.toBe("PLANET");
    expect([...scrambleLetters("PLANET", seeded(1))].sort().join("")).toBe("AELNPT");
  });

  it("ships bank rounds that fit the stage", () => {
    for (const language of ["en", "pt"] as const) {
      for (const round of BANK[language].trivia) {
        expect(round.options).toHaveLength(4);
        expect(round.correct).toBeLessThan(4);
      }
      for (const round of BANK[language].scramble) expect(round.word).toMatch(/^[A-Z]{4,12}$/);
    }
  });
});

describe("GameMaster", () => {
  it("runs a trivia game: open, answers from chat, reveal, scores, final board", async () => {
    const { clock, games, scenes, sounds, fx, flush } = setup();
    expect(games.start({ kind: "trivia", rounds: 2 }, "studio")).toEqual({ ok: true });
    expect(games.start({ kind: "poll", rounds: 1 }, "studio").ok).toBe(false);
    await flush(); // the bank fills in
    const scene = scenes.at(-1);
    if (scene?.kind !== "trivia") throw new Error("expected a trivia scene");
    expect(scene.phase).toBe("open");
    expect(scene.correct).toBeNull(); // never sent before the reveal
    const opening = games.takeCue();
    expect(opening?.note).toContain("start of a Quiz game");
    expect(games.hostContext()).not.toContain("Answer:");

    const status = games.status()!;
    const right = status.answer!.slice(0, 1); // "B) Jupiter" → "B"
    const wrong = right === "A" ? "B" : "A";
    expect(games.handleChat(say("ana", right))).toBe(true);
    clock.advance(1_000);
    expect(games.handleChat(say("joe", right))).toBe(true);
    expect(games.handleChat(say("bia", wrong))).toBe(true);
    expect(games.handleChat(say("ana", wrong))).toBe(true); // only the first answer counts
    expect(games.handleChat(say("lua", "hi everyone"))).toBe(false); // plain chat stays chat

    clock.advance(25_000);
    games.tick(false);
    const reveal = scenes.at(-1);
    if (reveal?.kind !== "trivia") throw new Error("expected a trivia reveal");
    expect(reveal.phase).toBe("reveal");
    expect(reveal.winners).toEqual(["ana", "joe"]);
    expect(sounds).toContain("win");
    expect(fx).toContain("confetti");
    expect(games.takeCue()?.note).toContain("ana was fastest; 2 of 3 got it right");
    expect(games.handleChat(say("late", right))).toBe(false); // closed

    clock.advance(8_000);
    games.tick(true); // round 2 opens once the host finished talking
    expect(games.status()?.round).toBe(2);
    clock.advance(26_000);
    games.tick(true);
    clock.advance(8_000);
    games.tick(true);
    const board = scenes.at(-1);
    if (board?.kind !== "scoreboard") throw new Error("expected the scoreboard");
    expect(board.rows).toEqual([
      { name: "ana", points: 15 },
      { name: "joe", points: 10 },
    ]);
    expect(games.takeCue()?.note).toContain("1. ana (15 points)");
    clock.advance(11_000);
    games.tick(true);
    expect(games.isActive()).toBe(false);
    expect(scenes.at(-1)).toBeNull();
  });

  it("narrows the number range and ends the round on an exact guess", () => {
    const { clock, games, scenes } = setup();
    games.start({ kind: "number", rounds: 1 }, "studio");
    const secret = Number(games.status()?.answer);
    const low = Math.max(1, secret - 10);
    expect(games.handleChat(say("ana", String(low === secret ? secret + 1 : low)))).toBe(true);
    games.tick(false);
    clock.advance(300);
    games.tick(false);
    const narrowed = scenes.at(-1);
    if (narrowed?.kind !== "number") throw new Error("expected a number scene");
    expect(narrowed.answer).toBeNull();
    expect(narrowed.low <= secret && secret <= narrowed.high).toBe(true);
    expect(narrowed.high - narrowed.low).toBeLessThan(100);
    expect(games.handleChat(say("ana", String(secret)))).toBe(true); // too soon: cooldown, still taken
    expect(games.status()?.phase).toBe("open");
    clock.advance(3_000);
    games.handleChat(say("ana", String(secret)));
    expect(games.status()?.phase).toBe("reveal");
    expect(games.takeCue()?.note).toContain(`ana guessed it: ${secret}`);
  });

  it("takes scramble guesses that look like the word, and leaves other chat alone", async () => {
    const { games, flush } = setup();
    games.start({ kind: "scramble", rounds: 1 }, "studio");
    await flush();
    const word = games.status()!.answer!;
    expect(games.handleChat(say("joe", "oi"))).toBe(false);
    expect(games.handleChat(say("joe", "x".repeat(word.length)))).toBe(true);
    expect(games.handleChat(say("ana", word.toLowerCase()))).toBe(true);
    expect(games.status()?.phase).toBe("reveal");
    expect(games.status()?.leaderboard).toEqual([{ name: "ana", points: 15 }]);
  });

  it("checks written rounds with the safety gate and fills gaps from the bank", async () => {
    const written: RoundContent[] = [
      { kind: "trivia", question: "Safe question?", options: ["a1", "b1", "c1", "d1"], correct: 0 },
      { kind: "trivia", question: "Unsafe question?", options: ["a2", "b2", "c2", "d2"], correct: 1 },
    ];
    const requests: unknown[] = [];
    const writer: GameWriter = {
      name: "fake",
      write: async (request) => {
        requests.push(request);
        return written;
      },
    };
    const { clock, games, flush } = setup({ writer, unsafe: (text) => text.includes("Unsafe") });
    games.start({ kind: "trivia", rounds: 3, topic: "space" }, "studio", ["hello chat"]);
    await flush();
    expect(requests[0]).toMatchObject({ kind: "trivia", count: 5, topic: "space", language: "en", chatSample: ["hello chat"] });
    const seen: string[] = [];
    for (let round = 1; round <= 3; round++) {
      expect(games.status()?.round).toBe(round);
      seen.push(games.status()!.prompt);
      clock.advance(26_000);
      games.tick(true);
      clock.advance(8_000);
      games.tick(true);
    }
    expect(seen[0]).toContain("Safe question?");
    expect(seen.join(" ")).not.toContain("Unsafe");
    expect(new Set(seen).size).toBe(3); // two from the bank, no repeats
  });

  it("falls back to the bank when writing fails, and replaces risky names", async () => {
    const writer: GameWriter = { name: "down", write: async () => Promise.reject(new Error("api down")) };
    const { clock, games, scenes, flush } = setup({ writer });
    games.start({ kind: "truefalse", rounds: 1 }, "studio");
    await flush();
    expect(games.status()?.phase).toBe("open");
    const truth = games.status()!.answer === "true" ? "T" : "F";
    games.handleChat({ kind: "chat", at: 0, viewer: { id: "x", handle: "x", nickname: "badword king" }, text: truth });
    clock.advance(19_000);
    games.tick(false);
    const reveal = scenes.at(-1);
    if (reveal?.kind !== "truefalse") throw new Error("expected a true/false reveal");
    expect(reveal.winners).toEqual(["visitante"]);
    games.stop();
    expect(games.isActive()).toBe(false);
    expect(scenes.at(-1)).toBeNull();
  });
});
