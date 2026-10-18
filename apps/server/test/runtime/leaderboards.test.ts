import { describe, expect, it } from "bun:test";
import { GIFT_WINDOW_MS, LIKE_WINDOW_MS, RollingBoard } from "../../src/runtime/leaderboards";
import { fakeClock } from "./helpers";

describe("RollingBoard", () => {
  it("ranks viewers by likes, most first", () => {
    const clock = fakeClock();
    const board = new RollingBoard(clock.now, LIKE_WINDOW_MS);
    board.add("a", "ana", 10);
    board.add("b", "bia", 25);
    board.add("a", "ana", 20);
    board.add("c", "caio", 5);
    expect(board.top(2)).toEqual([
      { name: "ana", value: 30 },
      { name: "bia", value: 25 },
    ]);
  });

  it("drops every like older than 15 minutes", () => {
    const clock = fakeClock();
    const board = new RollingBoard(clock.now, LIKE_WINDOW_MS);
    expect(LIKE_WINDOW_MS).toBe(15 * 60_000);
    board.add("a", "ana", 100);
    clock.advance(10 * 60_000);
    board.add("a", "ana", 5);
    board.add("b", "bia", 50);
    expect(board.top(3)).toEqual([
      { name: "ana", value: 105 },
      { name: "bia", value: 50 },
    ]);
    // Ana's first 100 are now 15 minutes old: only her 5 recent ones count.
    clock.advance(5 * 60_000);
    expect(board.top(3)).toEqual([
      { name: "bia", value: 50 },
      { name: "ana", value: 5 },
    ]);
    clock.advance(10 * 60_000);
    expect(board.top(3)).toEqual([]);
  });

  it("changes its revision when likes arrive or expire, not otherwise", () => {
    const clock = fakeClock();
    const board = new RollingBoard(clock.now, LIKE_WINDOW_MS);
    const start = board.revision();
    board.add("a", "ana", 1);
    const afterLike = board.revision();
    expect(afterLike).not.toBe(start);
    clock.advance(60_000);
    expect(board.revision()).toBe(afterLike);
    clock.advance(LIKE_WINDOW_MS);
    expect(board.revision()).not.toBe(afterLike);
    expect(board.top(1)).toEqual([]);
  });

  it("keeps up with a like storm without growing without bound", () => {
    const clock = fakeClock();
    const board = new RollingBoard(clock.now, LIKE_WINDOW_MS);
    for (let i = 0; i < 20_000; i++) {
      clock.advance(100);
      board.add(`v${i % 50}`, `viewer${i % 50}`, 1);
    }
    // 15 minutes at 10 likes a second is 9,000 likes in the window.
    const total = board.top(50).reduce((sum, row) => sum + row.value, 0);
    expect(total).toBe(9_000);
  });
});

describe("the gift ranking", () => {
  it("counts diamonds for an hour, then lets them go", () => {
    const clock = fakeClock();
    const board = new RollingBoard(clock.now, GIFT_WINDOW_MS);
    expect(GIFT_WINDOW_MS).toBe(60 * 60_000);
    board.add("a", "ana", 1_000);
    clock.advance(30 * 60_000);
    board.add("b", "bia", 300);
    board.add("a", "ana", 1);
    expect(board.top(3)).toEqual([
      { name: "ana", value: 1_001 },
      { name: "bia", value: 300 },
    ]);
    clock.advance(30 * 60_000);
    expect(board.top(3)).toEqual([
      { name: "bia", value: 300 },
      { name: "ana", value: 1 },
    ]);
  });
});
