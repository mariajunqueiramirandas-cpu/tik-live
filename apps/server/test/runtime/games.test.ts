import { describe, expect, it } from "bun:test";
import type { GameScene, LiveEvent, Sound } from "@tik-live/shared";
import { matchesAnswer, normalize, readNumber, readOption, readTrueFalse } from "../../src/runtime/games/answers";
import { BANK, guessLanguage, makeMath, sameIdea, scrambleLetters, type RoundContent } from "../../src/runtime/games/content";
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

function setup(options: { writer?: GameWriter | null; unsafe?: (text: string) => boolean; streamDelayMs?: number } = {}) {
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
    ...(options.streamDelayMs !== undefined ? { streamDelayMs: options.streamDelayMs } : {}),
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

  it("tells a reworded repeat from a new question", () => {
    const trivia = (question: string, answer: string): RoundContent => ({ kind: "trivia", question, options: [answer, "x", "y", "z"], correct: 0 });
    expect(sameIdea(trivia("Qual é o maior planeta do sistema solar?", "Júpiter"), trivia("Qual o maior planeta do Sistema Solar?", "Jupiter"))).toBe(true);
    expect(sameIdea(trivia("Qual planeta é o maior do nosso sistema?", "Júpiter"), trivia("Qual é o maior planeta?", "Júpiter"))).toBe(true);
    expect(sameIdea(trivia("Qual é o maior planeta?", "Júpiter"), trivia("Qual é o maior oceano?", "Pacífico"))).toBe(false);
    expect(sameIdea(trivia("Qual planeta tem a Grande Mancha Vermelha?", "Júpiter"), trivia("Qual é o maior oceano?", "Pacífico"))).toBe(false);
    expect(sameIdea({ kind: "poll", question: "Pizza ou hambúrguer?", options: ["Pizza", "Hambúrguer"] }, { kind: "poll", question: "Time hambúrguer ou time pizza?", options: ["Hambúrguer", "Pizza"] })).toBe(true);
    expect(sameIdea({ kind: "riddle", riddle: "O que tem dentes mas não morde?", answers: ["pente"], hint: "" }, { kind: "riddle", riddle: "Tenho dentes e nunca mordo.", answers: ["Pente"], hint: "" })).toBe(true);
    expect(sameIdea({ kind: "scramble", word: "BANANA", hint: "a" }, { kind: "fastest", word: "BANANA" })).toBe(false);
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
    expect(scenes.at(-1)).toBeUndefined(); // ready, but the host is still talking
    games.tick(true);
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
    expect(games.takeCue()?.note).toContain("Round 2 of 2");
    clock.advance(26_000);
    games.tick(true);
    expect(games.takeCue()?.note).toContain("Reveal for round 2 of 2");
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

  it("keeps game moments in order and waits for the host to announce the answer before the next round", async () => {
    const { clock, games, flush } = setup();
    games.start({ kind: "fastest", rounds: 2 }, "studio");
    await flush();
    games.tick(true);
    const word = games.status()!.answer!;
    // Someone wins before the host got to read the round out: the question is skipped, the answer isn't.
    games.handleChat(say("ana", word.toLowerCase()));
    const reveal = games.takeCue();
    expect(reveal?.note).toContain("The round ended before you could read it out");
    expect(reveal?.note).toContain("ana got it first");
    expect(games.takeCue()).toBeNull();

    games.handleChat(say("x", "warming up"));
    clock.advance(30_000);
    games.tick(true);
    expect(games.status()?.round).toBe(2);
    clock.advance(25_000);
    games.tick(false); // nobody got round 2; the host is busy
    expect(games.status()?.phase).toBe("reveal");
    clock.advance(8_000);
    games.tick(true);
    // The host hasn't announced round 2's answer yet, so the results wait...
    expect(games.status()?.phase).toBe("reveal");
    expect(games.takeCue()?.note).toContain("Reveal for round 2 of 2");
    games.tick(true);
    // ...and then come in order.
    expect(games.status()?.phase).toBe("results");
    expect(games.takeCue()?.note).toContain("Game over!");
  });

  it("narrows the number range and ends the round on an exact guess", () => {
    const { clock, games, scenes } = setup();
    games.start({ kind: "number", rounds: 1 }, "studio");
    games.tick(true);
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
    games.tick(true);
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
    games.tick(true);
    expect(requests[0]).toMatchObject({ kind: "trivia", count: 5, topic: "space", language: "en", chatSample: ["hello chat"] });
    const seen: string[] = [];
    for (let round = 1; round <= 3; round++) {
      expect(games.status()?.round).toBe(round);
      seen.push(games.status()!.prompt);
      games.takeCue(); // the host reads the round out
      clock.advance(26_000);
      games.tick(true);
      games.takeCue(); // ...and its answer
      clock.advance(8_000);
      games.tick(true);
    }
    expect(seen[0]).toContain("Safe question?");
    expect(seen.join(" ")).not.toContain("Unsafe");
    expect(new Set(seen).size).toBe(3); // two from the bank, no repeats
  });

  it("asks for themes, tells the writer this kind's past rounds, and drops reworded repeats", async () => {
    const trivia = (question: string, answer: string): RoundContent => ({ kind: "trivia", question, options: [answer, "Saturn", "Mars", "Venus"], correct: 0 });
    const batches: RoundContent[][] = [
      [trivia("Which is the largest planet in the solar system?", "Jupiter")],
      // The same question in new words, a twin within the batch, and one new question.
      [trivia("Which planet is the largest in the solar system?", "Jupiter"), trivia("What is the hottest planet?", "Venus"), trivia("Which planet is the hottest?", "Venus")],
    ];
    const requests: Array<{ avoid: string[]; themes?: string[] }> = [];
    const writer: GameWriter = {
      name: "fake",
      write: async (request) => {
        requests.push(request);
        return request.kind === "trivia" ? (batches.shift() ?? []) : [];
      },
    };
    const { clock, games, flush } = setup({ writer });
    const play = async (kind: "trivia" | "truefalse") => {
      games.start({ kind, rounds: 1 }, "studio");
      await flush();
      games.tick(true);
      const prompt = games.status()!.prompt;
      games.stop();
      clock.advance(1_000);
      return prompt;
    };
    await play("trivia");
    await play("truefalse");
    const second = await play("trivia");
    expect(requests[0]?.themes).toHaveLength(3);
    expect(requests[0]?.avoid).toEqual([]);
    expect(requests[2]?.avoid).toEqual(["Which is the largest planet in the solar system? → Jupiter"]); // no true/false rounds in a trivia list
    expect(second).toContain("What is the hottest planet?");
  });

  it("falls back to the bank when writing fails, and replaces risky names", async () => {
    const writer: GameWriter = { name: "down", write: async () => Promise.reject(new Error("api down")) };
    const { clock, games, scenes, flush } = setup({ writer });
    games.start({ kind: "truefalse", rounds: 1 }, "studio");
    await flush();
    games.tick(true);
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

  it("opens the first round when the host stops talking, and tells the host how long is really left", async () => {
    const { clock, games, flush } = setup();
    games.start({ kind: "trivia", rounds: 1 }, "studio");
    await flush();
    games.tick(false);
    expect(games.status()?.phase).toBe("preparing");
    expect(games.wantsFloor()).toBe(true); // the director holds new turns
    expect(games.hostContext()).toContain("goes up as soon as you finish talking");
    clock.advance(2_000);
    games.tick(true);
    expect(games.status()?.phase).toBe("open");
    expect(games.wantsFloor()).toBe(false);
    // The host gets to it 10 s into a 25 s round.
    clock.advance(10_000);
    expect(games.takeCue()?.note).toContain("They have about 15 seconds left.");
  });

  it("doesn't wait forever for a host that keeps talking", async () => {
    const { clock, games, flush } = setup();
    games.start({ kind: "number", rounds: 1 }, "studio");
    await flush();
    clock.advance(15_000);
    games.tick(false);
    expect(games.status()?.phase).toBe("open");
    clock.advance(57_000);
    expect(games.takeCue()?.note).toContain("Time is almost up: tell them to answer right now.");
  });

  it("keeps taking answers for the stream delay after the timer runs out", async () => {
    const { clock, games, scenes, flush } = setup({ streamDelayMs: 5_000 });
    games.start({ kind: "truefalse", rounds: 1 }, "studio");
    await flush();
    games.tick(true);
    const truth = games.status()!.answer === "true" ? "V" : "F";
    clock.advance(19_000);
    games.tick(false);
    // Viewers see the stream 5 s late: their clock still shows time when this answer is sent.
    expect(games.status()?.phase).toBe("open");
    expect(games.status()?.remainingSec).toBe(0);
    expect(games.hostContext()).toContain("Time is up on screen");
    expect(games.handleChat(say("ana", truth))).toBe(true);
    clock.advance(4_000);
    games.tick(false);
    const reveal = scenes.at(-1);
    if (reveal?.kind !== "truefalse") throw new Error("expected a true/false reveal");
    expect(reveal.phase).toBe("reveal");
    expect(reveal.winners).toEqual(["ana"]);
  });
});
