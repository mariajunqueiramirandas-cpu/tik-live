import { describe, expect, it } from "bun:test";
import type { GameScene, GoalView, Persona, UpNextItem } from "@tik-live/shared";
import { deadAirFor, Director, nextLikeMilestone, type StageNotifier } from "../../src/runtime/brain/director";
import type { HostBrain } from "../../src/runtime/brain/host";
import { ViewerMemory } from "../../src/runtime/brain/memory";
import type { TurnRequest } from "../../src/runtime/brain/prompt";
import type { Utterance } from "../../src/runtime/brain/sentences";
import { Triage } from "../../src/runtime/brain/triage";
import { GameMaster } from "../../src/runtime/games/master";
import { LoopRanking } from "../../src/runtime/games/ranking";
import { SafetyGate } from "../../src/runtime/safety/gate";
import { SpeechPipeline, type SpeechOutput } from "../../src/runtime/voice/pipeline";
import { NoTts } from "../../src/runtime/voice/tts";
import { chat, fakeClock, gift, persona } from "./helpers";

class FakeHost implements HostBrain {
  readonly name = "fake";
  turns: TurnRequest[] = [];
  fail = false;
  /** What the host says on its next turn, instead of the default line. */
  say: string | undefined;
  async *generate(turn: TurnRequest): AsyncGenerator<Utterance> {
    this.turns.push(turn);
    if (this.fail) throw new Error("api down");
    const text = this.say ?? `line for ${turn.kind}`;
    this.say = undefined;
    yield { text, emotion: "neutral" };
  }
  reconfigure(): void {}
}

const stage: StageNotifier = { alert: () => {}, segment: () => {}, stats: () => {} };
/** Gift powers would turn every gift here into a pick or an anthem; extras.test.ts covers them. */
const noPerks = () => false;
const instantOutput: SpeechOutput = { play: async () => {}, interrupt: () => {} };

function setup(options: { startInStandby?: boolean; streamDelayMs?: number; persona?: Persona; stage?: StageNotifier } = {}) {
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
    deadAirMs: 7_000, giftPerks: noPerks,
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

  it("celebrates like milestones when the goals are off", async () => {
    const { director, step, kinds, host } = setup({ persona: { ...persona, goals: { show: false } } });
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
  const director: Director = new Director({ persona, host, triage, memory, speech, stage, deadAirMs: 7_000, giftPerks: noPerks, now: clock.now });
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
    // The host knows the rest of its filler never aired.
    expect(host.turns.at(-1)?.context.room).toContain('"filler 2" "filler 3"</unsaid>');
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
    // The opening is in the conversation as it was written; its last line is still on stage.
    expect(react.context.history.map((exchange) => exchange.reply)).toEqual(["opening 1\nopening 2\nopening 3"]);
    expect(react.context.brief).toContain("Your previous line is still playing");
    expect(react.context.room).toContain("first question?");
    expect(react.brief).toBe(true); // more than one turn's worth waiting
  });
});

