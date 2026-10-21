import { midiToHz, type Sound } from "@tik-live/shared";
import { adsr, Patch, sweep, voice } from "./synth";

/**
 * Sound effects for show moments (ADR-0024), synthesized on the spot: no
 * samples. Each is under two seconds. Usually reached through
 * `MusicPlayer.sfx` (see music.ts), which routes them into the stage mix.
 *
 *   const board = new SoundBoard(() => ({ ctx, input }));
 *   board.play("win");   // false when rate-limited, too busy or no audio
 */
export interface SoundBus {
  ctx: BaseAudioContext;
  input: AudioNode;
}

/** The same sound at most this many times a second. */
const PER_SECOND = 3;
/** Sounds overlapping at once. */
const MAX_ACTIVE = 6;

export class SoundBoard {
  private readonly recent = new Map<Sound, number[]>();
  private readonly ends: number[] = [];

  constructor(
    private readonly bus: () => SoundBus | null,
    private readonly now: () => number = () => performance.now(),
    private readonly onPlay?: () => void,
  ) {}

  play(sound: Sound): boolean {
    const now = this.now();
    const times = this.recent.get(sound) ?? [];
    while (times.length && now - (times[0] as number) >= 1000) times.shift();
    if (times.length >= PER_SECOND) return false;
    const bus = this.bus();
    // A sound that would only play after "tap for sound" would be stale by then.
    if (!bus || ("state" in bus.ctx && bus.ctx.state === "suspended")) return false;
    const t = bus.ctx.currentTime;
    if (this.active(t) >= MAX_ACTIVE) return false;
    times.push(now);
    this.recent.set(sound, times);
    this.ends.push(playSound(bus.ctx, bus.input, sound, t + 0.01));
    this.onPlay?.();
    return true;
  }

  /** True while a sound is still ringing at audio-clock time `t`. */
  busy(t: number): boolean {
    return this.active(t) > 0;
  }

  private active(t: number): number {
    for (let i = this.ends.length - 1; i >= 0; i--) if ((this.ends[i] as number) <= t) this.ends.splice(i, 1);
    return this.ends.length;
  }
}

/** Schedules `sound` at `t` into `out`; returns when it has finished. */
export function playSound(ctx: BaseAudioContext, out: AudioNode, sound: Sound, t: number): number {
  return RECIPES[sound](ctx, out, t);
}

type Recipe = (ctx: BaseAudioContext, out: AudioNode, t: number) => number;

/** Notes in sequence: [midi, offset, duration] with one instrument. */
function seq(ctx: BaseAudioContext, out: AudioNode, t: number, instrument: Parameters<typeof voice>[2], notes: ReadonlyArray<readonly [number, number, number]>, vel: number): number {
  let end = t;
  for (const [midi, at, dur] of notes) end = Math.max(end, voice(ctx, out, instrument, midi, t + at, dur, vel).end);
  return end;
}

/** Brass-ish: two detuned saws through a lowpass that opens fast; `wah` closes it again. */
function brass(ctx: BaseAudioContext, out: AudioNode, midi: number, t: number, dur: number, vel: number, wah = false, vibrato = false): number {
  const p = new Patch(ctx, t, out);
  const hz = midiToHz(midi);
  const f = p.filter("lowpass", hz, 2, p.out);
  const a = p.osc("sawtooth", hz, f);
  const b = p.osc("sawtooth", hz, f, 9);
  f.frequency.setValueAtTime(hz, t);
  f.frequency.linearRampToValueAtTime(Math.min(hz * 6, 5000), t + 0.05);
  f.frequency.setTargetAtTime(wah ? hz * 1.1 : hz * 2.5, t + 0.06, wah ? dur * 0.4 : 0.12);
  if (vibrato) {
    const depth = p.gain(20);
    p.osc("sine", 6, depth);
    depth.connect(a.detune);
    depth.connect(b.detune);
  }
  adsr(p.out.gain, t, 0.18 * vel, 0.025, 0.2, 0.75, t + dur, 0.07);
  return p.play(t + dur + 0.45).end;
}

