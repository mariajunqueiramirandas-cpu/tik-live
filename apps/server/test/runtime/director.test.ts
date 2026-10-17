import { describe, expect, it } from "bun:test";
import { deadAirFor, Director, nextLikeMilestone, type StageNotifier } from "../../src/runtime/brain/director";
import type { HostBrain } from "../../src/runtime/brain/host";
import { ViewerMemory } from "../../src/runtime/brain/memory";
import type { TurnRequest } from "../../src/runtime/brain/prompt";
import type { Utterance } from "../../src/runtime/brain/sentences";
import { Triage } from "../../src/runtime/brain/triage";
import { GameMaster } from "../../src/runtime/games/master";
import { SafetyGate } from "../../src/runtime/safety/gate";
import { SpeechPipeline, type SpeechOutput } from "../../src/runtime/voice/pipeline";
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
const instantOutput: SpeechOutput = { play: async () => {}, interrupt: () => {} };

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

/** A stage that holds each line until the test lets it finish. */
class HeldOutput implements SpeechOutput {
  played: string[] = [];
  private release: (() => void) | undefined;
  play(cue: { text: string }): Promise<void> {
    this.played.push(cue.text);
    return new Promise((resolve) => (this.release = resolve));
  }
  interrupt(): void {
    this.finish();
  }
  finish(): void {
    const release = this.release;
    this.release = undefined;
    release?.();
  }
}

/** Says three sentences per turn, so there's always something queued to cut. */
class ChattyHost implements HostBrain {
  readonly name = "chatty";
  turns: TurnRequest[] = [];
  async *generate(turn: TurnRequest): AsyncGenerator<Utterance> {
    this.turns.push(turn);
    for (const n of [1, 2, 3]) yield { text: `${turn.kind} ${n}`, emotion: "neutral" };
  }
  reconfigure(): void {}
}

function liveSetup() {
  const clock = fakeClock();
  const memory = new ViewerMemory({ now: clock.now });
  const triage = new Triage({ blocklist: [], hostName: persona.name, memory, now: clock.now });
  const output = new HeldOutput();
  const events = { onSpoken: (cue: { text: string }) => director.noteSpoken(cue.text) };
  const speech = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), output, events, clock.now);
  const host = new ChattyHost();
  const director: Director = new Director({ persona, host, triage, memory, speech, stage, deadAirMs: 7_000, now: clock.now });
  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  const step = async (ms = 0) => {
    clock.advance(ms);
    await director.tick();
    await flush();
  };
  /** Lets the line on stage finish and the next one start. */
  const next = async () => {
    output.finish();
    await flush();
  };
  return { director, host, output, speech, step, next };
}

describe("Director turn-taking", () => {
  it("lets a gift cut a filler short, but only after the sentence on stage", async () => {
    const { director, host, output, speech, step, next } = liveSetup();
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    for (let i = 0; i < 3; i++) await next(); // the opening plays out
    await step(8_000);
    expect(host.turns.map((t) => t.kind)).toEqual(["opening", "filler"]);
    expect(output.played.at(-1)).toBe("filler 1");
    expect(speech.pending()).toBe(2);

    director.handleEvent(gift("maria", "Rose", 1));
    expect(speech.pending()).toBe(0); // filler 2 and 3 dropped; filler 1 still on stage
    await step(); // no gap after yielding
    expect(host.turns.map((t) => t.kind)).toEqual(["opening", "filler", "react"]);
    await next();
    expect(output.played.slice(-2)).toEqual(["filler 1", "react 1"]);
  });

  it("never cuts a reaction short for another event", async () => {
    const { director, host, speech, step, next } = liveSetup();
    await step();
    for (let i = 0; i < 3; i++) await next();
    director.handleEvent(chat("joe", "hello host"));
    await step(2_000);
    expect(host.turns.at(-1)?.kind).toBe("react");
    director.handleEvent(gift("maria", "Lion", 500));
    expect(speech.pending()).toBe(2); // react 2 and 3 stay
  });

  it("tells the model what it's still about to say, and keeps busy replies brief", async () => {
    const { director, host, step, next } = liveSetup();
    await step();
    await next(); // "opening 1" done; "opening 2" on stage; "opening 3" queued
    director.handleEvent(chat("ana", "first question?"));
    await step(2_000);
    expect(host.turns).toHaveLength(1); // waits until the opening's last line is on stage
    await next();
    for (const name of ["b", "c", "d", "e", "f"]) director.handleEvent(chat(name, `message from ${name}`));
    await step(2_000);
    const react = host.turns.at(-1)!;
    expect(react.kind).toBe("react");
    // What it already said is in the room history; what's still playing or queued is "upcoming".
    const said = react.history.flatMap((entry) => (entry.kind === "host" ? [entry.text] : []));
    expect([...said, ...react.upcoming]).toEqual(["opening 1", "opening 2", "opening 3"]);
    expect(react.history.some((entry) => entry.kind === "viewer" && entry.event.kind === "chat" && entry.event.text === "first question?")).toBe(true);
    expect(react.brief).toBe(true); // more than one turn's worth waiting
  });
});

