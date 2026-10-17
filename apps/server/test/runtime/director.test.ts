import { describe, expect, it } from "bun:test";
import { deadAirFor, Director, nextLikeMilestone, type StageNotifier } from "../../src/runtime/brain/director";
import type { HostBrain } from "../../src/runtime/brain/host";
import { ViewerMemory } from "../../src/runtime/brain/memory";
import type { TurnRequest } from "../../src/runtime/brain/prompt";
import type { Utterance } from "../../src/runtime/brain/sentences";
import { Triage } from "../../src/runtime/brain/triage";
import { SafetyGate } from "../../src/runtime/safety/gate";
import { SpeechPipeline, type SpeechCue, type SpeechOutput } from "../../src/runtime/voice/pipeline";
import { NoTts } from "../../src/runtime/voice/tts";
import { chat, fakeClock, gift, persona } from "./helpers";

class FakeHost implements HostBrain {
  readonly name = "fake";
  turns: TurnRequest[] = [];
  fail = false;
  async *generate(turn: TurnRequest): AsyncGenerator<Utterance> {
    this.turns.push(turn);
    if (this.fail) throw new Error("api down");
    yield { text: `line for ${turn.kind}`, emotion: "neutral" };
  }
  reconfigure(): void {}
}

const stage: StageNotifier = { alert: () => {}, segment: () => {}, stats: () => {} };
const instantOutput: SpeechOutput = { play: async () => {}, drop: () => {}, interrupt: () => {} };

function setup(options: { startInStandby?: boolean } = {}) {
  const clock = fakeClock();
  const memory = new ViewerMemory({ now: clock.now });
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
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
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

  it("fills silence less often when fewer people are watching", async () => {
    expect(deadAirFor(12, 7_000)).toBe(7_000);
    expect(deadAirFor(2, 7_000)).toBe(20_000);
    expect(deadAirFor(0, 7_000)).toBe(60_000);

    const { director, step, kinds } = setup();
    director.handleEvent({ kind: "viewers", at: 0, count: 2 });
    await step();
    await step(10_000);
    expect(kinds()).toEqual(["opening"]);
    await step(11_000);
    expect(kinds()).toEqual(["opening", "filler"]);
  });

  it("stops filling silence in an empty room but still reacts to viewers", async () => {
    const { director, step, kinds } = setup();
    await step();
    await step(11 * 60_000);
    // 11 minutes with nobody: at most the fillers before the room counted as empty.
    const before = kinds().length;
    expect(director.state().reactOnly).toBe(true);
    await step(120_000);
    expect(kinds().length).toBe(before);
    director.handleEvent(chat("late", "hello?"));
    await step(2_000);
    expect(kinds().at(-1)).toBe("react");
  });

  it("goes react-only when the budget guardrail says so", async () => {
    const { director, step, kinds } = setup();
    director.handleEvent({ kind: "viewers", at: 0, count: 20 });
    await step();
    director.setBudgetReactOnly(true);
    await step(30_000);
    expect(kinds()).toEqual(["opening"]);
    director.setBudgetReactOnly(false);
    await step(2_000);
    expect(kinds()).toEqual(["opening", "filler"]);
  });

  it("keeps the current segment when the persona is edited live", async () => {
    const { director, step } = setup();
    await step();
    director.forceSegment("b");
    await step(2_000);
    expect(director.segment().id).toBe("b");
    director.reconfigure({ ...persona, name: "Renamed" });
    expect(director.segment().id).toBe("b");
    director.reconfigure({ ...persona, segments: [{ id: "c", title: "C", minutes: 5, prompt: "Do C." }] });
    expect(director.segment().id).toBe("c");
  });
});

/** A stage that holds each line until the test lets it finish, like a real one playing audio. */
class HeldOutput implements SpeechOutput {
  readonly sent: string[] = [];
  readonly dropped: string[] = [];
  private readonly playing: Array<{ id: string; resolve: () => void }> = [];
  play(cue: SpeechCue): Promise<void> {
    this.sent.push(cue.text);
    return new Promise((resolve) => this.playing.push({ id: cue.id, resolve }));
  }
  drop(ids: readonly string[]): void {
    this.dropped.push(...ids);
    for (const id of ids) this.playing.find((p) => p.id === id)?.resolve();
  }
  interrupt(): void {
    for (const p of this.playing.splice(0)) p.resolve();
  }
  /** The line at the front finishes playing. */
  finishOne(): void {
    this.playing.shift()?.resolve();
  }
}

/** A host that follows a script per turn kind; `null` in a script waits for `release()`. */
class ScriptHost implements HostBrain {
  readonly name = "script";
  turns: TurnRequest[] = [];
  private gate: (() => void) | undefined;
  constructor(private readonly scripts: Partial<Record<TurnRequest["kind"], Array<string | null>>>) {}
  async *generate(turn: TurnRequest): AsyncGenerator<Utterance> {
    this.turns.push(turn);
    for (const line of this.scripts[turn.kind] ?? [`line for ${turn.kind}`]) {
      if (line === null) await new Promise<void>((resolve) => (this.gate = resolve));
      else yield { text: line, emotion: "neutral" };
    }
  }
  release(): void {
    this.gate?.();
  }
  reconfigure(): void {}
}

