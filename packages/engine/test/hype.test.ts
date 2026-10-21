import { describe, expect, it } from "bun:test";
import { hueRgb, hypeFor, STAMPS } from "../src/stage/hype";

describe("hype mode (ADR-0046)", () => {
  it("gives every gift lights, sunglasses, a stamp and hitmarkers, and more of everything to bigger ones", () => {
    const tiers = ([0, 1, 2, 3] as const).map((tier) => hypeFor(tier));
    for (const level of tiers) {
      expect(level.lights).toBeGreaterThan(0);
      expect(level.glasses).toBeGreaterThan(0);
      expect(level.stamps).toBeGreaterThanOrEqual(1);
      expect(level.hits).toBeGreaterThanOrEqual(3);
    }
    for (let i = 1; i < tiers.length; i++) {
      const [before, after] = [tiers[i - 1]!, tiers[i]!];
      expect(after.lights).toBeGreaterThan(before.lights);
      expect(after.glasses).toBeGreaterThan(before.glasses);
      expect(after.hits).toBeGreaterThan(before.hits);
      expect(after.stamps).toBeGreaterThanOrEqual(before.stamps);
    }
    // Lasers from 10 diamonds up.
    expect(tiers.map((level) => level.lasers > 0)).toEqual([false, true, true, true]);
  });

  it("keeps the party going longer through a combo, up to a cap", () => {
    const one = hypeFor(0, 1);
    const three = hypeFor(0, 3);
    expect(three.lights).toBeGreaterThan(one.lights);
    expect(three.lasers).toBeGreaterThan(0); // three roses in a row bring the lasers out
    expect(three.hits).toBeGreaterThan(one.hits);
    expect(hypeFor(0, 5).stamps).toBe(one.stamps + 1);
    expect(hypeFor(3, 100).lights).toBe(hypeFor(3, 50).lights);
    expect(hypeFor(3, 100).stamps).toBeLessThanOrEqual(4);
  });

  it("walks the color wheel for the RGB lights", () => {
    const at = (h: number) => hueRgb(h, [0, 0, 0]).map((v) => Math.round(v * 1000) / 1000);
    expect(at(0)).toEqual([1, 0, 0]);
    expect(at(1 / 3)).toEqual([0, 1, 0]);
    expect(at(2 / 3)).toEqual([0, 0, 1]);
    expect(at(1.5)).toEqual(at(0.5));
  });

  it("has a stamp for every taste, all short enough to read in a second", () => {
    expect(new Set(STAMPS).size).toBe(STAMPS.length);
    for (const stamp of STAMPS) expect(stamp.length).toBeLessThanOrEqual(16);
  });
});