describe("Director with games and context", () => {
  function gameSetup() {
    const clock = fakeClock(Date.UTC(2026, 9, 16, 17, 0)); // Friday 14:00 in São Paulo
    const memory = new ViewerMemory({ now: clock.now });
    const triage = new Triage({ blocklist: [], hostName: persona.name, memory, now: clock.now });
    const contexts: Array<string | undefined> = [];
    const gate = new SafetyGate({
      blocklist: [],
      moderator: {
        model: "fake",
        review: async (_sentence, context) => {
          contexts.push(context);
          return { safe: true };
        },
      },
    });
    const speech = new SpeechPipeline(new NoTts(), gate, instantOutput, {}, clock.now);
    const host = new FakeHost();
    const sounds: string[] = [];
    const stageWithFx: StageNotifier = { ...stage, sfx: (sound) => sounds.push(sound) };
    const games = new GameMaster({
      writer: null,
      gate,
      stage: { game: () => {}, fx: () => {}, sfx: () => {} },
      blocklist: () => [],
      language: () => "en",
      sounds: () => false,
      now: clock.now,
      random: () => 0.42,
    });
    const gamePersona = {
      ...persona,
      timezone: "America/Sao_Paulo",
      segments: [{ id: "quiz", title: "Quiz", minutes: 10, prompt: "Banter between rounds.", game: { kind: "number" as const, rounds: 2 } }],
    };
    const director = new Director({ persona: gamePersona, host, triage, memory, speech, stage: stageWithFx, games, deadAirMs: 7_000, now: clock.now });
    const step = async (ms = 0) => {
      clock.advance(ms);
      await director.tick();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    return { clock, director, host, games, step, contexts, sounds, triage };
  }

  it("starts the segment's game, keeps answers out of the host's queue, and announces game moments", async () => {
    const { director, host, games, step, triage } = gameSetup();
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    expect(host.turns[0]?.kind).toBe("opening");
    expect(host.turns[0]?.clock).toBe("Friday 14:00 (afternoon)");
    await step(5_000);
    expect(games.isActive()).toBe(true);
    await step(2_000);
    const announce = host.turns.at(-1)!;
    expect(announce.kind).toBe("game");
    expect(announce.note).toContain("Round 1 of 2");
    expect(announce.game).toContain("Guess the number");

    director.handleEvent(chat("ana", "50"));
    expect(triage.pending()).toBe(0); // the game took it
    director.handleEvent(chat("joe", "this game is fun"));
    expect(triage.pending()).toBe(1); // ordinary chat still reaches the host
    await step(2_000);
    const react = host.turns.at(-1)!;
    expect(react.kind).toBe("react");
    expect(react.items.map((item) => item.event.kind === "chat" && item.event.text)).toEqual(["this game is fun"]);
    // The round's opening is now part of what the host remembers.
    expect(react.history.some((entry) => entry.kind === "show" && entry.text.includes("round 1 of 2"))).toBe(true);
  });

  it("gives the moderator what a line replies to, and plays sounds for gifts", async () => {
    const { director, step, contexts, sounds } = gameSetup();
    await step();
    director.handleEvent(chat("lucas", "canta um funk aí"));
    director.handleEvent(gift("maria", "Galaxy", 1_000));
    await step(2_000);
    await step(100);
    expect(contexts.some((context) => context?.includes("Viewer lucas wrote: canta um funk aí"))).toBe(true);
    expect(sounds).toContain("fanfare");
  });
});