/** Noise through a filter, gated by a curve of decaying hits: rolls and applause in four nodes. */
function hits(ctx: BaseAudioContext, out: AudioNode, t: number, seconds: number, type: BiquadFilterType, hz: number, q: number, list: ReadonlyArray<readonly [number, number]>, tau: number): number {
  const p = new Patch(ctx, t, out);
  p.out.gain.value = 1;
  const gate = p.gain(0, p.out);
  p.noise(p.filter(type, hz, q, gate));
  const rate = 1000;
  const curve = new Float32Array(Math.ceil(seconds * rate));
  for (const [at, peak] of list) {
    for (let i = Math.max(0, Math.round(at * rate)); i < curve.length; i++) {
      const v = peak * Math.exp(-(i / rate - at) / tau);
      if (v < 1e-4) break;
      curve[i] = (curve[i] as number) + v;
    }
  }
  gate.gain.setValueCurveAtTime(curve, t, seconds);
  return p.play(t + seconds).end;
}

/** A snare roll that speeds up a little and swells. */
function roll(seconds: number, from: number, to: number): Array<[number, number]> {
  const list: Array<[number, number]> = [];
  for (let at = 0, gap = 0.05; at < seconds; at += gap, gap = Math.max(0.032, gap * 0.985)) list.push([at, from + (to - from) * (at / seconds)]);
  return list;
}

function crash(ctx: BaseAudioContext, out: AudioNode, t: number, vel: number, length: number): number {
  const p = new Patch(ctx, t, out);
  p.noise(p.filter("highpass", 4000, 0.5, p.out));
  return p.play(adsr(p.out.gain, t, 0.35 * vel, 0.002, 0.3, 0, t + length, 0.05)).end;
}

