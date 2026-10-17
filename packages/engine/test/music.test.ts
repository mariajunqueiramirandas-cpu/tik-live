import { describe, expect, test } from "bun:test";
import { MAX_TRACK_SECONDS, MUSIC_LIBRARY, musicTrackSchema, passSeconds, type MusicTrack } from "@tik-live/shared";
import { MusicPlayer, scheduleTrack, stepTime } from "../src/audio/music";
import { FakeAudioContext, ManualInterval } from "./music-fakes";

const track = (over: Partial<MusicTrack> & Pick<MusicTrack, "parts">): MusicTrack => ({ title: "Test", bpm: 120, bars: 1, repeat: 1, swing: 0, ...over });
const part = (instrument: MusicTrack["parts"][number]["instrument"], pattern: string, volume = 0.8) => ({ instrument, pattern, volume });

describe("scheduleTrack", () => {
  test("steps are sixteenths at the track's tempo", () => {
    // 120 bpm: a beat is 0.5 s, a sixteenth 0.125 s.
    const { events, duration } = scheduleTrack(track({ parts: [part("kick", "x . . . x . . . x . . . x . . .")] }));
    expect(events.map((e) => e.time)).toEqual([0, 0.5, 1, 1.5]);
    expect(duration).toBe(2);
    expect(duration).toBe(passSeconds(120, 1));
  });

  test("swing pushes odd sixteenths late and leaves even ones alone", () => {
    expect(stepTime(0, 0.125, 0.4)).toBe(0);
    expect(stepTime(1, 0.125, 0.4)).toBeCloseTo(0.125 * 1.2, 9);
    expect(stepTime(2, 0.125, 0.4)).toBe(0.25);
    const { events } = scheduleTrack(track({ swing: 0.6, parts: [part("hat", "x x x x")] }));
    expect(events.slice(0, 4).map((e) => +e.time.toFixed(4))).toEqual([0, 0.1625, 0.25, 0.4125]);
    // A swung note followed by a straight one is shorter than a step.
    expect(events[1]?.duration).toBeCloseTo(0.25 - 0.1625, 9);
  });

  test("holds lengthen the note before them; a hold after a rest is silence", () => {
    const { events } = scheduleTrack(track({ parts: [part("lead", "C4 - - . - D4 - . E4+G4 - . . . . . -")] }));
    expect(events.map((e) => [e.midi, e.time, e.duration])).toEqual([
      [60, 0, 0.375],
      [62, 0.625, 0.25],
      [64, 1, 0.25],
      [67, 1, 0.25],
    ]);
  });

  test("a hold at the start of a loop continues the note from the end of the last pass", () => {
    const { events } = scheduleTrack(track({ bars: 1, parts: [part("bass", "- - . . . . . C2")] }));
    // 8-step pattern looped twice; the C2 at step 7 holds through steps 8-9.
    expect(events.map((e) => [e.time, e.duration])).toEqual([
      [0.875, 0.375],
      [1.875, 0.125],
    ]);
  });

  test("short patterns loop to fill the track, and the piece plays `repeat` times", () => {
    const { events, duration } = scheduleTrack(track({ bars: 2, repeat: 3, parts: [part("kick", "x . . ."), part("bass", "C2 " + ". ".repeat(31))] }));
    expect(duration).toBe(12);
    expect(events.filter((e) => e.instrument === "kick")).toHaveLength(2 * 4 * 3);
    expect(events.filter((e) => e.instrument === "bass").map((e) => e.time)).toEqual([0, 4, 8]);
  });

  test("x plays the part's default note, drums take one hit per chord, perc keeps pitches", () => {
    const { events } = scheduleTrack(track({ parts: [part("bass", "x"), part("snare", "C4+E4"), part("perc", "C4+G4")] }));
    const first = events.filter((e) => e.time === 0);
    expect(first.filter((e) => e.instrument === "bass").map((e) => e.midi)).toEqual([36]);
    expect(first.filter((e) => e.instrument === "snare")).toHaveLength(1);
    expect(first.filter((e) => e.instrument === "perc").map((e) => e.midi)).toEqual([60, 67]);
  });

  test("events are sorted by time across parts and carry the part's volume", () => {
    const { events } = scheduleTrack(track({ parts: [part("hat", ". x", 0.3), part("kick", "x .", 0.9)] }));
    for (let i = 1; i < events.length; i++) expect(events[i]!.time).toBeGreaterThanOrEqual(events[i - 1]!.time);
    expect(events[0]).toMatchObject({ instrument: "kick", velocity: 0.9 });
    expect(events[1]).toMatchObject({ instrument: "hat", velocity: 0.3 });
  });

  test("nothing starts or rings past MAX_TRACK_SECONDS, even if repeat wasn't clamped", () => {
    // 60 bpm, 8 bars = 32 s a pass; 8 repeats would be 256 s.
    const { events, duration } = scheduleTrack(track({ bpm: 60, bars: 8, repeat: 8, parts: [part("pad", "C4 " + "- ".repeat(127))] }));
    expect(duration).toBe(MAX_TRACK_SECONDS);
    expect(events.at(-1)!.time + events.at(-1)!.duration).toBeLessThanOrEqual(MAX_TRACK_SECONDS);
    expect(events.map((e) => e.time)).toEqual([0, 32]);
    expect(events[1]!.duration).toBe(13);
  });

  test("every library track schedules within the limit", () => {
    for (const [name, input] of Object.entries(MUSIC_LIBRARY)) {
      const parsed = musicTrackSchema.parse(input);
      const { events, duration } = scheduleTrack(parsed);
      expect(events.length, name).toBeGreaterThan(10);
      expect(duration, name).toBeCloseTo(passSeconds(parsed.bpm, parsed.bars) * parsed.repeat, 9);
      expect(duration, name).toBeLessThanOrEqual(MAX_TRACK_SECONDS);
      for (const e of events) expect(e.duration, name).toBeGreaterThan(0);
    }
  });

  test("an invalid pattern is skipped, not thrown on", () => {
    expect(scheduleTrack(track({ parts: [part("lead", "H9 ?"), part("kick", "x")] })).events.every((e) => e.instrument === "kick")).toBe(true);
  });
});