describe("Director with games and context", () => {
  function gameSetup(output: SpeechOutput = instantOutput) {
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
    const speech = new SpeechPipeline(new NoTts(), gate, output, {}, clock.now);
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
    const director = new Director({ persona: gamePersona, host, triage, memory, speech, stage: stageWithFx, games, deadAirMs: 7_000, giftPerks: noPerks, now: clock.now });
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
    expect(announce.game).toContain("Adivinhe o número");

    director.handleEvent(chat("ana", "50"));
    expect(triage.pending()).toBe(0); // the game took it
    director.handleEvent(chat("joe", "this game is fun"));
    expect(triage.pending()).toBe(1); // ordinary chat still reaches the host
    await step(2_000);
    const react = host.turns.at(-1)!;
    expect(react.kind).toBe("react");
    expect(react.items.map((item) => item.event.kind === "chat" && item.event.text)).toEqual(["this game is fun"]);
    // The round's opening is part of the conversation, right where it happened.
    expect(react.context.history.at(-1)?.room).toContain("round 1 of 2 opened");
  });

  it("holds new turns while a round waits for the host to stop talking, then reads it first", async () => {
    const output = new HeldOutput();
    const { director, host, games, step } = gameSetup(output);
    const flush = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    await flush();
    expect(output.played).toEqual(["line for opening"]); // still on stage
    await step(5_000);
    expect(games.isActive()).toBe(true);
    expect(games.status()?.phase).toBe("preparing"); // ready, waiting for the host
    director.handleEvent(chat("joe", "this game is fun"));
    await step(2_000);
    expect(host.turns.map((turn) => turn.kind)).toEqual(["opening"]); // the round goes first
    output.finish();
    await flush();
    await step();
    expect(games.status()?.phase).toBe("open");
    expect(host.turns.map((turn) => turn.kind)).toEqual(["opening", "game"]);
  });

  it("gives the moderator what a line replies to, and plays sounds for gifts", async () => {
    const { director, step, contexts, sounds } = gameSetup();
    await step();
    director.handleEvent(chat("lucas", "canta um funk aí"));
    director.handleEvent(gift("maria", "Galaxy", 1_000));
    await step(2_000);
    await step(100);
    expect(contexts.some((context) => context?.includes("Viewer lucas wrote: canta um funk aí"))).toBe(true);
    // The segment's bit is part of what a line means.
    expect(contexts.every((context) => context?.includes(`The show's current segment is "Quiz": Banter between rounds.`))).toBe(true);
    expect(sounds).toContain("fanfare");
  });
});

