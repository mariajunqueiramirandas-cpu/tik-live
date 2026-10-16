import { describe, expect, it } from "vitest";
import { Director, nextLikeMilestone, type StageNotifier } from "../src/brain/director.js";
import type { HostBrain } from "../src/brain/host.js";
import { ViewerMemory } from "../src/brain/memory.js";
import type { TurnRequest } from "../src/brain/prompt.js";
import type { Utterance } from "../src/brain/sentences.js";
import { Triage } from "../src/brain/triage.js";
import { SafetyGate } from "../src/safety/gate.js";
import { SpeechPipeline, type SpeechOutput } from "../src/voice/pipeline.js";
import { NoTts } from "../src/voice/tts.js";
import { chat, fakeClock, gift, persona } from "./helpers.js";

class FakeHost implements HostBrain {
  readonly name = "fake";
  turns: TurnRequest[] = [];
  fail = false;
  async *generate(turn: TurnRequest): AsyncGenerator<Utterance> {
    this.turns.push(turn);
    if (this.fail) throw new Error("api down");
    yield { text: `line for ${turn.kind}`, emotion: "neutral" };
  }
}

const stage: StageNotifier = { alert: () => {}, segment: () => {}, stats: () => {} };
const instantOutput: SpeechOutput = { play: async () => {}, interrupt: () => {} };

function setup(options: { startInStandby?: boolean } = {}) {
  const clock = fakeClock();
  const memory = new ViewerMemory(undefined, clock.now);
  const triage = new Triage({ blocklist: [], hostName: persona.name, memory, now: clock.now });
  const speech = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), instantOutput, {}, clock.now);
  const host = new FakeHost();
  const director = new Director({
    persona,
    host,
    triage,
    memory,
    speech,
    stage,
    deadAirMs: 7_000,
    now: clock.now,
    ...options,
  });
  const step = async (ms = 0) => {
    clock.advance(ms);
    await director.tick();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const kinds = () => host.turns.map((t) => t.kind);
  return { clock, director, host, step, kinds };
}

describe("Director", () => {
  it("opens the show, reacts to viewers, then fills dead air", async () => {
    const { director, step, kinds, host } = setup();
    await step();
    expect(kinds()).toEqual(["opening"]);

    director.handleEvent(gift("maria", "Rose", 1));
    director.handleEvent(chat("joe", "what are you?"));
    await step(2_000);
    expect(kinds()).toEqual(["opening", "react"]);
    expect(host.turns[1]?.items.map((i) => i.event.kind)).toEqual(["gift", "chat"]);

    await step(2_000); // quiet, but not for long enough
    expect(kinds()).toHaveLength(2);
    await step(6_000);
    expect(kinds()).toEqual(["opening", "react", "filler"]);
  });

  it("keeps the recent lines it actually spoke", async () => {
    const { director, step } = setup();
    await step();
    director.noteSpoken("hello world");
    expect(director.state().recentLines).toEqual(["hello world"]);
  });

  it("stays silent while paused", async () => {
    const { director, step, kinds } = setup();
    director.pause();
    director.handleEvent(chat("joe", "hello?"));
    await step(20_000);
    expect(kinds()).toEqual([]);
    director.resume();
    await step(2_000);
    expect(kinds()).toEqual(["opening"]);
  });

  it("rotates segments when one runs out", async () => {
    const { director, step, kinds, host } = setup();
    await step();
    await step(5 * 60_000);
    expect(kinds()).toEqual(["opening", "segment_change"]);
    expect(host.turns[1]?.nextSegment?.id).toBe("b");
    expect(director.segment().id).toBe("b");
  });

  it("celebrates like milestones", async () => {
    const { director, step, kinds, host } = setup();
    const like = (count: number, total: number) =>
      director.handleEvent({ kind: "like", at: 0, viewer: { id: "1", handle: "a", nickname: "a" }, count, total });
    await step();
    like(15, 120); // joined mid-stream: baseline only
    await step(2_000);
    expect(kinds()).toEqual(["opening"]);
    like(400, 1_200); // crossed 500 and 1,000 at once
    await step(2_000);
    expect(kinds()).toEqual(["opening", "milestone"]);
    expect(host.turns[1]?.note).toContain("1,000 likes");
    expect(nextLikeMilestone(120)).toBe(500);
    expect(nextLikeMilestone(250_000)).toBe(300_000);
  });

  it("backs off after a failed turn instead of hammering the API", async () => {
    const { director, step, kinds, host } = setup();
    host.fail = true;
    await step(); // fails; 2s cooldown
    host.fail = false;
    director.handleEvent(chat("joe", "hello?"));
    await step(1_600);
    expect(kinds()).toEqual(["opening"]);
    await step(1_000);
    expect(kinds()).toEqual(["opening", "react"]);
  });

  it("waits in standby until the audience shows up, and again after the stream ends", async () => {
    const { director, step, kinds } = setup({ startInStandby: true });
    await step(30_000);
    expect(kinds()).toEqual([]);
    director.handleEvent(chat("joe", "anyone here?"));
    await step();
    expect(kinds()).toEqual(["opening"]);
    director.handleEvent({ kind: "stream_end", at: 0, reason: "ended" });
    await step(30_000);
    expect(kinds()).toEqual(["opening"]);
  });
});
