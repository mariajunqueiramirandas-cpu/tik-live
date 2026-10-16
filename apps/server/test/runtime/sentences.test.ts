import { describe, expect, it } from "bun:test";
import { SentenceSplitter, toUtterance } from "../../src/runtime/brain/sentences";

function split(chunks: string[]): string[] {
  const splitter = new SentenceSplitter();
  const out = chunks.flatMap((chunk) => splitter.push(chunk));
  return [...out, ...splitter.flush()];
}

describe("SentenceSplitter", () => {
  it("emits sentences as soon as they are complete", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("[happy] Thanks Maria for the roses! You")).toEqual(["[happy] Thanks Maria for the roses!"]);
    expect(splitter.push(" are amazing. And")).toEqual(["You are amazing."]);
    expect(splitter.flush()).toEqual(["And"]);
  });

  it("does not split decimals, domains or abbreviations", () => {
    expect(split(["Version 3.5 is out, e.g. today. Wow okay then."])).toEqual([
      "Version 3.5 is out, e.g. today.",
      "Wow okay then.",
    ]);
  });

  it("waits for trailing punctuation to settle mid-stream", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("Wait what?")).toEqual([]);
    expect(splitter.push("! That is wild.")).toEqual(["Wait what?!"]);
    expect(splitter.flush()).toEqual(["That is wild."]);
  });

  it("merges very short fragments into the next sentence", () => {
    expect(split(["Hi! ", "Welcome to the stream, everyone. "])).toEqual(["Hi! Welcome to the stream, everyone."]);
  });
});

describe("toUtterance", () => {
  it("reads a leading emotion tag", () => {
    expect(toUtterance("[excited] Wow, a Lion!")).toEqual({ text: "Wow, a Lion!", emotion: "excited" });
  });

  it("falls back to the previous emotion and ignores unknown tags", () => {
    expect(toUtterance("[angry] Hmm.", "happy")).toEqual({ text: "Hmm.", emotion: "happy" });
  });

  it("strips stage directions, markdown and emoji", () => {
    expect(toUtterance("*giggles* That is **so** cool 😂🔥 #blessed")).toEqual({
      text: "That is so cool blessed",
      emotion: "neutral",
    });
  });

  it("does not leave a gap where an emoji was removed", () => {
    expect(toUtterance("Joe 🎮, thank you!")?.text).toBe("Joe, thank you!");
  });

  it("returns nothing when no speakable text remains", () => {
    expect(toUtterance("[happy] 🎉🎉")).toBeUndefined();
  });
});
