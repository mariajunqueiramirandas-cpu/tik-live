import { describe, expect, it } from "bun:test";
import { syllableCount, syllableEnvelope } from "../src/audio/envelope";
import { giftCameIn } from "../src/text/hud";
import { formatCount, formatCountdown, goalFraction, goalProgress, windowLabel } from "../src/text/kit";
import { layoutCaption, wordAtProgress } from "../src/text/layout";

// Monospace stand-in: every character is 0.5em wide.
const measure = (size: number) => (text: string) => text.length * size * 0.5;

describe("layoutCaption", () => {
  it("keeps short lines on one line at the largest size", () => {
    const layout = layoutCaption("Hello chat", { maxWidth: 900, maxLines: 3, fontSizes: [64, 56, 48], measure });
    expect(layout.lines).toBe(1);
    expect(layout.fontSize).toBe(64);
    expect(layout.words.map((w) => w.text)).toEqual(["Hello", "chat"]);
  });

  it("shrinks the font before exceeding the line limit", () => {
    const text = "This is a much longer caption that will not fit on three lines at the largest size, surely not";
    const layout = layoutCaption(text, { maxWidth: 600, maxLines: 3, fontSizes: [64, 56, 48], measure });
    expect(layout.fontSize).toBeLessThan(64);
    for (const width of layout.lineWidths) expect(width).toBeLessThanOrEqual(600);
  });

  it("balances lines instead of leaving a lonely last word", () => {
    const text = "one two three four five six seven";
    const layout = layoutCaption(text, { maxWidth: 32 * 12, maxLines: 3, fontSizes: [32], measure });
    expect(layout.lines).toBe(2);
    const [a, b] = layout.lineWidths as [number, number];
    expect(Math.abs(a - b)).toBeLessThanOrEqual(64); // greedy wrapping would give 368 vs 144
  });

  it("handles empty text", () => {
    const layout = layoutCaption("   ", { maxWidth: 900, maxLines: 3, fontSizes: [64], measure });
    expect(layout.words).toEqual([]);
  });
});

describe("wordAtProgress", () => {
  const words = [{ text: "a" }, { text: "longword" }, { text: "b" }];

  it("walks through words weighted by length", () => {
    expect(wordAtProgress(words, 0)).toBe(0);
    expect(wordAtProgress(words, 0.5)).toBe(1);
    expect(wordAtProgress(words, 0.99)).toBe(2);
    expect(wordAtProgress(words, 1)).toBe(3);
    expect(wordAtProgress([], 0.5)).toBe(-1);
  });
});

describe("syllable envelope", () => {
  it("counts vowel groups", () => {
    expect(syllableCount("hello")).toBe(2);
    expect(syllableCount("strength")).toBe(1);
    expect(syllableCount("animação")).toBe(4);
    expect(syllableCount("brr")).toBe(1);
  });

  it("opens the mouth during syllables and closes it outside the line", () => {
    const env = syllableEnvelope("hello there friend", 1800);
    expect(env(-1)).toBe(0);
    expect(env(1801)).toBe(0);
    const samples = Array.from({ length: 90 }, (_, i) => env(i * 20));
    expect(Math.max(...samples)).toBeGreaterThan(0.85);
    expect(Math.min(...samples)).toBeLessThan(0.4);
  });

  it("shapes the mouth from each syllable's vowel", () => {
    const env = syllableEnvelope("oo ee aa", 900);
    const shape = { round: 0, wide: 0 };
    // Three one-syllable words share the time with two pauses.
    const unit = 900 / (3 * 1.6);
    expect(env.shape(unit * 0.5, shape)).toEqual({ round: 1, wide: 0 });
    expect(env.shape(unit * 2.1, shape)).toEqual({ round: 0, wide: 1 });
    expect(env.shape(unit * 3.7, shape)).toEqual({ round: 0, wide: 0 });
  });
});

describe("heads-up panels", () => {
  it("counts down to what's up next in minutes and seconds", () => {
    expect(formatCountdown(154)).toBe("2:34");
    expect(formatCountdown(9.2)).toBe("0:10");
    expect(formatCountdown(59)).toBe("0:59");
    expect(formatCountdown(3_900)).toBe("1h05");
    expect(formatCountdown(0)).toBe("já já");
    expect(formatCountdown(-3)).toBe("já já");
  });

  it("writes counts the Brazilian way, and windows in minutes or hours", () => {
    expect(formatCount(1834)).toBe("1.834");
    expect(formatCount(12)).toBe("12");
    expect(formatCount(25_300)).toBe("25,3 mil");
    expect(windowLabel(15)).toBe("15 MIN");
    expect(windowLabel(60)).toBe("1 H");
  });

  it("knows a gift came in, and that old gifts aging out is not one", () => {
    const rows = [
      { name: "duda", value: 25_300 },
      { name: "lu", value: 1_200 },
    ];
    expect(giftCameIn([], rows)).toBe(true);
    expect(giftCameIn(rows, rows.map((row) => ({ ...row })))).toBe(false);
    expect(giftCameIn(rows, [rows[0]!, { name: "lu", value: 1_201 }])).toBe(true);
    expect(giftCameIn(rows, [rows[0]!])).toBe(false); // lu's gifts aged out of the hour
  });

  it("fills a goal's bar and writes its progress in Portuguese", () => {
    expect(goalProgress({ value: 3_240, target: 5_000 })).toBe("3.240 / 5.000");
    expect(goalProgress({ value: 25_300, target: 50_000 })).toBe("25,3 mil / 50 mil");
    expect(goalFraction({ value: 250, target: 1_000 })).toBe(0.25);
    expect(goalFraction({ value: 1_200, target: 1_000 })).toBe(1);
    expect(goalFraction({ value: 0, target: 500 })).toBe(0);
  });
});
