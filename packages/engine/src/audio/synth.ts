import { midiToHz, type Instrument } from "@tik-live/shared";

/**
 * Synth voices for music and sound effects (ADR-0024): plain WebAudio nodes,
 * no samples. A voice is a small node graph scheduled at an absolute time on
 * the audio clock; every node is stopped and disconnected when it ends, so
 * nothing piles up over a long show.
 */
export interface Voice {
  /** Audio-clock time when the voice is silent and its nodes are released. */
  readonly end: number;
  /** Fades the voice out quickly from `at` (voice stealing, track changes). */
  stop(at: number): void;
}

type Ctx = BaseAudioContext;

const NOISE = new WeakMap<Ctx, AudioBuffer>();

/** One second of white noise per context, built once and shared by every voice. */
export function noiseBuffer(ctx: Ctx): AudioBuffer {
  let buffer = NOISE.get(ctx);
  if (!buffer) {
    buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x2545f491;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = seed / 2147483648 - 1;
    }
    NOISE.set(ctx, buffer);
  }
  return buffer;
}

/** Freezes a param at its current value from `t` (Firefox lacks cancelAndHoldAtTime). */
export function hold(param: AudioParam, t: number): void {
  if ("cancelAndHoldAtTime" in param) param.cancelAndHoldAtTime(t);
  else (param as AudioParam).cancelScheduledValues(t);
}

/** Attack to `peak`, decay toward `peak * sustain`, release from `off`. Returns when it's silent. */
export function adsr(p: AudioParam, t: number, peak: number, attack: number, decay: number, sustain: number, off: number, release: number): number {
  const top = t + attack;
  const rel = Math.max(off, top);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, top);
  if (sustain < 1) p.setTargetAtTime(peak * sustain, top, decay);
  p.setTargetAtTime(0, rel, release);
  return rel + release * 6;
}

/** A filter or pitch sweep from `from` toward `to`. */
export function sweep(p: AudioParam, t: number, from: number, to: number, tau: number): void {
  p.setValueAtTime(from, t);
  p.setTargetAtTime(to, t, tau);
}

/** Builds one voice's graph; sources start at `t` as they're created. */
export class Patch implements Voice {
  readonly out: GainNode;
  end = 0;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly nodes: AudioNode[] = [];

  constructor(
    readonly ctx: Ctx,
    readonly t: number,
    dest: AudioNode,
  ) {
    this.out = this.gain(0, dest);
  }

  gain(value: number, to?: AudioNode | AudioParam): GainNode {
    const node = this.ctx.createGain();
    node.gain.value = value;
    return this.link(node, to);
  }

  filter(type: BiquadFilterType, hz: number, q: number, to: AudioNode): BiquadFilterNode {
    const node = this.ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = hz;
    node.Q.value = q;
    return this.link(node, to);
  }

  osc(type: OscillatorType, hz: number, to: AudioNode | AudioParam, detune = 0): OscillatorNode {
    const node = this.ctx.createOscillator();
    node.type = type;
    node.frequency.value = hz;
    node.detune.value = detune;
    node.start(this.t);
    this.sources.push(node);
    return this.link(node, to);
  }

  noise(to: AudioNode): AudioBufferSourceNode {
    const node = this.ctx.createBufferSource();
    node.buffer = noiseBuffer(this.ctx);
    node.loop = true;
    // A different slice of the buffer each time, so repeated hits don't sound identical.
    node.start(this.t, (this.t * 7.31) % 0.9);
    this.sources.push(node);
    return this.link(node, to);
  }

  /** Stops every source at `end` and releases the graph once they've ended. */
  play(end: number): this {
    this.end = end;
    for (const source of this.sources) source.stop(end);
    const first = this.sources[0];
    if (first) first.onended = () => this.release();
    return this;
  }

  stop(at: number): void {
    if (at >= this.end) return;
    const g = this.out.gain;
    hold(g, at);
    g.setTargetAtTime(0, at, 0.006);
    this.end = Math.max(at, this.t) + 0.04;
    for (const source of this.sources) source.stop(this.end);
  }

  private link<T extends AudioNode>(node: T, to?: AudioNode | AudioParam): T {
    this.nodes.push(node);
    // An AudioParam has a value; a node doesn't.
    if (to && "value" in to) node.connect(to);
    else if (to) node.connect(to);
    return node;
  }

