import { describe, expect, it } from "bun:test";
import type { Chronicler } from "../../src/runtime/brain/chronicle";
import type { Exchange } from "../../src/runtime/brain/conversation";
import type { HostBrain } from "../../src/runtime/brain/host";
import { ViewerMemory } from "../../src/runtime/brain/memory";
import type { TurnPlan, TurnRequest } from "../../src/runtime/brain/prompt";
import type { Utterance } from "../../src/runtime/brain/sentences";
import { TurnEngine } from "../../src/runtime/brain/turns";
import { SafetyGate } from "../../src/runtime/safety/gate";
import { SpeechPipeline, type SpeechOutput } from "../../src/runtime/voice/pipeline";
import { NoTts } from "../../src/runtime/voice/tts";
import { chat, fakeClock, persona } from "./helpers";

/** Says whatever the test queues up next, and remembers every request. */
class ScriptHost implements HostBrain {
  readonly name = "script";
  requests: TurnRequest[] = [];
  replies: Utterance[][] = [];
  async *generate(turn: TurnRequest): AsyncGenerator<Utterance> {
    this.requests.push(turn);
    for (const line of this.replies.shift() ?? [{ text: "Okay then.", emotion: "neutral" as const }]) yield line;
  }
  reconfigure(): void {}
}

const silentStage: SpeechOutput = { play: () => new Promise(() => {}), interrupt: () => {} };

function setup(options: { chronicler?: Chronicler; budget?: { softTokens: number; hardTokens: number; keepTurns: number } } = {}) {
  const clock = fakeClock();
  const memory = new ViewerMemory({ now: clock.now });
  const speech = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), silentStage, {}, clock.now);
  const host = new ScriptHost();
  const summaries: string[] = [];
  const engine = new TurnEngine({
    host,
    speech,
    memory,
    persona: () => persona,
    blocklist: () => [],
    now: clock.now,
    onSummary: (summary) => summaries.push(summary),
    ...options,
  });
  const plan = (partial: Partial<TurnPlan> = {}): TurnPlan => ({
    kind: "filler",
    items: [],
    segment: persona.segments[0]!,
    stats: { viewers: 3, likes: 0, uptimeMinutes: 1 },
    originAt: clock.now(),
    ...partial,
  });
  return { clock, memory, speech, host, engine, plan, summaries };
}

