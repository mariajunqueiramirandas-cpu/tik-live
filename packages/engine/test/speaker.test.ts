import { describe, expect, it } from "bun:test";
import type { AudioEngine, PlaybackHandle } from "../src/audio/audio";
import { Speaker, type Line } from "../src/audio/speaker";
import { wordAtProgress, wordAtTime } from "../src/text/layout";

/** Plays nothing; each line "plays" until the test ends it. */
class FakeAudio {
  readonly log: string[] = [];
  readonly leads: number[] = [];
  private end: (() => void) | null = null;
  prefetch(url: string): void {
    this.log.push(`prefetch ${url}`);
  }
  async play(text: string, _url: string | null, _ms: number, lead = 0.02): Promise<PlaybackHandle> {
    this.end?.();
    this.log.push(`play ${text}`);
    this.leads.push(lead);
    const done = new Promise<void>((resolve) => (this.end = resolve));
    return { done, duration: 1, elapsed: () => 0, stop: () => this.stop() };
  }
  stop(): void {
    this.end?.();
    this.end = null;
  }
  finish(): void {
    this.end?.();
  }
}

const line = (id: string, audioUrl: string | null = null): Line => ({ id, text: id, emotion: "neutral", audioUrl, durationMs: 1000 });
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup() {
  const audio = new FakeAudio();
  const spoken: string[] = [];
  const started: string[] = [];
  const speaker = new Speaker(audio as unknown as AudioEngine, {
    started: (l) => started.push(l.id),
    spoken: (id) => spoken.push(id),
  });
  return { audio, speaker, spoken, started };
}

describe("Speaker queue (ADR-0022)", () => {
  it("plays queued lines back to back without cutting one off", async () => {
    const { audio, speaker, spoken, started } = setup();
    speaker.enqueue(line("a", "/a"));
    speaker.enqueue(line("b", "/b"));
    await flush();
    // The second line's audio is fetched while the first plays.
    expect(audio.log).toEqual(["prefetch /a", "play a", "prefetch /b"]);
    expect(started).toEqual(["a"]);
    audio.finish();
    await flush();
    expect(spoken).toEqual(["a"]);
    expect(started).toEqual(["a", "b"]);
    expect(audio.leads).toEqual([0.02, 0.14]); // a breath between lines, not a round trip
    audio.finish();
    await flush();
    expect(spoken).toEqual(["a", "b"]);
  });

  it("drops queued lines that haven't started", async () => {
    const { audio, speaker, spoken } = setup();
    speaker.enqueue(line("a"));
    speaker.enqueue(line("b"));
    speaker.enqueue(line("c"));
    await flush();
    speaker.drop(["a", "b"]); // "a" is playing: it finishes
    audio.finish();
    await flush();
    audio.finish();
    await flush();
    expect(spoken).toEqual(["a", "c"]);
  });

  it("speak and stop cut off, and a stopped line never reports spoken", async () => {
    const { audio, speaker, spoken } = setup();
    speaker.enqueue(line("a"));
    speaker.enqueue(line("b"));
    await flush();
    speaker.speak(line("now"));
    await flush();
    expect(audio.log.at(-1)).toBe("play now");
    speaker.stop();
    await flush();
    expect(spoken).toEqual([]);
    expect(speaker.current).toBeNull();
    speaker.enqueue(line("after"));
    await flush();
    expect(audio.log.at(-1)).toBe("play after");
  });
});

describe("caption word timing", () => {
  it("follows the voice's word start times", () => {
    const starts = [0, 250, 900];
    expect(wordAtTime(starts, -5)).toBe(0);
    expect(wordAtTime(starts, 249)).toBe(0);
    expect(wordAtTime(starts, 250)).toBe(1);
    expect(wordAtTime(starts, 5_000)).toBe(2);
    expect(wordAtTime([], 10)).toBe(-1);
  });

  it("estimates pauses after punctuation when there are no timings", () => {
    const words = [{ text: "Wow." }, { text: "okay" }];
    // "Wow." carries a sentence pause, so it holds past the halfway point.
    expect(wordAtProgress(words, 0.6)).toBe(0);
    expect(wordAtProgress(words, 0.8)).toBe(1);
  });
});