describe("Director ordering", () => {
  const at = (event: ReturnType<typeof chat>, ms: number) => ({ ...event, at: ms });

  it("thanks gifts first, then answers messages oldest first, and moves past older ones it skipped", async () => {
    const { director, step, host } = setup();
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    director.handleEvent(at(chat("ana", "Blip you are so fun to watch"), 1_000));
    director.handleEvent(at(chat("bia", "Blip what game is this?"), 2_000));
    director.handleEvent(at(chat("caio", "is it raining?"), 3_000));
    director.handleEvent(at(chat("dani", "Blip do you like pizza?"), 4_000));
    director.handleEvent({ ...gift("leo", "Rose", 1), at: 5_000 });
    await step(2_000);
    const react = host.turns.at(-1)!;
    const who = react.items.map((item) => ("viewer" in item.event ? item.event.viewer.handle : ""));
    expect(who).toEqual(["leo", "ana", "bia", "dani"]);
    expect(react.context.brief).toContain("Now: Thank e5 (gift), then answer e1 (chat), then e2 (chat), then e4 (chat).");
    // caio's question is older than dani's, so it isn't answered in the same breath, but right after, saying who asked.
    await step(2_000);
    const owed = host.turns.at(-1)!;
    expect(owed).not.toBe(react);
    expect(owed.kind).toBe("react");
    expect(owed.items.map((item) => ("viewer" in item.event ? item.event.viewer.handle : ""))).toEqual(["caio"]);
    expect(owed.context.brief).toContain("Now: Answer e3 (chat). It came in a bit earlier and you didn't get to it: say who asked.");
  });

  it("doesn't come back to a question the host moved past but answered anyway", async () => {
    const { director, step, host } = setup();
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    director.handleEvent(at(chat("ana", "Blip you are so fun to watch"), 1_000));
    director.handleEvent(at(chat("bia", "Blip what game is this?"), 2_000));
    director.handleEvent(at(chat("caio", "is it raining?"), 3_000));
    director.handleEvent(at(chat("dani", "Blip do you like pizza?"), 4_000));
    // The brief skips caio's question, but it's in the room too, and the host answers it along the way.
    host.say = "Thanks, Ana! Trivia, Bia. No rain here, Caio. Pizza always, Dani.";
    await step(2_000);
    const react = host.turns.at(-1)!;
    expect(react.items.map((item) => ("viewer" in item.event ? item.event.viewer.handle : ""))).toEqual(["ana", "bia", "dani"]);
    for (let i = 0; i < 5; i++) await step(2_000);
    const later = host.turns.slice(host.turns.indexOf(react) + 1);
    expect(later.length).toBeGreaterThan(0);
    expect(later.some((turn) => turn.items.some((item) => "viewer" in item.event && item.event.viewer.handle === "caio"))).toBe(false);
  });

  it("comes back to a question that expired while the host couldn't get to it", async () => {
    const { director, step, host } = setup();
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    director.pause();
    director.handleEvent(chat("lumy", "gato ou cachorro?"));
    await step(61_000); // gone from the queue
    director.resume();
    await step(2_000);
    const turn = host.turns.at(-1)!;
    expect(turn.kind).toBe("react");
    expect(turn.items.map((item) => ("viewer" in item.event ? item.event.viewer.handle : ""))).toEqual(["lumy"]);
    expect(turn.context.brief).toContain("you didn't get to it: say who asked");
  });

  it("lets a question go once it's too old to answer", async () => {
    const { director, step, host } = setup();
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    director.pause();
    director.handleEvent(chat("lumy", "gato ou cachorro?"));
    await step(125_000); // the show was busy for over two minutes
    director.resume();
    await step(2_000);
    expect(host.turns.some((turn) => turn.items.some((item) => "viewer" in item.event && item.event.viewer.handle === "lumy"))).toBe(false);
  });

  it("gives chat time to answer through the stream delay after the host asks something", async () => {
    const { director, step, kinds } = setup({ streamDelayMs: 5_000 });
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    director.noteSpoken("Qual animal vocês querem que eu explore?");
    await step(8_000);
    expect(kinds()).toEqual(["opening"]); // 7 s of dead air isn't enough: viewers only just heard it
    await step(5_000);
    expect(kinds()).toEqual(["opening", "filler"]);
    director.noteSpoken("O polvo tem três corações.");
    await step(8_000);
    expect(kinds()).toEqual(["opening", "filler", "filler"]); // no question, the usual dead air
  });

  it("moves an overdue segment on even when chat keeps the host busy", async () => {
    const { director, step, kinds } = setup();
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    for (let i = 1; i <= 18; i++) {
      director.handleEvent(chat(`v${i}`, `message number ${i}`));
      await step(20_000);
    }
    const change = kinds().indexOf("segment_change");
    expect(change).toBeGreaterThan(0);
    expect(kinds().slice(0, change).every((kind) => kind !== "filler")).toBe(true);
    // At 5:00, right on time: the host had been answering chat in a row, so the show's turn came up just as the segment ran out.
    expect(change).toBe(15);
    expect(kinds().slice(0, change)).toContain("show");
    expect(kinds()[change + 1]).toBe("react");
    expect(director.segment().id).toBe("b");
  });

  it("lets viewers talk to each other without answering, but keeps it in the room", async () => {
    const { director, step, kinds, host } = setup();
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    director.handleEvent(chat("ana", "@bia viu o jogo ontem?"));
    director.handleEvent(chat("bia", "kkkkkk"));
    await step(2_000);
    expect(kinds()).toEqual(["opening"]);
    await step(6_000);
    expect(kinds()).toEqual(["opening", "filler"]);
    expect(host.turns.at(-1)!.context.room).toContain("viu o jogo ontem?");
  });

  it("lets the host pass when the only message waiting doesn't need it", async () => {
    const { director, step, host } = setup();
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    director.handleEvent(chat("ana", "que dia longo"));
    await step(2_000);
    expect(host.turns.at(-1)!.context.brief).toContain("If it doesn't need you, write only [pass].");
    director.handleEvent(gift("leo", "Rose", 1));
    director.handleEvent(chat("bia", "boa noite"));
    await step(2_000);
    expect(host.turns.at(-1)!.context.brief).not.toContain("[pass]"); // a gift always gets its thank-you
  });

  it("moves the show along after answering chat several turns in a row", async () => {
    const { director, step, kinds, host } = setup();
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    for (let i = 1; i <= 4; i++) {
      director.handleEvent(chat(`v${i}`, `message number ${i}`));
      await step(2_000);
    }
    director.handleEvent(chat("ana", "more chat"));
    director.handleEvent(chat("bia", "where are you from?"));
    director.handleEvent(gift("leo", "Rose", 1));
    await step(2_000);
    expect(kinds()).toEqual(["opening", "react", "react", "react", "react", "show"]);
    const show = host.turns.at(-1)!;
    // The gift is still thanked, the plain chat is let go, and the question waits for the next reaction.
    expect(show.items.map((item) => item.event.kind)).toEqual(["gift"]);
    expect(show.context.brief).toContain("Don't answer anyone by name this time");
    await step(2_000);
    expect(kinds().at(-1)).toBe("react");
    expect(host.turns.at(-1)!.items.map((item) => ("viewer" in item.event ? item.event.viewer.handle : ""))).toEqual(["bia"]);
  });

  it("folds a like milestone into a reaction instead of making it wait", async () => {
    const { director, step, kinds, host } = setup({ persona: { ...persona, goals: { show: false } } });
    await step();
    director.handleEvent({ kind: "like", at: 0, viewer: { id: "1", handle: "a", nickname: "a" }, count: 120 });
    director.handleEvent(chat("joe", "hello there"));
    await step(2_000);
    expect(kinds()).toEqual(["opening", "react"]);
    expect(host.turns[1]?.also).toBe("the stream just passed 100 likes: celebrate it in a few words.");
    expect(host.turns[1]?.context.brief).toContain("Also: the stream just passed 100 likes");
    await step(2_000);
    expect(kinds()).toEqual(["opening", "react"]);
  });

  it("greets whoever woke the show up in the opening, instead of answering them again after it", async () => {
    const { director, step, kinds, host } = setup({ startInStandby: true });
    director.handleEvent(chat("joe", "anyone here?"));
    await step();
    expect(kinds()).toEqual(["opening"]);
    expect(host.turns[0]?.items.map((item) => item.event.kind)).toEqual(["chat"]);
    expect(host.turns[0]?.context.brief).toContain("Along the way, answer e1 (chat).");
    await step(2_000);
    expect(kinds()).toEqual(["opening"]);
  });
});

