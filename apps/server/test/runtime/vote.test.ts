import { describe, expect, it } from "bun:test";
import type { GameScene, Persona } from "@tik-live/shared";
import { Director, type StageNotifier } from "../../src/runtime/brain/director";
import type { HostBrain } from "../../src/runtime/brain/host";
import { ViewerMemory } from "../../src/runtime/brain/memory";
import type { TurnRequest } from "../../src/runtime/brain/prompt";
import type { Utterance } from "../../src/runtime/brain/sentences";
import { Triage } from "../../src/runtime/brain/triage";
import { GameMaster } from "../../src/runtime/games/master";
import { FinalVote, readBallot, voteOptions } from "../../src/runtime/games/vote";
import { SafetyGate } from "../../src/runtime/safety/gate";
import { SpeechPipeline, type SpeechOutput } from "../../src/runtime/voice/pipeline";
import { NoTts } from "../../src/runtime/voice/tts";
import { chat, fakeClock, persona } from "./helpers";

class FakeHost implements HostBrain {
  readonly name = "fake";
  turns: TurnRequest[] = [];
  async *generate(turn: TurnRequest): AsyncGenerator<Utterance> {
    this.turns.push(turn);
    yield { text: `line for ${turn.kind}`, emotion: "neutral" };
  }
  reconfigure(): void {}
}

describe("reading ballots", () => {
  it("takes a number or the game's name", () => {
    const labels = ["Quiz", "Charadas", "Dedo mais rápido"];
    expect(readBallot("2", labels)).toBe(1);
    expect(readBallot(" #3! ", labels)).toBe(2);
    expect(readBallot("charadas", labels)).toBe(1);
    expect(readBallot("dedo mais rapido", labels)).toBe(2);
    expect(readBallot("4", labels)).toBeUndefined();
    expect(readBallot("2 é melhor", labels)).toBeUndefined();
  });

  it("counts one ballot per viewer and picks the most voted", () => {
    const vote = new FinalVote(["trivia", "riddle", "fastest"]);
    expect(vote.winner()).toBeNull();
    vote.cast("a", "2");
    vote.cast("a", "1");
    vote.cast("b", "2");
    vote.cast("c", "1");
    expect(vote.tally()).toEqual([1, 2, 0]);
    expect(vote.winner()).toBe("riddle");
  });

  it("offers a different trio of games each loop", () => {
    expect(voteOptions(0)).toHaveLength(3);
    expect(voteOptions(0)).not.toEqual(voteOptions(1));
    expect(voteOptions(0)).not.toContain("poll");
  });
});

describe("Director: the vote on the last segment's game", () => {
  function setup(overrides: Partial<Persona> = {}) {
    const clock = fakeClock();
    const memory = new ViewerMemory({ now: clock.now });
    const triage = new Triage({ blocklist: [], hostName: persona.name, memory, now: clock.now });
    const output: SpeechOutput = { play: async () => {}, interrupt: () => {} };
    const speech = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), output, {}, clock.now);
    const host = new FakeHost();
    const votes: Array<{ title: string; options: string[]; tally: number[] } | null> = [];
    const scenes: Array<GameScene | null> = [];
    const gameStage = { game: (scene: GameScene | null) => scenes.push(scene), fx: () => {}, sfx: () => {} };
    const games = new GameMaster({ writer: null, gate: { check: async () => ({ safe: true }) }, stage: gameStage, blocklist: () => [], language: () => "en", sounds: () => false, now: clock.now });
    const stage: StageNotifier = { alert: () => {}, segment: () => {}, stats: () => {}, vote: (vote) => votes.push(vote) };
    const director = new Director({ persona: { ...persona, finalVote: true, ...overrides }, host, triage, memory, speech, stage, games, deadAirMs: 600_000, giftPerks: () => false, now: clock.now });
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    const step = async (ms = 0) => {
      clock.advance(ms);
      await director.tick();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    return { director, host, votes, games, step };
  }

  it("opens near the end of the second-to-last segment and gives the winner to the last one", async () => {
    const { director, host, votes, games, step } = setup();
    await step();
    await step(60_000);
    expect(director.voteStatus()).toBeNull();
    // Segment A (5 min) is second-to-last of two: the vote opens with 3 minutes to go.
    await step(60_000);
    const status = director.voteStatus();
    expect(status?.options.map((o) => o.label)).toEqual(["Quiz", "Charadas", "Batata quente"]);
    expect(votes.at(-1)).toEqual({ title: "Jogo do quadro final", options: ["Quiz", "Charadas", "Batata quente"], tally: [0, 0, 0] });
    expect(host.turns.at(-1)?.kind).toBe("game");
    expect(director.upNext().at(0)?.title).toBe("Segment B · o chat escolhe");

    director.handleEvent(chat("ana", "3"));
    director.handleEvent(chat("bia", "3"));
    director.handleEvent(chat("caio", "1"));
    expect(director.voteStatus()?.options.map((o) => o.votes)).toEqual([1, 0, 2]);
    await step(1_000);
    expect(votes.at(-1)?.tally).toEqual([1, 0, 2]);

    // Segment B starts, plays the winning game, and the vote leaves the stage.
    await step(3 * 60_000);
    expect(director.segment().id).toBe("b");
    await step(1_000);
    expect(votes.at(-1)).toBeNull();
    await step(4_000);
    expect(games.status()?.kind).toBe("potato");
  });

  it("stays off when the creator turns it off", async () => {
    const { director, step } = setup({ finalVote: false });
    await step();
    await step(4 * 60_000);
    expect(director.voteStatus()).toBeNull();
  });
});