  private release(): void {
    for (const node of this.nodes) node.disconnect();
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}

/**
 * Plays one note of an instrument at `t` for `dur` seconds (drums ignore
 * `dur`), at `vel` 0..1, into `dest`. Levels are balanced so a full mix sits
 * around -12 dBFS before the music bus.
 */
export function voice(ctx: Ctx, dest: AudioNode, instrument: Instrument, midi: number, t: number, dur: number, vel: number): Voice {
  const p = new Patch(ctx, t, dest);
  const g = p.out.gain;
  const hz = midiToHz(midi);
  const off = t + Math.max(dur, 0.04);
  switch (instrument) {
    case "lead": {
      const f = p.filter("lowpass", hz, 3, p.out);
      p.osc("square", hz, f);
      p.osc("sawtooth", hz, f, 7);
      sweep(f.frequency, t, Math.min(hz * 8, 9000), hz * 2.5 + 300, 0.12);
      return p.play(adsr(g, t, 0.14 * vel, 0.01, 0.2, 0.7, off, 0.05));
    }
    case "pluck": {
      const f = p.filter("lowpass", hz, 2, p.out);
      p.osc("sawtooth", hz, f);
      sweep(f.frequency, t, 6000, hz * 1.5, 0.06);
      return p.play(adsr(g, t, 0.4 * vel, 0.003, 0.15, 0, Math.min(off, t + 0.6), 0.05));
    }
    case "bass": {
      const f = p.filter("lowpass", hz, 1.5, p.out);
      p.osc("triangle", hz, f);
      p.osc("sawtooth", hz, p.gain(0.35, f));
      sweep(f.frequency, t, hz * 10, hz * 3 + 80, 0.08);
      return p.play(adsr(g, t, 0.3 * vel, 0.005, 0.25, 0.75, off, 0.04));
    }
    case "pad": {
      const f = p.filter("lowpass", 900 + hz, 0.5, p.out);
      for (const detune of [-14, 0, 14]) p.osc("sawtooth", hz, f, detune);
      return p.play(adsr(g, t, 0.11 * vel, Math.min(0.4, dur * 0.5), 1, 1, off, 0.3));
    }
    case "bell": {
      // Rings longer the longer the note is held.
      const ring = Math.min(0.8, 0.2 + dur * 0.6);
      p.osc("sine", hz, p.out);
      const partial = p.gain(0, p.out);
      p.osc("sine", hz * 2.76, partial);
      adsr(partial.gain, t, 0.4, 0.002, 0.12, 0, t, 0.12);
      adsr(g, t, 0.3 * vel, 0.002, ring, 0, t + ring * 5, 0.05);
      return p.play(t + ring * 4.5);
    }
    case "keys": {
      const tremolo = p.gain(0.8, p.out);
      p.osc("sine", 5.5, p.gain(0.2, tremolo.gain));
      p.osc("sine", hz, tremolo);
      p.osc("triangle", hz * 2, p.gain(0.15, tremolo));
      return p.play(adsr(g, t, 0.25 * vel, 0.005, 0.6, 0.35, off, 0.25));
    }
    case "kick": {
      const o = p.osc("sine", 150, p.out);
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      return p.play(adsr(g, t, 0.75 * vel, 0.002, 0.1, 0, t + 0.5, 0.01));
    }
    case "snare": {
      g.value = 0.8 * vel;
      const noise = p.gain(0, p.out);
      p.noise(p.filter("bandpass", 1800, 0.7, noise));
      adsr(noise.gain, t, 0.55, 0.001, 0.05, 0, t + 0.3, 0.01);
      const body = p.gain(0, p.out);
      sweep(p.osc("triangle", 190, body).frequency, t, 190, 140, 0.04);
      adsr(body.gain, t, 0.45, 0.001, 0.03, 0, t + 0.3, 0.01);
      return p.play(t + 0.3);
    }
    case "hat":
      p.noise(p.filter("highpass", 7500, 0.7, p.out));
      return p.play(adsr(g, t, 0.25 * vel, 0.001, 0.022, 0, t + 0.12, 0.01));
    case "clap": {
      p.noise(p.filter("bandpass", 1100, 1.4, p.out));
      const peak = vel;
      g.setValueAtTime(0, t);
      for (let k = 0; k < 4; k++) {
        const at = t + k * 0.011;
        g.setValueAtTime(peak, at);
        g.setTargetAtTime(0, at + 0.0005, k === 3 ? 0.06 : 0.003);
      }
      return p.play(t + 0.45);
    }
    case "perc": {
      sweep(p.osc("sine", hz, p.out).frequency, t, hz * 1.5, hz, 0.008);
      return p.play(adsr(g, t, 0.5 * vel, 0.001, 0.06, 0, t + 0.35, 0.01));
    }
  }
}

/** Caps how many voices sound at once; the oldest is faded out to make room. */
export class VoicePool {
  private readonly voices: Voice[] = [];

  constructor(readonly cap = 24) {}

  get size(): number {
    return this.voices.length;
  }

  add(v: Voice, now: number): void {
    const list = this.voices;
    for (let i = list.length - 1; i >= 0; i--) if ((list[i] as Voice).end <= now) list.splice(i, 1);
    while (list.length >= this.cap) list.shift()?.stop(now);
    list.push(v);
  }

  stopAll(at: number): void {
    for (const v of this.voices) v.stop(at);
    this.voices.length = 0;
  }
}