describe("Director references", () => {
  /** Every id a brief or note names must be in a room the model can read. */
  function visible(turn: TurnRequest): void {
    const rooms = [turn.context.head, ...turn.context.history.map((exchange) => exchange.room), turn.context.room].join("\n");
    for (const ref of `${turn.context.brief}\n${turn.note ?? ""}`.match(/\be\d+\b/g) ?? []) {
      expect(rooms).toContain(`id="${ref}"`);
    }
  }

  it("never points the host at a message that scrolled by on a busy stretch", async () => {
    const { director, step, host } = setup();
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    await step();
    for (let i = 0; i < 30; i++) director.handleEvent({ ...chat(`v${i}`, i % 3 === 2 ? `question number ${i}?` : `message number ${i}`), at: 1_000 + i });
    for (let i = 0; i < 6; i++) await step(2_000);
    await step(10_000); // a quiet moment: owed questions come back
    expect(host.turns.length).toBeGreaterThan(2);
    for (const turn of host.turns) visible(turn);
  });

  it("forgets what was waiting when the stream ends", async () => {
    const { director, step, host, kinds } = setup({ startInStandby: true });
    director.handleEvent(chat("ana", "hello?"));
    await step();
    director.handleEvent(chat("joe", "late message"));
    director.handleEvent({ kind: "stream_end", at: 0, reason: "ended" });
    director.handleEvent({ kind: "viewers", at: 0, count: 3 }); // back live
    await step(2_000);
    expect(kinds()).toEqual(["opening", "opening"]);
    expect(host.turns[1]?.items).toEqual([]);
  });
});

