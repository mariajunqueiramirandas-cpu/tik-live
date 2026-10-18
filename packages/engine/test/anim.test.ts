import { describe, expect, it } from "bun:test";
import { createRandom } from "../src/anim/random";
import { percentile, QualityGovernor, SampleRing } from "../src/anim/governor";
import { Spring, SPRINGS } from "../src/anim/spring";

describe("Spring", () => {
  it("settles on its target", () => {
    const spring = new Spring(0, SPRINGS.gentle);
    spring.target = 1;
    for (let i = 0; i < 240; i++) spring.step(1 / 60);
    expect(spring.value).toBeCloseTo(1, 3);
    expect(spring.settled()).toBe(true);
  });

  it("moves the same at 30, 60 and 144 fps", () => {
    const run = (fps: number) => {
      const spring = new Spring(0, SPRINGS.bouncy);
      spring.target = 1;
      const frames = Math.round(fps * 0.5);
      for (let i = 0; i < frames; i++) spring.step(1 / fps);
      return spring.value;
    };
    const at60 = run(60);
    expect(run(30)).toBeCloseTo(at60, 2);
    expect(run(144)).toBeCloseTo(at60, 2);
  });

  it("retargets mid-flight without jumping", () => {
    const spring = new Spring(0, SPRINGS.snappy);
    spring.target = 1;
    for (let i = 0; i < 6; i++) spring.step(1 / 60);
    const before = spring.value;
    spring.target = -1;
    spring.step(1 / 60);
    expect(Math.abs(spring.value - before)).toBeLessThan(0.1);
  });

  it("clamps huge steps so a stalled tab can't explode it", () => {
    const spring = new Spring(0, SPRINGS.quick);
    spring.target = 1;
    spring.step(30);
    expect(Number.isFinite(spring.value)).toBe(true);
    expect(Math.abs(spring.value)).toBeLessThan(2);
  });
});

describe("createRandom", () => {
  it("is deterministic per seed", () => {
    const a = createRandom(42);
    const b = createRandom(42);
    const c = createRandom(43);
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect([c(), c(), c()]).not.toEqual(seqA);
    for (const v of seqA) expect(v >= 0 && v < 1).toBe(true);
  });
});

describe("SampleRing", () => {
  it("computes percentiles over the most recent samples", () => {
    const ring = new SampleRing(5);
    for (const v of [100, 1, 2, 3, 4, 5]) ring.push(v);
    expect(ring.size).toBe(5);
    expect(ring.percentile(0.5)).toBe(3);
    expect(ring.percentile(0.5, 2)).toBe(5);
    expect(ring.percentile(1)).toBe(5);
  });

  it("matches the plain-array percentile", () => {
    const random = createRandom(7);
    const values = Array.from({ length: 50 }, () => random() * 40);
    const ring = new SampleRing(50);
    for (const v of values) ring.push(v);
    for (const q of [0.25, 0.5, 0.95]) expect(ring.percentile(q)).toBe(percentile(values, q));
  });
});

describe("QualityGovernor", () => {
  const feed = (governor: QualityGovernor, intervalMs: number, workMs: number, seconds: number, start: number) => {
    let now = start;
    let changed = false;
    while (now < start + seconds * 1000) {
      now += intervalMs;
      changed = governor.record(intervalMs, workMs, now) || changed;
    }
    return { now, changed };
  };

  it("steps down after sustained dropped frames and back up after headroom", () => {
    const governor = new QualityGovernor();
    let { now } = feed(governor, 16.7, 4, 2, 0);
    expect(governor.level).toBe(0);
    ({ now } = feed(governor, 33.4, 30, 3, now));
    expect(governor.level).toBe(1);
    ({ now } = feed(governor, 16.7, 3, 14, now));
    expect(governor.level).toBe(0);
  });

  it("climbs from high to ultra, which supersamples, once there's room", () => {
    const governor = new QualityGovernor(1);
    expect(governor.settings.renderScale).toBe(1);
    feed(governor, 16.7, 3, 14, 0);
    expect(governor.level).toBe(0);
    expect(governor.settings.renderScale).toBe(1.5);
  });

  it("treats a steady 30 fps (OBS) as normal, not as dropping", () => {
    const governor = new QualityGovernor();
    feed(governor, 33.3, 5, 10, 0);
    expect(governor.level).toBe(0);
    expect(governor.fps()).toBeCloseTo(30, 0);
  });

  it("never changes when locked", () => {
    const governor = new QualityGovernor(3, true);
    feed(governor, 50, 45, 10, 0);
    expect(governor.level).toBe(3);
    expect(governor.settings.renderScale).toBe(0.7);
  });

  it("ignores long gaps from hidden tabs", () => {
    const governor = new QualityGovernor();
    expect(governor.record(5000, 1, 5000)).toBe(false);
    expect(governor.fps()).toBe(0);
  });
});