describe("TurnEngine", () => {
  it("commits each turn, so the next one sees what the host said, with its emotions", async () => {
    const { engine, host, plan, speech } = setup();
    host.replies.push([
      { text: "Hello everyone!", emotion: "happy" },
      { text: "So good to see you.", emotion: "happy" },
      { text: "What a party!", emotion: "excited", fx: ["confetti"] },
    ]);
    expect(await engine.run(plan({ kind: "opening" }))).toEqual({ ok: true, lines: 3, scrolledBy: [] });
    expect(speech.upcoming()).toEqual(["Hello everyone!", "So good to see you.", "What a party!"]);
    await engine.run(plan());
    const history = host.requests[1]?.context.history ?? [];
    expect(history).toHaveLength(1);
    expect(history[0]?.reply).toBe("[happy] Hello everyone!\nSo good to see you.\n[excited] What a party! [confetti]");
    expect(host.requests[1]?.context.brief).toContain("Your previous line is still playing");
  });

  it("stamps each line with when its turn started and when it was written, for the latency breakdown", async () => {
    const { engine, host, plan, speech, clock } = setup();
    host.replies.push([{ text: "Oi, Ana!", emotion: "happy" }]);
    const arrived = clock.now();
    clock.advance(1_500); // the message waited for the turn
    await engine.run(plan({ kind: "react", originAt: arrived }));
    await new Promise((r) => setImmediate(r));
    expect(speech.activeMeta()).toMatchObject({ first: true, originAt: arrived, startedAt: arrived + 1_500, writtenAt: arrived + 1_500 });
    expect(speech.nowPlaying()?.readyAt).toBe(arrived + 1_500);
  });

  it("never says the ids the brief uses, and drops a line it already said", async () => {
    const { engine, host, plan, speech } = setup();
    host.replies.push([{ text: "Thanks e12 for the rose (e12)!", emotion: "happy" }]);
    await engine.run(plan());
    expect(speech.upcoming()).toEqual(["Thanks for the rose!"]);

    host.replies.push([
      { text: "Thanks for the rose!", emotion: "happy" },
      { text: "Now something new.", emotion: "neutral" },
    ]);
    await engine.run(plan());
    expect(speech.upcoming()).toEqual(["Thanks for the rose!", "Now something new."]);
    await engine.run(plan());
    // The next room tells the host the repeat was dropped.
    expect(host.requests[2]?.context.room).toContain('<unsaid why="you\'d said this already, so it was dropped">"Thanks for the rose!"</unsaid>');
  });

  it("lets catchphrases and game announcements repeat", async () => {
    const { engine, host, plan, speech } = setup();
    for (let i = 0; i < 2; i++) host.replies.push([{ text: "Blip blip!", emotion: "excited" }]);
    for (let i = 0; i < 2; i++) host.replies.push([{ text: "Type your answer in chat now!", emotion: "excited" }]);
    await engine.run(plan());
    await engine.run(plan());
    await engine.run(plan({ kind: "game" }));
    await engine.run(plan({ kind: "game" }));
    expect(speech.upcoming()).toEqual(["Blip blip!", "Blip blip!", "Type your answer in chat now!", "Type your answer in chat now!"]);
  });

  it("tells the host which of its lines never aired, and why", async () => {
    const { engine, host, plan } = setup();
    await engine.run(plan());
    const meta = { turnId: "t1", turnKind: "filler", originAt: 0, first: false };
    engine.unsaid("cut", [{ text: "Anyway, about ducks.", meta, operator: false }]);
    engine.unsaid("blocked", [{ text: "A risky joke.", meta }]);
    engine.unsaid("skipped", [{ text: "Typed by the owner.", meta: undefined, operator: true }]);
    await engine.run(plan());
    const room = host.requests[1]?.context.room ?? "";
    expect(room).toContain('<unsaid why="cut before it aired: something more urgent came in">"Anyway, about ducks."</unsaid>');
    expect(room).toContain('<unsaid why="blocked by the safety filter, never aired">"A risky joke."</unsaid>');
    expect(room).not.toContain("Typed by the owner.");
  });

  it("refers to the events a turn covers by id, gifts first", async () => {
    const { engine, host, plan, memory } = setup();
    const question = chat("ana", "what's your name?");
    const rose = { kind: "gift" as const, at: 0, viewer: { id: "leo", handle: "leo", nickname: "leo" }, giftName: "Rose", count: 1, diamonds: 1 };
    for (const event of [question, rose]) memory.observe(event);
    engine.conversation.add({ at: 0, kind: "viewer", event: question as Extract<typeof question, { kind: "chat" }> });
    engine.conversation.add({ at: 0, kind: "support", event: rose });
    await engine.run(
      plan({
        kind: "react",
        items: [
          { event: rose, events: [rose], priority: 100, expiresAt: 0, seq: 2 },
          { event: question, events: [question], priority: 70, expiresAt: 0, seq: 1 },
        ],
      }),
    );
    expect(host.requests[0]?.context.brief).toContain("Now: Thank e2 (gift), then answer e1 (chat).");
    expect(host.requests[0]?.context.brief).not.toContain("what's your name");
  });

  it("folds old turns into the chronicler's summary when the conversation outgrows its budget", async () => {
    const seen: Exchange[][] = [];
    const chronicler: Chronicler = {
      update: async (_previous, exchanges) => {
        seen.push([...exchanges]);
        return { summary: "Ana asked about cats; the host promised a song.", notes: [{ viewerId: "ana", note: "loves cats" }] };
      },
    };
    const { engine, host, plan, memory, summaries } = setup({ chronicler, budget: { softTokens: 200, hardTokens: 2_000, keepTurns: 2 } });
    memory.observe(chat("ana", "hi"));
    for (let i = 0; i < 8; i++) {
      host.replies.push([{ text: `This is a fairly long line of host talk number ${i}.`, emotion: "neutral" }]);
      await engine.run(plan());
    }
    engine.maintain(Date.now(), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen[0]).toHaveLength(8);
    expect(summaries).toEqual(["Ana asked about cats; the host promised a song."]);
    expect(memory.get("ana")?.notes).toEqual(["loves cats"]);
    await engine.run(plan());
    const context = host.requests.at(-1)!.context;
    expect(context.head).toBe("<earlier>\nAna asked about cats; the host promised a song.\n</earlier>");
    expect(context.history).toHaveLength(2);
  });

  it("backs off when the chronicler fails instead of retrying every tick", async () => {
    let calls = 0;
    const chronicler: Chronicler = {
      update: async () => {
        calls += 1;
        throw new Error("api down");
      },
    };
    const { engine, host, plan, clock } = setup({ chronicler, budget: { softTokens: 10, hardTokens: 1_000_000, keepTurns: 1 } });
    host.replies.push([{ text: "A line long enough to go over a tiny budget.", emotion: "neutral" }]);
    await engine.run(plan());
    for (let i = 0; i < 25; i++) {
      engine.maintain(clock.now(), true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock.advance(200);
    }
    expect(calls).toBe(1); // 5 s of ticks
    clock.advance(30_000);
    engine.maintain(clock.now(), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
  });

  it("drops the oldest turns past the hard limit when there's no chronicler", async () => {
    const { engine, host, plan } = setup({ budget: { softTokens: 100, hardTokens: 200, keepTurns: 3 } });
    for (let i = 0; i < 10; i++) {
      host.replies.push([{ text: `Another long line of host talk to fill the budget, number ${i}.`, emotion: "neutral" }]);
      await engine.run(plan());
    }
    engine.maintain(Date.now(), true);
    await engine.run(plan());
    expect(host.requests.at(-1)?.context.history).toHaveLength(3);
  });

  it("opens a new stream with what happened on the last one", async () => {
    const { engine, host, plan } = setup({
      chronicler: { update: async () => ({ summary: "Bia won the trivia game.", notes: [] }) },
      budget: { softTokens: 1, hardTokens: 100_000, keepTurns: 1 },
    });
    await engine.run(plan());
    engine.maintain(Date.now(), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    engine.endStream();
    engine.startStream();
    await engine.run(plan({ kind: "opening" }));
    const request = host.requests.at(-1)!;
    expect(request.context.head).toBe("<last_stream>\nBia won the trivia game.\n</last_stream>");
    expect(request.context.history).toEqual([]);
    expect(request.context.brief).toContain("with a quick callback to last stream if it fits");
  });
});
