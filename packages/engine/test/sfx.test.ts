import { describe, expect, test } from "bun:test";
import { SOUNDS } from "@tik-live/shared";
import { playSound, SoundBoard } from "../src/audio/sfx";
import { FakeAudioContext } from "./music-fakes";

function board() {
  const ctx = new FakeAudioContext();
  const input = { connect: () => undefined } as unknown as AudioNode;
  let clock = 0;
  const sfx = new SoundBoard(() => ({ ctx: ctx as unknown as BaseAudioContext, input }), () => clock);
  return { ctx, sfx, tick: (ms: number) => ((clock += ms), ctx.advance(ms / 1000)) };
}

describe("SoundBoard", () => {
  test("every sound schedules nodes, ends within about two seconds and cleans up", () => {
    for (const sound of SOUNDS) {
      const ctx = new FakeAudioContext();
      const end = playSound(ctx as unknown as BaseAudioContext, { connect: () => undefined } as unknown as AudioNode, sound, 0);
      expect(ctx.sources.length, sound).toBeGreaterThan(0);
      expect(end, sound).toBeLessThanOrEqual(2.3);
      expect(ctx.created.length, sound).toBeLessThan(120);
      for (const s of ctx.sources) expect(s.stopAt, sound).toBeLessThanOrEqual(end + 1e-9);
      ctx.advance(3);
      expect(ctx.sounding(), sound).toBe(0);
      expect(ctx.disconnected, sound).toBeGreaterThan(0);
    }
  });

  test("the same sound plays at most three times a second; others still play", () => {
    const { sfx, tick } = board();
    expect([sfx.play("pop"), sfx.play("pop"), sfx.play("pop"), sfx.play("pop")]).toEqual([true, true, true, false]);
    expect(sfx.play("tick")).toBe(true);
    tick(1000);
    expect(sfx.play("pop")).toBe(true);
  });

  test("at most six sounds overlap", () => {
    const { sfx } = board();
    const played = ["applause", "applause", "drumroll", "drumroll", "fanfare", "fanfare", "win"].map((s) => sfx.play(s as (typeof SOUNDS)[number]));
    expect(played).toEqual([true, true, true, true, true, true, false]);
  });

  test("plays nothing while audio is locked, rather than a stale sound later", () => {
    const { ctx, sfx } = board();
    ctx.state = "suspended";
    expect(sfx.play("win")).toBe(false);
    expect(ctx.sources).toHaveLength(0);
  });

  test("shares one noise buffer per context", () => {
    const ctx = new FakeAudioContext();
    const out = { connect: () => undefined } as unknown as AudioNode;
    for (const sound of ["whoosh", "applause", "drumroll", "reveal"] as const) playSound(ctx as unknown as BaseAudioContext, out, sound, 0);
    expect(ctx.buffers).toBe(1);
  });
});
