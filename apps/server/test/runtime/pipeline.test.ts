import { describe, expect, it } from "bun:test";
import type { Utterance } from "../../src/runtime/brain/sentences";
import { SafetyGate, type Moderator } from "../../src/runtime/safety/gate";
import { SpeechPipeline, type SpeechCue, type SpeechOutput } from "../../src/runtime/voice/pipeline";
import { NoTts, type AudioClip, type TtsProvider } from "../../src/runtime/voice/tts";

class RecordingOutput implements SpeechOutput {
  played: string[] = [];
  interrupted = 0;
  async play(cue: SpeechCue): Promise<void> {
    this.played.push(cue.text);
  }
  drop(): void {}
  interrupt(): void {
    this.interrupted += 1;
  }
}

/** TTS whose latency depends on the text, to prove ordering survives out-of-order completion. */
class SlowTts implements TtsProvider {
  readonly name = "slow";
  async synthesize(text: string): Promise<AudioClip | null> {
    await new Promise((resolve) => setTimeout(resolve, text.startsWith("first") ? 30 : 1));
    return null;
  }
}

const say = (text: string): Utterance => ({ text, emotion: "neutral" });

async function settle(pipeline: SpeechPipeline): Promise<void> {
  for (let i = 0; i < 100 && !pipeline.isIdle(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe("SpeechPipeline", () => {
  it("performs cues in order even when later ones are ready first", async () => {
    const output = new RecordingOutput();
    const pipeline = new SpeechPipeline(new SlowTts(), new SafetyGate({ blocklist: [] }), output);
    pipeline.enqueue(say("first sentence"));
    pipeline.enqueue(say("second sentence"));
    await settle(pipeline);
    expect(output.played).toEqual(["first sentence", "second sentence"]);
  });

  it("drops sentences that fail the safety gate", async () => {
    const output = new RecordingOutput();
    const dropped: string[] = [];
    const moderator: Moderator = {
      model: "fake",
      review: async (s: string) => (s.includes("bad") ? { safe: false, reason: "test" } : { safe: true }),
    };
    const pipeline = new SpeechPipeline(new SlowTts(), new SafetyGate({ blocklist: [], moderator }), output, {
      onDropped: (text: string) => dropped.push(text),
    });
    pipeline.enqueue(say("a bad line"));
    pipeline.enqueue(say("a fine line"));
    await settle(pipeline);
    expect(output.played).toEqual(["a fine line"]);
    expect(dropped).toEqual(["a bad line"]);
  });

  it("lets trusted operator lines skip the moderator", async () => {
    const output = new RecordingOutput();
    const moderator: Moderator = { model: "fake", review: async () => ({ safe: false, reason: "no" }) };
    const pipeline = new SpeechPipeline(new SlowTts(), new SafetyGate({ blocklist: [], moderator }), output);
    pipeline.enqueue(say("operator says hi"), { trusted: true });
    await settle(pipeline);
    expect(output.played).toEqual(["operator says hi"]);
  });

  it("stop() discards everything queued", async () => {
    const output = new RecordingOutput();
    const pipeline = new SpeechPipeline(new SlowTts(), new SafetyGate({ blocklist: [] }), output);
    pipeline.enqueue(say("first, will be cut"));
    pipeline.enqueue(say("second, will be cut"));
    pipeline.stop();
    await settle(pipeline);
    expect(output.played).toEqual([]);
    expect(output.interrupted).toBe(1);
  });
});

/** Holds each cue "playing" until the test finishes it. */
class HeldOutput implements SpeechOutput {
  readonly sent: string[] = [];
  readonly dropped: string[] = [];
  private readonly playing: Array<{ cue: SpeechCue; resolve: () => void }> = [];
  play(cue: SpeechCue): Promise<void> {
    this.sent.push(cue.text);
    return new Promise((resolve) => this.playing.push({ cue, resolve }));
  }
  drop(ids: readonly string[]): void {
    for (const id of ids) {
      const i = this.playing.findIndex((p) => p.cue.id === id);
      if (i >= 0) {
        this.dropped.push(this.playing[i]!.cue.text);
        this.playing.splice(i, 1)[0]!.resolve();
      }
    }
  }
  interrupt(): void {
    for (const p of this.playing.splice(0)) p.resolve();
  }
  finishOne(): void {
    this.playing.shift()?.resolve();
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const turn = (turnId: string, first = false) => ({ turnId, turnKind: "react", originAt: 0, first });

describe("SpeechPipeline turns and timing (ADR-0022)", () => {
  it("keeps the next line on stage behind the one playing, and no more", async () => {
    const output = new HeldOutput();
    const pipeline = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), output);
    for (const text of ["one line", "two lines", "three lines"]) pipeline.enqueue(say(text), { meta: turn("t1") });
    await flush();
    expect(output.sent).toEqual(["one line", "two lines"]);
    expect(pipeline.nowPlaying()?.text).toBe("one line");
    expect(pipeline.upcoming()).toEqual(["one line", "two lines", "three lines"]);
    output.finishOne();
    await flush();
    expect(output.sent).toEqual(["one line", "two lines", "three lines"]);
  });

  it("drops the rest of a turn after a blocked sentence, and refuses its later sentences", async () => {
    const output = new HeldOutput();
    const dropped: Array<[string, string]> = [];
    const moderator: Moderator = { model: "fake", review: async (s) => (s.includes("bad") ? { safe: false, reason: "test" } : { safe: true }) };
    const pipeline = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [], moderator }), output, {
      onDropped: (text, reason) => dropped.push([text, reason]),
    });
    pipeline.enqueue(say("first, fine"), { meta: turn("t1", true) });
    pipeline.enqueue(say("second, bad"), { meta: turn("t1") });
    pipeline.enqueue(say("third, relies on the second"), { meta: turn("t1") });
    pipeline.enqueue(say("another turn, fine"), { meta: turn("t2", true) });
    await flush();
    expect(pipeline.enqueue(say("fourth of the cut turn"), { meta: turn("t1") })).toBe(false);
    output.finishOne();
    await flush();
    expect(output.sent).toEqual(["first, fine", "another turn, fine"]);
    expect(dropped).toEqual([
      ["second, bad", "test"],
      ["third, relies on the second", "skipped after a blocked line"],
    ]);
  });

  it("makes way for higher-priority speech without cutting the line that's playing", async () => {
    const output = new HeldOutput();
    const pipeline = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), output);
    for (const text of ["filler one", "filler two", "filler three"]) pipeline.enqueue(say(text), { priority: 10, meta: turn("f") });
    await flush();
    expect(pipeline.preempt(40)).toBe(2);
    expect(output.dropped).toEqual(["filler two"]);
    expect(pipeline.enqueue(say("filler four"), { priority: 10, meta: turn("f") })).toBe(false);
    pipeline.enqueue(say("thanks for the rose"), { priority: 40, meta: turn("r") });
    output.finishOne();
    await flush();
    expect(output.sent).toEqual(["filler one", "filler two", "thanks for the rose"]);
    // Operator lines and equal priorities stay.
    pipeline.enqueue(say("operator line"), { trusted: true });
    expect(pipeline.preempt(40)).toBe(0);
  });

  it("drops a line whose moderator doesn't answer in time instead of stalling the show", async () => {
    const output = new HeldOutput();
    const moderator: Moderator = { model: "fake", review: (s) => (s.includes("slow") ? new Promise(() => {}) : Promise.resolve({ safe: true })) };
    const dropped: string[] = [];
    const pipeline = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [], moderator, timeoutMs: 20 }), output, {
      onDropped: (_text, reason) => dropped.push(reason),
    });
    pipeline.enqueue(say("a slow one"));
    pipeline.enqueue(say("a quick one"));
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(output.sent).toEqual(["a quick one"]);
    expect(dropped).toEqual(["moderator unavailable"]);
  });

  it("estimates how long until everything queued has been said", async () => {
    let t = 0;
    const output = new HeldOutput();
    const pipeline = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), output, {}, () => t);
    pipeline.enqueue(say("x".repeat(30))); // 2 s
    pipeline.enqueue(say("y".repeat(45))); // 3 s
    await flush();
    expect(pipeline.remainingMs()).toBe(5_000);
    t = 1_500;
    expect(pipeline.remainingMs()).toBe(3_500);
    pipeline.stop();
    expect(pipeline.remainingMs()).toBe(0);
    expect(pipeline.isIdle()).toBe(true);
  });
});
