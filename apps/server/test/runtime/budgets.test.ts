import { describe, expect, it } from "bun:test";
import { PLANS } from "@tik-live/shared";
import { Limiter } from "../../src/runtime/voice/tts";
import { UsageMeter } from "../../src/runtime/usage";

describe("daily AI spend", () => {
  it("adds up today's estimated cost and starts over at midnight UTC", () => {
    let now = Date.parse("2026-10-16T23:59:00Z");
    const meter = new UsageMeter(() => now);
    meter.seedToday("2026-10-16", 5);
    meter.record({ kind: "turn", model: "claude-opus-5-5", inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
    expect(meter.spentToday()).toBeGreaterThan(5);
    now = Date.parse("2026-10-17T00:01:00Z");
    expect(meter.spentToday()).toBe(0);
  });

  it("counts what the voice costs toward the daily cap", () => {
    const meter = new UsageMeter(() => Date.parse("2026-10-16T12:00:00Z"));
    meter.record({ kind: "tts", characters: 40, costUsd: 0.0002 });
    meter.record({ kind: "tts", characters: 10 });
    expect(meter.spentToday()).toBeCloseTo(0.0002, 10);
    expect(meter.drain()).toMatchObject({ ttsCharacters: 50, costUsd: 0.0002 });
    // Voice isn't counted as Claude tokens.
    expect(meter.tokensLastHour()).toBe(0);
  });

  it("every paid plan caps daily spend and names its models", () => {
    for (const id of ["free", "creator", "pro"] as const) {
      expect(Number.isFinite(PLANS[id].limits.dailySpendCapUsd)).toBe(true);
      expect(PLANS[id].models.host).toMatch(/^claude-/);
    }
    expect(PLANS["self-hosted"].limits.dailySpendCapUsd).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("Limiter", () => {
  it("runs at most `limit` tasks at once, in order", async () => {
    const limiter = new Limiter(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limiter.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await Bun.sleep(10);
          order.push(n);
          running--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});