describe("Director: up next, top likers and the loop's podium (ADR-0028)", () => {
  function loop(options: { segments?: typeof persona.segments } = {}) {
    const clock = fakeClock();
    const memory = new ViewerMemory({ now: clock.now });
    const triage = new Triage({ blocklist: [], hostName: persona.name, memory, now: clock.now });
    const speech = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), instantOutput, {}, clock.now);
    const host = new FakeHost();
    const scenes: Array<GameScene | null> = [];
    const schedules: UpNextItem[][] = [];
    const likers: Array<Array<{ name: string; value: number }>> = [];
    const gifters: Array<Array<{ name: string; value: number }>> = [];
    const gameStage = { game: (scene: GameScene | null) => scenes.push(scene), fx: () => {}, sfx: () => {} };
    const ranking = new LoopRanking({ stage: gameStage, sounds: () => false, now: clock.now });
    const games = new GameMaster({
      writer: null,
      gate: { check: async () => ({ safe: true }) },
      stage: gameStage,
      blocklist: () => [],
      language: () => "en",
      sounds: () => false,
      ranking,
      now: clock.now,
    });
    const director = new Director({
      persona: { ...persona, segments: options.segments ?? persona.segments },
      host,
      triage,
      memory,
      speech,
      stage: { ...stage, schedule: (items) => schedules.push(items), leaders: (board, rows) => (board === "likes" ? likers : gifters).push(rows) },
      games,
      ranking,
      deadAirMs: 600_000,
      now: clock.now,
    });
    const step = async (ms = 0) => {
      clock.advance(ms);
      await director.tick();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    const kinds = () => host.turns.map((t) => t.kind);
    // Someone's watching, so the show runs its segments (an empty room only reacts).
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    return { clock, director, host, ranking, scenes, schedules, likers, gifters, step, kinds };
  }

  it("tells the stage what's up next, with the podium before the loop starts over", async () => {
    const { director, ranking, schedules, step, clock } = loop();
    const start = clock.now();
    await step();
    expect(schedules.at(-1)).toEqual([
      { kind: "segment", title: "Segment B", inMs: 5 * 60_000 },
      { kind: "segment", title: "Segment A", inMs: 10 * 60_000 },
    ]);
    expect(director.upNext()[0]).toEqual({ kind: "segment", title: "Segment B", at: start + 5 * 60_000 });
    ranking.add("a", "ana", 10);
    await step(1_000);
    expect(schedules.at(-1)?.map((item) => `${item.kind}:${item.title}`)).toEqual(["segment:Segment B", "podium:Pódio geral", "segment:Segment A"]);
    expect(schedules.at(-1)?.[1]?.inMs).toBe(5 * 60_000 - 1_000 + 5 * 60_000);
    // Sent only when something changes, not every tick.
    const sent = schedules.length;
    await step(1_000);
    expect(schedules).toHaveLength(sent);
  });

  it("lists the segment's next game", () => {
    const { director, clock } = loop({
      segments: [
        { id: "a", title: "Quiz time", minutes: 10, prompt: "Quiz.", game: { kind: "trivia", rounds: 3, topic: "futebol" } },
        { id: "b", title: "Chat", minutes: 5, prompt: "Chat." },
      ],
    });
    expect(director.upNext()[0]).toEqual({ kind: "game", title: "Quiz: futebol", at: clock.now() + 4_000 });
  });

  it("reveals the podium when the last segment ends, then goes back to the first", async () => {
    const { director, ranking, scenes, step, kinds } = loop();
    await step();
    await step(5 * 60_000);
    expect(kinds()).toEqual(["opening", "segment_change"]);
    expect(director.segment().id).toBe("b");
    ranking.add("a", "ana", 30);
    ranking.add("b", "bia", 10);
    await step(5 * 60_000);
    expect(kinds().at(-1)).toBe("game");
    expect(ranking.isRevealing()).toBe(true);
    expect(director.segment().id).toBe("b");
    expect(scenes.at(-1)).toMatchObject({ kind: "podium", suspense: 2 });
    for (let i = 0; i < 200 && ranking.isRevealing(); i++) await step(1_000);
    expect(ranking.isRevealing()).toBe(false);
    expect(scenes.at(-1)).toBeNull();
    await step(2_000);
    expect(kinds().at(-1)).toBe("segment_change");
    expect(director.segment().id).toBe("a");
    expect(ranking.rows()).toEqual([]);
  });

  it("moves straight on when nobody scored this loop", async () => {
    const { director, ranking, step, kinds } = loop();
    await step();
    await step(5 * 60_000);
    await step(5 * 60_000);
    expect(kinds()).toEqual(["opening", "segment_change", "segment_change"]);
    expect(director.segment().id).toBe("a");
    expect(ranking.isRevealing()).toBe(false);
  });

  it("treats each run of a single segment as a loop", async () => {
    const { director, ranking, step, kinds } = loop({ segments: [{ id: "a", title: "Only", minutes: 5, prompt: "Do it." }] });
    await step();
    ranking.add("a", "ana", 10);
    expect(director.upNext()).toMatchObject([{ kind: "podium" }]);
    await step(5 * 60_000);
    expect(kinds().at(-1)).toBe("game");
    expect(ranking.isRevealing()).toBe(true);
    expect(director.state().segmentEndsInSec).toBe(5 * 60);
  });

  it("ranks likers over the last 15 minutes and clears them when the stream ends", async () => {
    const { director, likers, step } = loop();
    const like = (handle: string, count: number) => director.handleEvent({ kind: "like", at: 0, viewer: { id: handle, handle, nickname: handle }, count });
    await step();
    like("ana", 30);
    like("bia", 50);
    await step(1_000);
    expect(likers.at(-1)).toEqual([
      { name: "bia", value: 50 },
      { name: "ana", value: 30 },
    ]);
    expect(director.leaders().likes).toEqual(likers.at(-1)!);
    await step(10 * 60_000);
    like("ana", 30);
    await step(1_000);
    expect(likers.at(-1)?.[0]).toEqual({ name: "ana", value: 60 });
    await step(5 * 60_000);
    expect(likers.at(-1)).toEqual([{ name: "ana", value: 30 }]);
    director.handleEvent({ kind: "stream_end", at: 0, reason: "test" });
    expect(likers.at(-1)).toEqual([]);
  });

  it("ranks gifters by diamonds over the last hour", async () => {
    const { director, gifters, step } = loop();
    await step();
    director.handleEvent(gift("ana", "Rose", 1));
    director.handleEvent(gift("bia", "Galaxy", 1_000));
    await step(1_000);
    expect(gifters.at(-1)).toEqual([
      { name: "bia", value: 1_000 },
      { name: "ana", value: 1 },
    ]);
    await step(61 * 60_000);
    expect(director.leaders().gifts).toEqual([]);
    expect(gifters.at(-1)).toEqual([]);
  });
});

