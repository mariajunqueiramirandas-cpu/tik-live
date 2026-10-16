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