function liveSetup(host: HostBrain, extra: Partial<ConstructorParameters<typeof Director>[0]> = {}) {
  const clock = fakeClock();
  const memory = new ViewerMemory({ now: clock.now });
  const triage = new Triage({ blocklist: [], hostName: persona.name, memory, now: clock.now });
  const output = new HeldOutput();
  const failures: unknown[] = [];
  const speech = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), output, {}, clock.now);
  const director = new Director({
    persona,
    host,
    triage,
    memory,
    speech,
    stage,
    deadAirMs: 7_000,
    now: clock.now,
    hooks: { onTurnFailed: (err) => failures.push(err) },
    ...extra,
  });
  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  // Ticks without waiting for the turn: a scripted host may be mid-turn.
  const step = async (ms = 0) => {
    clock.advance(ms);
    void director.tick();
    await flush();
  };
  return { clock, director, output, speech, step, flush, failures };
}

describe("Director with a live stage (ADR-0022)", () => {
  it("lets a viewer take the stage from filler at the next sentence boundary", async () => {
    const host = new ScriptHost({
      opening: ["Hello everyone, welcome in."],
      filler: ["Filler one is a long thought.", "Filler two keeps going.", null, "Filler three never airs."],
      react: ["Joe, great question!"],
    });
    const { director, output, step, speech, flush } = liveSetup(host);
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    output.finishOne();
    await flush();
    await step(8_000); // dead air: filler starts, two lines go to the stage, the brain is still writing
    expect(output.sent).toEqual(["Hello everyone, welcome in.", "Filler one is a long thought.", "Filler two keeps going."]);

    director.handleEvent(chat("joe", "what are you?"));
    await step();
    // Filler one keeps playing; filler two is taken back; the filler turn stops being written.
    expect(output.dropped).toHaveLength(1);
    expect(director.state().turnInFlight).toBeNull();
    host.release();
    output.finishOne();
    await flush();
    await step(2_000);
    expect(output.sent.at(-1)).toBe("Joe, great question!");
    expect(output.sent).not.toContain("Filler three never airs.");
    expect(speech.upcoming()).toEqual(["Joe, great question!"]);
  });

  it("doesn't start a turn while plenty of speech is still queued", async () => {
    const host = new ScriptHost({ opening: ["One sentence that takes a while to say out loud.", "Another sentence that also takes a while to say."] });
    const { director, output, step, flush } = liveSetup(host);
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    director.handleEvent(chat("joe", "hi"));
    await step(1_600);
    expect(host.turns.map((t) => t.kind)).toEqual(["opening"]);
    // Once what's queued is about to run out, the next turn starts, and it knows what's still being said.
    output.finishOne();
    await flush();
    await step(500); // ~2.7 s of speech left: still too early
    expect(host.turns.map((t) => t.kind)).toEqual(["opening"]);
    await step(1_000); // ~1.7 s left: about the time a turn takes to reach the stage
    expect(host.turns.map((t) => t.kind)).toEqual(["opening", "react"]);
    expect(host.turns[1]?.upcomingLines).toEqual(["Another sentence that also takes a while to say."]);
  });

  it("rides out a burst of chat and gifts without cutting lines off or piling up speech", async () => {
    const host = new ScriptHost({ react: ["Thank you all so much!", "Chat is on fire tonight."] });
    const { director, output, step, flush, speech } = liveSetup(host);
    let interrupts = 0;
    const interrupt = output.interrupt.bind(output);
    output.interrupt = () => {
      interrupts += 1;
      interrupt();
    };
    director.handleEvent({ kind: "viewers", at: 0, count: 40 });
    await step();
    let maxPending = 0;
    for (let second = 0; second < 30; second++) {
      for (let i = 0; i < 4; i++) director.handleEvent(chat(`viewer${second}_${i}`, `message number ${second * 4 + i} for the host`));
      director.handleEvent(gift("maria", "Rose", 1));
      await step(1_000);
      if (second % 2 === 1) output.finishOne(); // the stage plays a line every two seconds
      await flush();
      maxPending = Math.max(maxPending, speech.pending());
    }
    expect(interrupts).toBe(0); // nothing was ever cut off
    expect(maxPending).toBeLessThanOrEqual(3); // at most about one turn queued behind the line playing
    // Maria's roses were thanked together, not one by one.
    const roses = host.turns.flatMap((t) => t.items).filter((i) => i.event.kind === "gift");
    expect(roses.length).toBeLessThan(10);
    expect(roses.reduce((sum, i) => sum + (i.event.kind === "gift" ? i.event.count : 0), 0)).toBeGreaterThan(10);
  });

  it("abandons a turn whose brain hangs, then recovers", async () => {
    let hang = true;
    const host: HostBrain = {
      name: "hangs",
      async *generate() {
        if (hang) await new Promise(() => {}); // never yields, ignores the abort signal
        yield { text: "Back again!", emotion: "happy" };
      },
      reconfigure() {},
    };
    const { director, output, step, failures } = liveSetup(host, { firstLineTimeoutMs: 20 });
    await step();
    expect(director.state().turnInFlight).toBe("opening");
    await new Promise((r) => setTimeout(r, 40));
    expect(director.state().turnInFlight).toBeNull();
    expect(failures).toHaveLength(1);
    hang = false;
    director.handleEvent(chat("joe", "hello?"));
    await step(2_500);
    expect(output.sent).toEqual(["Back again!"]);
  });
});