function setup(speaking = false) {
  const ctx = new FakeAudioContext();
  const mixNode = { connect: () => undefined };
  const host = { speaking, mixInput: () => ({ context: ctx as unknown as BaseAudioContext, node: mixNode as unknown as AudioNode }) };
  const timer = new ManualInterval();
  let clock = 0;
  const player = new MusicPlayer(host, { every: timer.every, now: () => clock });
  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += 0.025) {
      ctx.advance(0.025);
      clock += 25;
      timer.tick();
    }
  };
  return { ctx, host, timer, player, run, mixNode };
}

const lofi = musicTrackSchema.parse(MUSIC_LIBRARY["lofi-night"]);
const synthwave = musicTrackSchema.parse(MUSIC_LIBRARY["synthwave-drive"]);

describe("MusicPlayer", () => {
  test("builds nothing until the first sound", () => {
    let asked = 0;
    const player = new MusicPlayer({ mixInput: () => (asked++, null) });
    expect(player.level()).toBe(0);
    expect(player.nowPlaying()).toBeNull();
    expect(asked).toBe(0);
    player.play(lofi);
    expect(player.nowPlaying()).toBeNull();
  });

  test("routes into the host's mix and schedules only a short way ahead", () => {
    const { ctx, player, mixNode, run } = setup();
    player.play(synthwave);
    const duck = ctx.created.find((n) => n.outputs.has(mixNode));
    expect(duck).toBeDefined();
    // At t=0 only the first ~120 ms (plus the 80 ms start delay) is scheduled.
    expect(ctx.sources.every((s) => s.startAt <= 0.2 + 1e-9)).toBe(true);
    run(2);
    expect(ctx.sources.every((s) => s.startAt <= ctx.currentTime + 0.12 + 1e-9)).toBe(true);
    expect(ctx.sources.length).toBeGreaterThan(20);
  });

  test("caps polyphony and releases finished voices' nodes", () => {
    const { ctx, player, run } = setup();
    player.play(synthwave);
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      run(0.05);
      peak = Math.max(peak, player.voices);
    }
    expect(peak).toBeLessThanOrEqual(24);
    expect(ctx.disconnected).toBeGreaterThan(100);
  });

  test("nowPlaying counts down and clears when the track ends", () => {
    const { player, run, timer } = setup();
    player.play(musicTrackSchema.parse({ title: "Short", bpm: 120, bars: 1, parts: [{ instrument: "kick", pattern: "x" }] }));
    expect(player.nowPlaying()).toEqual({ title: "Short", endsAt: 2080 });
    run(1);
    expect(player.nowPlaying()?.endsAt).toBeCloseTo(2080, 0);
    run(1.2);
    expect(player.nowPlaying()).toBeNull();
    run(1);
    expect(timer.running).toBe(false);
  });

  test("handle takes music and sfx messages and nothing else", () => {
    const { player, ctx } = setup();
    expect(player.handle({ t: "music", track: lofi })).toBe(true);
    expect(player.nowPlaying()?.title).toBe(lofi.title);
    expect(player.handle({ t: "music", track: null })).toBe(true);
    expect(player.nowPlaying()).toBeNull();
    const before = ctx.sources.length;
    expect(player.handle({ t: "sfx", sound: "pop" })).toBe(true);
    expect(ctx.sources.length).toBeGreaterThan(before);
    expect(player.handle({ t: "stop" })).toBe(false);
  });

  test("a new track crossfades: the old one ramps out and is disconnected", () => {
    const { ctx, player, run } = setup();
    player.play(lofi);
    run(0.5);
    const firstGains = ctx.created.filter((n) => n.kind === "gain").length;
    player.play(synthwave);
    expect(player.nowPlaying()?.title).toBe(synthwave.title);
    const disconnectedBefore = ctx.disconnected;
    run(0.5);
    expect(ctx.disconnected).toBeGreaterThan(disconnectedBefore);
    expect(ctx.created.filter((n) => n.kind === "gain").length).toBeGreaterThan(firstGains);
  });

  test("ducks under speech and comes back up", () => {
    const { ctx, host, player, run } = setup();
    player.play(lofi);
    host.speaking = true;
    run(0.05);
    const targets = (ctx.created.filter((n) => n.kind === "gain") as unknown as Array<{ gain: { events: Array<[string, number, number]> } }>)
      .flatMap((n) => n.gain.events)
      .filter(([kind]) => kind === "target");
    expect(targets.some(([, v]) => v === 0.3)).toBe(true);
    expect(targets.some(([, v]) => v === 0.6)).toBe(true);
    host.speaking = false;
    run(0.05);
    const after = (ctx.created.filter((n) => n.kind === "gain") as unknown as Array<{ gain: { events: Array<[string, number, number]> } }>).flatMap((n) => n.gain.events);
    expect(after.filter(([kind, v]) => kind === "target" && v === 1).length).toBeGreaterThanOrEqual(2);
  });

  test("level and bands read the music analyser and stay in 0..1", () => {
    const { ctx, player } = setup();
    player.play(lofi);
    ctx.signal = 0.1;
    expect(player.level()).toBeCloseTo(0.3, 5);
    ctx.signal = 1;
    expect(player.level()).toBe(1);
    const bands = player.bands(new Float32Array(8));
    expect([...bands].every((b) => b >= 0 && b <= 1)).toBe(true);
  });

  test("destroy stops the scheduler and disconnects the buses", () => {
    const { player, timer, ctx } = setup();
    player.play(lofi);
    expect(timer.running).toBe(true);
    const before = ctx.disconnected;
    player.destroy();
    expect(timer.running).toBe(false);
    expect(ctx.disconnected).toBeGreaterThanOrEqual(before + 7);
    expect(player.nowPlaying()).toBeNull();
  });
});