describe("Director: up next titles", () => {
  it("names a segment's game once, even when the segment is named after it", () => {
    const clock = fakeClock();
    const memory = new ViewerMemory({ now: clock.now });
    const director = new Director({
      persona: {
        ...persona,
        segments: [
          { id: "a", title: "Chat", minutes: 5, prompt: "Chat." },
          { id: "b", title: "Charadas", minutes: 5, prompt: "Riddles.", game: { kind: "riddle", rounds: 3 } },
          { id: "c", title: "Perguntas", minutes: 5, prompt: "Quiz.", game: { kind: "trivia", rounds: 3 } },
        ],
      },
      host: new FakeHost(),
      triage: new Triage({ blocklist: [], hostName: persona.name, memory, now: clock.now }),
      memory,
      speech: new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), instantOutput, {}, clock.now),
      stage,
      deadAirMs: 7_000, giftPerks: noPerks,
      now: clock.now,
    });
    expect(director.upNext().map((item) => item.title)).toEqual(["Charadas", "Perguntas · Quiz", "Chat"]);
  });
});

describe("Director support card", () => {
  function supportSetup(giftAsks: "light" | "active" = "light", support?: boolean) {
    const clock = fakeClock();
    const memory = new ViewerMemory({ now: clock.now });
    const triage = new Triage({ blocklist: [], hostName: persona.name, memory, now: clock.now });
    const speech = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), instantOutput, {}, clock.now);
    const host = new FakeHost();
    const cards: Array<string | null> = [];
    const director = new Director({
      persona: { ...persona, segments: [{ id: "a", title: "Segment A", minutes: 60, prompt: "Do A." }], ...(support === undefined ? {} : { support }) },
      host,
      triage,
      memory,
      speech,
      stage: { ...stage, support: (card) => cards.push(card ? card.title : null) },
      deadAirMs: 7_000, giftPerks: noPerks,
      giftAsks: () => giftAsks,
      now: clock.now,
    });
    const step = async (ms = 0) => {
      clock.advance(ms);
      await director.tick();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    return { director, host, step, cards };
  }

  it("shows how to support the show now and then, and the host explains it in a quiet moment", async () => {
    const { host, step, cards } = supportSetup();
    await step();
    await step(2 * 60_000);
    expect(cards).toEqual([]);
    await step(60_000); // 3 minutes in
    expect(cards).toEqual(["Blip é uma IA ao vivo"]);
    await step(20_000);
    expect(cards).toEqual(["Blip é uma IA ao vivo", null]);
    expect(host.turns.some((turn) => turn.note?.includes("how people can support it"))).toBe(false);
    await step(3 * 60_000); // past 5 minutes in: the next quiet moment explains it
    const talk = host.turns.find((turn) => turn.note?.includes("how people can support it"));
    expect(talk?.kind).toBe("filler");
    expect(talk?.note).toContain("don't guilt anyone");
    expect(talk?.note).toContain("bills to pay");
    expect(talk?.note).toContain("top gifters card");
    expect(cards.at(-1)).toBe("Blip é uma IA ao vivo"); // the card goes up with it
  });

  it("asks for gifts more often when the channel asks actively", async () => {
    const { host, step } = supportSetup("active");
    await step();
    for (let i = 0; i < 6; i++) await step(30_000); // 3 minutes in
    const ask = host.turns.find((turn) => turn.note?.includes("ask the room for gifts"));
    expect(ask?.kind).toBe("filler");
    expect(ask?.note).toContain("No guilt");
  });

  it("stays off when the creator turns it off", async () => {
    const { host, step, cards } = supportSetup("light", false);
    await step();
    for (let i = 0; i < 20; i++) await step(30_000);
    expect(cards).toEqual([]);
    expect(host.turns.some((turn) => turn.note?.includes("support it"))).toBe(false);
  });
});

