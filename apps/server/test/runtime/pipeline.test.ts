import { describe, expect, it } from "bun:test";
import type { Utterance } from "../../src/runtime/brain/sentences";
import { SafetyGate, type Moderator } from "../../src/runtime/safety/gate";
import { SpeechPipeline, type SpeechCue, type SpeechOutput } from "../../src/runtime/voice/pipeline";
import type { AudioClip, TtsProvider } from "../../src/runtime/voice/tts";

class RecordingOutput implements SpeechOutput {
  played: string[] = [];
  interrupted = 0;
  async play(cue: SpeechCue): Promise<void> {
    this.played.push(cue.text);
  }
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

  it("drop() removes queued lines, never the one on stage, and cancels their synthesis", async () => {
    let release: () => void = () => {};
    const output: SpeechOutput = {
      play: (cue) => {
        played.push(cue.text);
        return new Promise((resolve) => (release = resolve));
      },
      interrupt: () => {},
    };
    const played: string[] = [];
    const aborted: string[] = [];
    const tts: TtsProvider = {
      name: "watch",
      synthesize: async (text, _emotion, signal) => {
        signal?.addEventListener("abort", () => aborted.push(text));
        await new Promise((resolve) => setTimeout(resolve, 5));
        return null;
      },
    };
    const meta = (turnKind: string) => ({ turnId: turnKind, turnKind, originAt: 0, first: false });
    const pipeline = new SpeechPipeline(tts, new SafetyGate({ blocklist: [] }), output);
    pipeline.enqueue(say("filler one"), { meta: meta("filler") });
    pipeline.enqueue(say("filler two"), { meta: meta("filler") });
    pipeline.enqueue(say("filler three"), { meta: meta("filler") });
    for (let i = 0; i < 20 && played.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(pipeline.upcoming()).toEqual(["filler one", "filler two", "filler three"]);

    expect(pipeline.drop((m) => m?.turnKind === "filler")).toBe(2);
    expect(aborted.sort()).toEqual(["filler three", "filler two"]);
    pipeline.enqueue(say("thanks for the rose"), { meta: meta("react") });
    release();
    for (let i = 0; i < 20 && played.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    release();
    await settle(pipeline);
    expect(played).toEqual(["filler one", "thanks for the rose"]);
  });

  it("puts operator lines right after the current sentence, in the order typed", async () => {
    const output = new RecordingOutput();
    const pipeline = new SpeechPipeline(new SlowTts(), new SafetyGate({ blocklist: [] }), output);
    pipeline.enqueue(say("host one"));
    pipeline.enqueue(say("host two"));
    pipeline.enqueue(say("operator one"), { trusted: true, front: true });
    pipeline.enqueue(say("operator two"), { trusted: true, front: true });
    await settle(pipeline);
    // "host one" is already on its way to the stage; the operator cuts in right after it.
    expect(output.played).toEqual(["host one", "operator one", "operator two", "host two"]);
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
