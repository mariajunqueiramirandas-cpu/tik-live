import { describe, expect, it } from "bun:test";
import { nextTarget, StreamGoals } from "../../src/runtime/goals";

describe("stream goals (ADR-0036)", () => {
  it("climbs a ladder on its own, or steps by the creator's number", () => {
    expect(nextTarget("likes", 0)).toBe(500);
    expect(nextTarget("likes", 500)).toBe(1_000);
    expect(nextTarget("likes", 99_999)).toBe(100_000);
    expect(nextTarget("likes", 250_000)).toBe(300_000);
    expect(nextTarget("gifts", 0)).toBe(100);
    expect(nextTarget("gifts", 12_000)).toBe(20_000);
    expect(nextTarget("likes", 0, 3_000)).toBe(3_000);
    expect(nextTarget("likes", 3_000, 3_000)).toBe(6_000);
    expect(nextTarget("likes", 7_100, 3_000)).toBe(9_000);
  });

  it("reaches a goal once, the highest one a jump passed, and sets the next", () => {
    const goals = new StreamGoals({ gifts: 50 });
    expect(goals.update("likes", 499)).toBeNull();
    expect(goals.update("likes", 1_200)).toEqual({ kind: "likes", target: 1_000, next: 2_500, level: 2 });
    expect(goals.update("likes", 1_300)).toBeNull();
    expect(goals.update("gifts", 160)).toEqual({ kind: "gifts", target: 150, next: 200, level: 2 });
    expect(goals.view()).toEqual([
      { kind: "likes", value: 1_300, target: 2_500, level: 2 },
      { kind: "gifts", value: 160, target: 200, level: 2 },
    ]);
    expect(goals.describe()).toBe("likes 1,300 of 2,500 (goal 2); gifts 160 of 200 diamonds (goal 2)");
  });

  it("takes a baseline or a new target without a party, and starts over on a new stream", () => {
    const goals = new StreamGoals();
    goals.baseline("likes", 7_000);
    expect(goals.view()[0]).toEqual({ kind: "likes", value: 7_000, target: 10_000, level: 1 });
    expect(goals.setSteps({ likes: 20_000 })).toBe(true);
    expect(goals.view()[0]?.target).toBe(20_000); // the creator's number is the first goal
    expect(goals.setSteps({ likes: 20_000 })).toBe(false);
    expect(goals.setSteps({ likes: 5_000 })).toBe(true);
    expect(goals.view()[0]?.target).toBe(10_000); // already past 5,000: its next multiple
    goals.reset();
    expect(goals.view()[0]).toEqual({ kind: "likes", value: 0, target: 5_000, level: 1 });
  });
});