describe("Director: like and gift goals (ADR-0036)", () => {
  function goalSetup(goals?: Persona["goals"]) {
    const published: GoalView[][] = [];
    const effects: string[] = [];
    const sounds: string[] = [];
    const goalStage: StageNotifier = {
      ...stage,
      goals: (views) => published.push(views),
      fx: (fx) => effects.push(fx),
      sfx: (sound) => sounds.push(sound),
    };
    const run = setup({ persona: { ...persona, ...(goals ? { goals } : {}) }, stage: goalStage });
    const like = (count: number, total?: number) =>
      run.director.handleEvent({ kind: "like", at: 0, viewer: { id: "1", handle: "a", nickname: "a" }, count, ...(total === undefined ? {} : { total }) });
    return { ...run, like, published, effects, sounds };
  }

  it("shows both goals, celebrates the like goal once instead of a milestone, and moves on to the next", async () => {
    const { director, step, kinds, host, like, published, effects, sounds } = goalSetup();
    expect(director.goalsView()).toEqual([
      { kind: "likes", value: 0, target: 500, level: 1 },
      { kind: "gifts", value: 0, target: 100, level: 1 },
    ]);
    await step();
    like(15, 120); // joined mid-stream: a baseline, not a party
    await step(2_000);
    expect(kinds()).toEqual(["opening"]);
    like(400, 1_200); // past 500 and 1,000 at once: one goal to celebrate, the highest
    expect(published.at(-1)?.[0]).toEqual({ kind: "likes", value: 1_200, target: 2_500, level: 2 });
    expect(effects).toContain("confetti");
    expect(sounds).toContain("fanfare");
    await step(2_000);
    expect(kinds()).toEqual(["opening", "milestone"]);
    expect(host.turns[1]?.note).toBe("the stream just reached its like goal of 1,000 likes (thank chat; the next goal is 2,500)");
    expect(host.turns[1]?.context.brief).toContain("Goals: likes 1,200 of 2,500 (goal 2); gifts 0 of 100 diamonds (goal 1).");
  });

  it("counts diamonds toward the gift goal and folds it into the thank-you", async () => {
    const { director, step, kinds, host, published } = goalSetup({ show: true, gifts: 50 });
    await step();
    director.handleEvent(gift("maria", "Galaxy", 60));
    expect(published.at(-1)?.[1]).toEqual({ kind: "gifts", value: 60, target: 100, level: 2 });
    await step(2_000);
    expect(kinds()).toEqual(["opening", "react"]);
    expect(host.turns[1]?.also).toContain("the stream just reached its gift goal of 50 diamonds (thank the gifters; the next goal is 100 diamonds)");
  });

  it("follows a new target from the studio, and hides the goals when they're turned off", async () => {
    const { director, step, kinds, like, published } = goalSetup();
    await step();
    like(300);
    director.reconfigure({ ...persona, goals: { show: true, likes: 250 } });
    // 300 likes are already past 250: the goal moves on to 500 without a party for likes already in.
    expect(published.at(-1)?.[0]).toEqual({ kind: "likes", value: 300, target: 500, level: 1 });
    director.reconfigure({ ...persona, goals: { show: false } });
    expect(published.at(-1)).toEqual([]);
    like(300);
    await step(2_000);
    expect(kinds()).toEqual(["opening", "milestone"]); // the milestones are back: 500 likes
    director.reconfigure({ ...persona, goals: { show: true, likes: 250 } });
    expect(published.at(-1)?.[0]).toEqual({ kind: "likes", value: 600, target: 750, level: 1 });
  });
});