/** Seeded, so applause is the same every time (and in tests). */
function random(seed: number): () => number {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** An air horn blast: a dissonant cluster of brassy saws whose pitch sags a little as the air runs out. */
function horn(ctx: BaseAudioContext, out: AudioNode, t: number, dur: number): number {
  let end = t;
  for (const midi of [69, 70, 74]) {
    const p = new Patch(ctx, t, out);
    const hz = midiToHz(midi);
    const f = p.filter("lowpass", hz * 5, 1.4, p.out);
    for (const o of [p.osc("sawtooth", hz, f), p.osc("square", hz, f, 14)]) {
      o.frequency.setValueAtTime(hz * 1.03, t);
      o.frequency.linearRampToValueAtTime(hz, t + 0.04);
      o.frequency.linearRampToValueAtTime(hz * 0.97, t + dur);
    }
    end = Math.max(end, p.play(adsr(p.out.gain, t, 0.09, 0.012, 0.3, 0.85, t + dur, 0.04)).end);
  }
  return end;
}

const RECIPES: Record<Sound, Recipe> = {
  pop(ctx, out, t) {
    const p = new Patch(ctx, t, out);
    const o = p.osc("sine", 260, p.out);
    o.frequency.setValueAtTime(260, t);
    o.frequency.exponentialRampToValueAtTime(900, t + 0.06);
    return p.play(adsr(p.out.gain, t, 1.2, 0.002, 0.04, 0, t + 0.2, 0.01)).end;
  },
  chime: (ctx, out, t) =>
    seq(ctx, out, t, "bell", [
      [84, 0, 0.35],
      [88, 0.06, 0.35],
      [91, 0.12, 0.35],
    ], 0.55),
  whoosh(ctx, out, t) {
    const p = new Patch(ctx, t, out);
    const f = p.filter("bandpass", 250, 1.5, p.out);
    p.noise(f);
    f.frequency.setValueAtTime(250, t);
    f.frequency.exponentialRampToValueAtTime(2800, t + 0.35);
    f.frequency.exponentialRampToValueAtTime(500, t + 0.7);
    const g = p.out.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(0.6, t + 0.3);
    g.setTargetAtTime(0, t + 0.35, 0.12);
    return p.play(t + 0.9).end;
  },
  tick(ctx, out, t) {
    const p = new Patch(ctx, t, out);
    p.osc("triangle", 1800, p.out);
    return p.play(adsr(p.out.gain, t, 1, 0.001, 0.012, 0, t + 0.08, 0.005)).end;
  },
  start: (ctx, out, t) =>
    Math.max(
      seq(ctx, out, t, "pluck", [
        [60, 0, 0.1],
        [67, 0.06, 0.1],
        [72, 0.12, 0.1],
        [76, 0.18, 0.1],
        [79, 0.24, 0.2],
      ], 0.7),
      seq(ctx, out, t, "bell", [[84, 0.3, 0.2]], 0.6),
    ),
  reveal(ctx, out, t) {
    const hit = t + 0.75;
    hits(ctx, out, t, 0.75, "bandpass", 2000, 0.6, roll(0.7, 0.06, 0.3), 0.03);
    voice(ctx, out, "kick", 36, hit, 0.2, 0.5);
    crash(ctx, out, hit, 0.6, 0.8);
    return seq(ctx, out, hit, "bell", [[72, 0, 0.15], [76, 0, 0.15], [79, 0, 0.15]], 0.4);
  },
  win: (ctx, out, t) =>
    Math.max(
      seq(ctx, out, t, "lead", [
        [72, 0, 0.07],
        [76, 0.08, 0.07],
        [79, 0.16, 0.07],
        [84, 0.24, 0.5],
        [88, 0.24, 0.5],
      ], 0.55),
      seq(ctx, out, t, "bell", [[84, 0.24, 0.3], [88, 0.24, 0.3]], 0.4),
    ),
  fail(ctx, out, t) {
    let end = t;
    const notes: ReadonlyArray<readonly [number, number, number]> = [
      [67, 0, 0.24],
      [66, 0.28, 0.24],
      [65, 0.56, 0.24],
      [64, 0.84, 0.6],
    ];
    for (const [midi, at, dur] of notes) end = Math.max(end, brass(ctx, out, midi, t + at, dur, 1, true, at > 0.8));
    return end;
  },
  fanfare(ctx, out, t) {
    let end = t;
    const stabs: ReadonlyArray<readonly [number[], number, number]> = [
      [[60, 64, 67], 0, 0.1],
      [[60, 64, 67], 0.14, 0.1],
      [[65, 69, 72], 0.28, 0.1],
      [[60, 64, 67, 72], 0.42, 0.7],
    ];
    for (const [chord, at, dur] of stabs) for (const midi of chord) end = Math.max(end, brass(ctx, out, midi, t + at, dur, 0.5));
    return end;
  },
  drumroll(ctx, out, t) {
    const hit = t + 1.1;
    hits(ctx, out, t, 1.1, "bandpass", 2000, 0.6, roll(1.05, 0.08, 0.32), 0.03);
    voice(ctx, out, "snare", 60, hit, 0.1, 0.7);
    return Math.max(voice(ctx, out, "kick", 36, hit, 0.1, 0.6).end, crash(ctx, out, hit, 0.4, 0.4));
  },
  applause(ctx, out, t) {
    const next = random(7);
    const swell = (at: number) => Math.min(1, at / 0.2) * Math.min(1, Math.max(0, (1.5 - at) / 0.6));
    let end = t;
    for (const hz of [1100, 1900, 3000]) {
      const claps: Array<[number, number]> = [];
      for (let at = next() * 0.03; at < 1.45; at += 0.02 + next() * 0.04) claps.push([at, (0.3 + next() * 0.3) * swell(at)]);
      end = Math.max(end, hits(ctx, out, t, 1.55, "bandpass", hz, 1.5, claps, 0.012));
    }
    return end;
  },
  // Hype mode for gifts (ADR-0046): the air horn's "BWAA BWA BWAAAA" and the hitmarker's click.
  airhorn: (ctx, out, t) => Math.max(horn(ctx, out, t, 0.2), horn(ctx, out, t + 0.27, 0.12), horn(ctx, out, t + 0.46, 0.65)),
  hitmarker(ctx, out, t) {
    const p = new Patch(ctx, t, out);
    const o = p.osc("triangle", 3200, p.out);
    o.frequency.setValueAtTime(3200, t);
    o.frequency.exponentialRampToValueAtTime(1900, t + 0.05);
    p.noise(p.filter("highpass", 5000, 0.7, p.out));
    return p.play(adsr(p.out.gain, t, 0.9, 0.001, 0.018, 0, t + 0.06, 0.01)).end;
  },
  levelup(ctx, out, t) {
    const p = new Patch(ctx, t, out);
    const o = p.osc("square", 523, p.out);
    const g = p.out.gain;
    g.setValueAtTime(0, t);
    const notes = [72, 76, 79, 84, 88, 91, 96];
    let at = t;
    for (const midi of notes) {
      o.frequency.setValueAtTime(midiToHz(midi), at);
      g.setValueAtTime(0.36, at);
      g.setValueAtTime(0.08, at + 0.045);
      at += 0.055;
    }
    // The top note rings out.
    sweep(g, at - 0.01, 0.36, 0, 0.08);
    return p.play(at + 0.5).end;
  },
};
