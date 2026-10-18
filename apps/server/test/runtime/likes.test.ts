import { describe, expect, it } from "bun:test";
import { LIKE_WINDOW_MS, LikeBoard } from "../../src/runtime/likes";
import { fakeClock } from "./helpers";

describe("LikeBoard", () => {
  it("ranks viewers by likes, most first", () => {
    const clock = fakeClock();
    const board = new LikeBoard(clock.now);
    board.add("a", "ana", 10);
    board.add("b", "bia", 25);
    board.add("a", "ana", 20);
    board.add("c", "caio", 5);
    expect(board.top(2)).toEqual([
      { name: "ana", likes: 30 },
      { name: "bia", likes: 25 },
    ]);
  });

  it("drops every like older than 15 minutes", () => {
    const clock = fakeClock();
    const board = new LikeBoard(clock.now);
    expect(LIKE_WINDOW_MS).toBe(15 * 60_000);
    board.add("a", "ana", 100);
    clock.advance(10 * 60_000);
    board.add("a", "ana", 5);
    board.add("b", "bia", 50);
    expect(board.top(3)).toEqual([
      { name: "ana", likes: 105 },
      { name: "bia", likes: 50 },
    ]);
    // Ana's first 100 are now 15 minutes old: only her 5 recent ones count.
    clock.advance(5 * 60_000);
    expect(board.top(3)).toEqual([
      { name: "bia", likes: 50 },
      { name: "ana", likes: 5 },
    ]);
    clock.advance(10 * 60_000);
    expect(board.top(3)).toEqual([]);
  });

  it("changes its revision when likes arrive or expire, not otherwise", () => {
    const clock = fakeClock();
    const board = new LikeBoard(clock.now);
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
    const board = new LikeBoard(clock.now);
    for (let i = 0; i < 20_000; i++) {
      clock.advance(100);
      board.add(`v${i % 50}`, `viewer${i % 50}`, 1);
    }
    // 15 minutes at 10 likes a second is 9,000 likes in the window.
    const total = board.top(50).reduce((sum, row) => sum + row.likes, 0);
    expect(total).toBe(9_000);
  });
});