describe("Director: fan levels and calls to people scrolling past (ADR-0037)", () => {
  function scrollSetup() {
    const levels: Array<[string, number]> = [];
    const hooks: Array<string | null> = [];
    const effects: string[] = [];
    const run = setup({
      stage: { ...stage, fanLevel: (name, level) => levels.push([name, level]), hook: (text) => hooks.push(text), fx: (fx) => effects.push(fx) },
    });
    run.director.handleEvent({ kind: "viewers", at: 0, count: 12 });
    return { ...run, levels, hooks, effects };
  }

  it("announces a level-up on stage, and the host congratulates bigger ones by name", async () => {
    const { director, step, host, levels } = scrollSetup();
    await step();
    for (let i = 0; i < 13; i++) director.handleEvent(chat("joe", `hello ${i}`)); // 25 + 13 × 2 points: level 2
    expect(levels).toEqual([["joe", 2]]);
    director.handleEvent(gift("maria", "Leão", 100)); // 25 + 300 points: level 4
    expect(levels.at(-1)).toEqual(["maria", 4]);
    await step(2_000);
    const thanks = host.turns.find((turn) => turn.items.some((item) => item.event.kind === "gift"));
    expect(thanks?.also).toContain("maria reached fan level 4");
    expect(thanks?.also).not.toContain("joe"); // level 2 is the stage's alone
  });

  it("calls out to people scrolling past in a quiet moment, with the offer big on stage, and sooner after a wave of arrivals", async () => {
    const { director, step, host, hooks } = scrollSetup();
    await step();
    for (let i = 0; i < 12; i++) await step(8_000); // 96 seconds of quiet
    const hook = host.turns.find((turn) => turn.note?.includes("People scrolling through LIVEs"));
    expect(hook?.kind).toBe("filler");
    expect(hooks[0]).toBe("COMENTA SEU NOME E GANHA UM APELIDO");
    expect(hook?.note).toContain("invent a funny nickname");
    await step(10_000);
    expect(hooks.at(-1)).toBeNull(); // the banner came down
    // Three arrivals in a few seconds: the next call comes after a minute, not four.
    const before = host.turns.filter((turn) => turn.note?.includes("People scrolling")).length;
    for (const handle of ["a", "b", "c"]) director.handleEvent({ kind: "join", at: 0, viewer: { id: handle, handle, nickname: handle } });
    for (let i = 0; i < 8; i++) await step(8_000);
    expect(host.turns.filter((turn) => turn.note?.includes("People scrolling")).length).toBe(before + 1);
    expect(hooks.filter(Boolean)[1]).toBe("PERGUNTA QUALQUER COISA PRA IA");
  });

  it("keeps the stage moving when nothing has happened for a while, but not right after a gift", async () => {
    const { director, step, effects } = scrollSetup();
    await step();
    await step(20_000);
    director.handleEvent(gift("maria", "Rose", 1));
    await step(10_000); // 30 s in, but the gift moved the stage 10 s ago
    expect(effects).toEqual([]);
    await step(26_000);
    expect(effects).toEqual(["sparkles"]);
  });
});
