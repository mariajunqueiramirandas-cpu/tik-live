import { describe, expect, it } from "bun:test";
import { autoShow, type LiveEvent, type Persona, segmentKey } from "@tik-live/shared";
import { Director, type StageNotifier } from "../../src/runtime/brain/director";
import type { HostBrain } from "../../src/runtime/brain/host";
import { ViewerMemory } from "../../src/runtime/brain/memory";
import type { TurnRequest } from "../../src/runtime/brain/prompt";
import type { Utterance } from "../../src/runtime/brain/sentences";
import { Triage } from "../../src/runtime/brain/triage";
import { SafetyGate } from "../../src/runtime/safety/gate";
import { scoreTake, SegmentMeter, type SegmentScore, SegmentScores } from "../../src/runtime/segment-scores";
import { SpeechPipeline, type SpeechOutput } from "../../src/runtime/voice/pipeline";
import { NoTts } from "../../src/runtime/voice/tts";
import { fakeClock, gift, persona, viewer } from "./helpers";

const MIN = 60_000;

describe("scoreTake", () => {
  const base = { ms: 30 * MIN, likes: 3_000, diamonds: 300, viewersAvg: 20 };

  it("scores a segment against the stream it was in", () => {
    const same = scoreTake({ ms: 10 * MIN, likes: 1_000, diamonds: 100, viewersAvg: 20, viewersStart: 20, viewersEnd: 20 }, base);
    expect(same?.score).toBeCloseTo(0, 5);
    const better = scoreTake({ ms: 10 * MIN, likes: 2_000, diamonds: 200, viewersAvg: 40, viewersStart: 20, viewersEnd: 60 }, base);
    expect(better!.likes).toBeGreaterThan(0.9);
    expect(better!.viewers).toBeGreaterThan(0.9);
    expect(better!.score).toBeGreaterThan(0.8);
    const worse = scoreTake({ ms: 10 * MIN, likes: 200, diamonds: 0, viewersAvg: 10, viewersStart: 20, viewersEnd: 5 }, base);
    expect(worse!.score).toBeLessThan(-0.8);
  });

  it("doesn't let one whale's gift decide the show", () => {
    const whale = scoreTake({ ms: 10 * MIN, likes: 1_000, diamonds: 1_000_000, viewersAvg: 20, viewersStart: 20, viewersEnd: 20 }, base);
    expect(whale!.diamonds).toBe(2);
    expect(whale!.score).toBeCloseTo(0.6, 5);
  });

  it("learns nothing from an empty room, and ignores viewers arriving at the start of a stream", () => {
    expect(scoreTake({ ms: 10 * MIN, likes: 0, diamonds: 0, viewersAvg: 0, viewersStart: 0, viewersEnd: 0 }, base)).toBeNull();
    const opening = { ms: 10 * MIN, likes: 1_000, diamonds: 100, viewersAvg: 20, viewersStart: 0, viewersEnd: 40 };
    expect(scoreTake(opening, base)!.viewers).toBeCloseTo(1, 5);
    expect(scoreTake(opening, base, false)!.viewers).toBeCloseTo(0, 5);
  });
});

describe("SegmentMeter", () => {
  it("averages viewers over time and starts each segment from zero", () => {
    const meter = new SegmentMeter();
    meter.startStream(0, 10);
    meter.like(100);
    meter.setViewers(30, 3 * MIN);
    // 10 viewers for 3 minutes, 30 for 1: 15 on average.
    const first = meter.endSegment(4 * MIN);
    expect(first!.take).toMatchObject({ ms: 4 * MIN, likes: 100, viewersAvg: 15, viewersStart: 10, viewersEnd: 30 });
    const second = meter.endSegment(5 * MIN);
    expect(second).toBeNull(); // a minute is too short to say anything
    meter.endStream();
    expect(meter.endSegment(20 * MIN)).toBeNull();
  });
});

