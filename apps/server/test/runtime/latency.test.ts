import { describe, expect, it } from "bun:test";
import { LatencyTracker } from "../../src/runtime/latency";

describe("LatencyTracker", () => {
  it("reports the median of each stage of a reply, from waiting for the turn to the line before it", () => {
    const tracker = new LatencyTracker();
    expect(tracker.summary()).toBeNull();
    tracker.record(2_000, { waitMs: 300, writeMs: 900, voiceMs: 600, queueMs: 200 });
    tracker.record(3_000, { waitMs: 1_300, writeMs: 1_000, voiceMs: 500, queueMs: 200 });
    tracker.record(2_500, { waitMs: 500, writeMs: 800, voiceMs: 700, queueMs: 500 });
    tracker.record(1_500); // an older cue without timestamps still counts overall
    expect(tracker.summary()).toEqual({
      p50: 2_500,
      p95: 3_000,
      samples: 4,
      stages: { waitMs: 500, writeMs: 900, voiceMs: 600, queueMs: 200 },
    });
  });

  it("ignores stages it can't trust", () => {
    const tracker = new LatencyTracker();
    tracker.record(1_000, { waitMs: Number.NaN, writeMs: 1, voiceMs: 1, queueMs: 1 });
    expect(tracker.summary()?.stages).toBeNull();
  });
});
