import { describe, expect, it } from "vitest";
import {
  isGiftStreakInProgress,
  normalizeChat,
  normalizeGift,
  normalizeLike,
  normalizeViewerCount,
} from "../src/events/normalize.js";

const v3User = { id: "42", displayId: "maria.codes", nickname: "Maria" };

describe("normalize", () => {
  it("reads v3 chat payloads", () => {
    expect(normalizeChat({ user: v3User, content: " hi blip " }, 1)).toEqual({
      kind: "chat",
      at: 1,
      viewer: { id: "42", handle: "maria.codes", nickname: "Maria" },
      text: "hi blip",
    });
  });

  it("reads legacy chat payloads", () => {
    const event = normalizeChat({ user: { userId: "7", uniqueId: "joe" }, comment: "yo" }, 1);
    expect(event).toMatchObject({ viewer: { id: "7", handle: "joe", nickname: "joe" }, text: "yo" });
  });

  it("drops chat without a user or text", () => {
    expect(normalizeChat({ content: "hi" })).toBeUndefined();
    expect(normalizeChat({ user: v3User, content: "  " })).toBeUndefined();
    expect(normalizeChat(null)).toBeUndefined();
  });

  it("only counts a streakable gift when the streak ends", () => {
    const running = { user: v3User, gift: { name: "Rose", type: 1, diamondCount: 1 }, repeatCount: 4, repeatEnd: 0 };
    expect(isGiftStreakInProgress(running)).toBe(true);
    expect(normalizeGift(running)).toBeUndefined();

    const ended = { ...running, repeatCount: 5, repeatEnd: 1 };
    expect(normalizeGift(ended, 1)).toEqual({
      kind: "gift",
      at: 1,
      viewer: { id: "42", handle: "maria.codes", nickname: "Maria" },
      giftName: "Rose",
      count: 5,
      diamonds: 5,
    });
  });

  it("counts non-streakable gifts immediately", () => {
    const lion = { user: v3User, giftDetails: { giftName: "Lion", giftType: 2, diamondCount: 29999 }, repeatCount: 1 };
    expect(normalizeGift(lion)).toMatchObject({ giftName: "Lion", count: 1, diamonds: 29999 });
  });

  it("reads likes and viewer counts in both shapes", () => {
    expect(normalizeLike({ user: v3User, count: 3, total: "120" })).toMatchObject({ count: 3, total: 120 });
    expect(normalizeLike({ user: v3User, likeCount: 2, totalLikeCount: 9 })).toMatchObject({ count: 2, total: 9 });
    expect(normalizeViewerCount({ total: "57" })).toMatchObject({ count: 57 });
    expect(normalizeViewerCount({ viewerCount: 12 })).toMatchObject({ count: 12 });
  });
});
