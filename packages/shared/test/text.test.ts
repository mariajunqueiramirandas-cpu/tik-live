import { describe, expect, it } from "bun:test";
import { clip, wellFormed, wellFormedDeep } from "../src/text";

/** Half an emoji serializes as a bare `\ud83d` escape: the Claude API's JSON parser refuses the whole request for it. */
const LONE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;

describe("clip", () => {
  it("never ends on half an emoji", () => {
    expect(clip("Ana 💖💖", 5)).toBe("Ana ");
    expect(clip("Ana 💖💖", 6)).toBe("Ana 💖");
    expect(JSON.stringify(clip("✨".repeat(3) + "🔥".repeat(20), 30))).not.toMatch(LONE);
  });

  it("leaves short text alone", () => {
    expect(clip("oi", 30)).toBe("oi");
  });
});

describe("wellFormed", () => {
  it("replaces unpaired surrogates and keeps whole emoji", () => {
    expect(wellFormed("a\uD83Db")).toBe("a\uFFFDb");
    expect(wellFormed("a\uDC96b")).toBe("a\uFFFDb");
    expect(wellFormed("Ana 💖")).toBe("Ana 💖");
  });

  it("cleans every string in a request's params", () => {
    const params = { model: "m", max_tokens: 10, messages: [{ role: "user", content: [{ type: "text", text: "oi \uD83D" }] }] };
    const clean = wellFormedDeep(params);
    expect(JSON.stringify(clean)).not.toMatch(LONE);
    expect(clean.messages[0]?.content[0]?.text).toBe("oi \uFFFD");
    expect(clean.max_tokens).toBe(10);
  });
});
