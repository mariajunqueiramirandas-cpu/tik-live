import { describe, expect, it } from "bun:test";
import { fanLevel, fanXp, levelOf, xpForLevel } from "../../src/runtime/brain/fans";

const counts = (over: Partial<{ visits: number; messages: number; diamonds: number; follows: number; shares: number }> = {}) => ({
  visits: 1,
  messages: 0,
  diamonds: 0,
  follows: 0,
  shares: 0,
  ...over,
});

describe("fan levels (ADR-0037)", () => {
  it("starts everyone at level 1 and spaces the levels out a little more each time", () => {
    expect(levelOf(undefined)).toBe(1);
    expect(levelOf(counts())).toBe(1);
    expect([1, 2, 3, 4, 5].map(xpForLevel)).toEqual([0, 50, 150, 300, 500]);
    for (const level of [1, 2, 3, 10, 40]) {
      expect(fanLevel(xpForLevel(level))).toBe(level);
      expect(fanLevel(xpForLevel(level) - 1)).toBe(Math.max(1, level - 1));
    }
    expect(fanLevel(10_000_000)).toBe(99);
  });

  it("counts coming back, chatting, following, sharing and gifts, and can't be farmed by spam", () => {
    expect(fanXp(counts({ visits: 2 }))).toBe(50);
    expect(fanXp(counts({ messages: 10 }))).toBe(45);
    expect(fanXp(counts({ messages: 500 }))).toBe(fanXp(counts({ messages: 30 }))); // one stream counts 30 messages at most
    expect(fanXp(counts({ follows: 3 }))).toBe(65); // following counts once
    expect(fanXp(counts({ shares: 50 }))).toBe(70);
    expect(levelOf(counts({ diamonds: 1_000 }))).toBe(11); // a Galaxy
    expect(levelOf(counts({ visits: 10, messages: 100 }))).toBe(4); // a regular who chats
  });
});