describe("SegmentScores", () => {
  const take = (score: number) => ({ score, viewers: score, likes: score, diamonds: score });

  it("leans toward segments that keep working, more surely the more they play", () => {
    const scores = new SegmentScores();
    scores.record("talk:Resenha", "Resenha", 8, take(1));
    const once = scores.weight("talk:Resenha");
    scores.record("talk:Resenha", "Resenha", 8, take(1));
    scores.record("talk:Resenha", "Resenha", 8, take(1));
    expect(once).toBeGreaterThan(1);
    expect(scores.weight("talk:Resenha")).toBeGreaterThan(once);
    expect(scores.weight("talk:Resenha")).toBeLessThanOrEqual(4);
    expect(scores.weight("talk:Nunca tocou")).toBe(1);
    scores.record("game:math", "Conta rápida", 7, take(-1.5));
    scores.record("game:math", "Conta rápida", 7, take(-1.5));
    expect(scores.weight("game:math")).toBeLessThan(0.7);
    expect(scores.ranked().map((s) => s.key)).toEqual(["talk:Resenha", "game:math"]);
    expect(scores.get("talk:Resenha")).toMatchObject({ plays: 3, minutes: 24 });
  });

  it("follows a changing audience: recent takes count more", () => {
    const scores = new SegmentScores();
    for (let i = 0; i < 10; i++) scores.record("k", "K", 5, take(1));
    for (let i = 0; i < 4; i++) scores.record("k", "K", 5, take(-1));
    expect(scores.get("k")!.score).toBeLessThan(0);
  });

  it("tells the host what a segment is known for once it has a record", () => {
    const scores = new SegmentScores();
    scores.record("talk:Resenha", "Resenha", 8, { score: 1, viewers: 0, likes: 1.5, diamonds: 1 });
    expect(scores.describe("talk:Resenha")).toBeUndefined(); // one take isn't a trend
    scores.record("talk:Resenha", "Resenha", 8, { score: 1, viewers: 0, likes: 1.5, diamonds: 1 });
    expect(scores.describe("talk:Resenha")).toBe('on this channel, "Resenha" is one of your best segments (more likes and gifts than the rest of the show). Go all in on it.');
    scores.record("game:math", "Conta rápida", 7, { score: -1, viewers: -1.2, likes: -0.1, diamonds: 0 });
    scores.record("game:math", "Conta rápida", 7, { score: -1, viewers: -1.2, likes: -0.1, diamonds: 0 });
    expect(scores.describe("game:math")).toContain("tends to lose the room (fewer viewers than the rest of the show)");
  });

  it("saves only when something changed, and keeps changes a failed save didn't write", async () => {
    const saved: SegmentScore[][] = [];
    let fail = true;
    const scores = new SegmentScores([], {
      persistence: {
        save: async (all) => {
          if (fail) throw new Error("db down");
          saved.push(all);
        },
      },
      now: () => 42,
    });
    await scores.flush();
    scores.record("k", "K", 5, take(0.5));
    expect(scores.flush()).rejects.toThrow("db down");
    fail = false;
    await scores.flush();
    await scores.flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]![0]).toMatchObject({ key: "k", title: "K", plays: 1, at: 42 });
  });

  it("keeps the 64 segments played most recently", () => {
    let t = 0;
    const scores = new SegmentScores([], { now: () => ++t });
    for (let i = 0; i < 70; i++) scores.record(`segment:${i}`, `S${i}`, 5, take(0));
    expect(scores.all()).toHaveLength(64);
    expect(scores.get("segment:0")).toBeUndefined();
    expect(scores.get("segment:69")).toBeDefined();
  });
});

describe("autoShow with focus", () => {
  it("plans exactly as before without a focus", () => {
    expect(autoShow(3, 1234, undefined)).toEqual(autoShow(3, 1234));
  });

  it("opens loops with what works more often, gives it more time, and still plays the rest", () => {
    const focus = (key: string) => (key === "talk:Resenha" ? 4 : key === "talk:Isso me lembra" ? 0.25 : 1);
    let first = 0;
    let weak = 0;
    let seen = 0;
    for (let loop = 0; loop < 200; loop++) {
      const show = autoShow(loop, 99, focus);
      if (show[0]?.title === "Resenha") first += 1;
      if (show.some((s) => s.title === "Isso me lembra")) weak += 1;
      const resenha = show.find((s) => s.title === "Resenha");
      if (resenha) {
        seen += 1;
        expect(resenha.minutes).toBe(12); // 8 minutes, +50%
      }
    }
    // Uniform, Resenha would open 1 loop in 14 (about 14 of 200); at 4x it's about 1 in 4.
    expect(first).toBeGreaterThan(30);
    expect(seen).toBeGreaterThan(first);
    // The weak format still comes up now and then.
    expect(weak).toBeGreaterThan(0);
    expect(weak).toBeLessThan(40);
    expect(autoShow(5, 99, focus)).toEqual(autoShow(5, 99, focus));
  });

  it("keys automatic segments by format and game, a creator's by id", () => {
    const [talk, game] = autoShow(0, 1);
    expect(segmentKey(talk!)).toBe(`talk:${talk!.title}`);
    expect(segmentKey(game!, game!.game!.kind as never)).toBe(`game:${game!.game!.kind}`);
    expect(segmentKey({ id: "a", title: "Segment A" }, "trivia")).toBe("segment:a");
  });
});

class FakeHost implements HostBrain {
  readonly name = "fake";
  turns: TurnRequest[] = [];
  async *generate(turn: TurnRequest): AsyncGenerator<Utterance> {
    this.turns.push(turn);
    yield { text: `line for ${turn.kind}`, emotion: "neutral" };
  }
  reconfigure(): void {}
}

const stage: StageNotifier = { alert: () => {}, segment: () => {}, stats: () => {} };
const instantOutput: SpeechOutput = { play: async () => {}, interrupt: () => {} };
const three: Persona = {
  ...persona,
  segments: [
    { id: "a", title: "Segment A", minutes: 5, prompt: "Do A." },
    { id: "b", title: "Segment B", minutes: 5, prompt: "Do B." },
    { id: "c", title: "Segment C", minutes: 5, prompt: "Do C." },
  ],
};

function setup(options: { persona?: Persona; scores?: SegmentScores } = {}) {
  const clock = fakeClock();
  const memory = new ViewerMemory({ now: clock.now });
  const triage = new Triage({ blocklist: [], hostName: persona.name, memory, now: clock.now });
  const speech = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), instantOutput, {}, clock.now);
  const host = new FakeHost();
  const scores = options.scores ?? new SegmentScores([], { now: clock.now });
  const director = new Director({
    persona: options.persona ?? three,
    host,
    triage,
    memory,
    speech,
    stage,
    deadAirMs: 7_000,
    giftPerks: () => false,
    segmentScores: scores,
    showSeed: 7,
    now: clock.now,
  });
  const step = async (ms = 0) => {
    clock.advance(ms);
    await director.tick();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const send = (event: LiveEvent) => director.handleEvent({ ...event, at: clock.now() });
  const viewers = (count: number) => send({ kind: "viewers", at: 0, count });
  const likes = (count: number) => send({ kind: "like", at: 0, viewer: viewer("fan"), count });
  return { clock, director, host, scores, step, send, viewers, likes };
}

describe("Director focus", () => {
  it("learns which segments pull the room, and gives one that's working right now more time", async () => {
    const { director, scores, step, send, viewers, likes } = setup();
    viewers(10);
    director.resetSession();
    await step();
    likes(5);
    await step(5 * MIN); // a quiet Segment A
    expect(director.segment().id).toBe("b");
    expect(scores.get("segment:a")).toMatchObject({ plays: 1, title: "Segment A" });

    // Segment B takes off: the room triples, likes and gifts pour in.
    viewers(30);
    likes(600);
    send(gift("maria", "Lion", 50));
    await step(5 * MIN);
    expect(director.segment().id).toBe("b");
    expect(director.state().segmentEndsInSec).toBe(150); // half its 5 minutes more
    await step(150_000);
    expect(director.segment().id).toBe("c");
    const b = scores.get("segment:b")!;
    expect(b.score).toBeGreaterThan(0.5);
    expect(b.minutes).toBe(7.5);
    expect(scores.weight("segment:b")).toBeGreaterThan(scores.weight("segment:a"));
  });

  it("tells the host what the segment it's starting is known for", async () => {
    const at = 0;
    const record = (key: string, title: string, score: number): SegmentScore => ({ key, title, plays: 5, minutes: 25, score, viewers: score, likes: score, diamonds: score, at });
    const scores = new SegmentScores([record("segment:a", "Segment A", -1), record("segment:b", "Segment B", 1)]);
    const { host, step } = setup({ scores });
    await step();
    await step(5 * MIN);
    expect(host.turns.map((t) => t.kind)).toEqual(["opening", "segment_change"]);
    expect(host.turns[0]?.insight).toContain('"Segment A" tends to lose the room');
    expect(host.turns[1]?.insight).toContain('"Segment B" is one of your best segments');
  });

  it("wraps up an automatic segment that's losing the room, but never cuts the creator's own", async () => {
    for (const autoShow of [true, false]) {
      const { director, step, viewers, likes } = setup({ persona: { ...three, autoShow } });
      viewers(30);
      director.resetSession();
      await step();
      likes(900);
      await step(3 * MIN);
      // Skip ahead to the third segment, where the room empties out.
      director.forceSegment(director.segments()[2]!.id);
      await step(2_000); // past the gap after the last turn
      viewers(4);
      const third = director.segment();
      expect(third.id).toBe(director.segments()[2]!.id);
      await step(Math.max(3 * MIN, third.minutes * 0.6 * MIN));
      // Cut short, it hands over to the next segment right away.
      if (autoShow) expect(director.segment().id).toBe(director.segments()[3]!.id);
      else expect(director.segment().id).toBe("c");
    }
  });
});
