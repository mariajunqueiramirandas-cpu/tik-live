/**
 * Just enough of WebAudio for MusicPlayer and SoundBoard smoke tests: nodes
 * record their connections and scheduled sources, params record automation.
 */
export class FakeParam {
  value: number;
  readonly events: Array<[string, number, number]> = [];
  constructor(value = 0) {
    this.value = value;
  }
  setValueAtTime(v: number, t: number) {
    this.events.push(["set", v, t]);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push(["linear", v, t]);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    if (v <= 0) throw new RangeError("exponential ramp to a non-positive value");
    this.events.push(["exp", v, t]);
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number) {
    if (!(tau > 0)) throw new RangeError("time constant must be positive");
    this.events.push(["target", v, t]);
    return this;
  }
  setValueCurveAtTime(curve: Float32Array, t: number, duration: number) {
    if (!(duration > 0) || curve.length < 2) throw new RangeError("bad curve");
    this.events.push(["curve", curve.length, t]);
    return this;
  }
  cancelAndHoldAtTime(t: number) {
    this.events.push(["hold", 0, t]);
    return this;
  }
  cancelScheduledValues(t: number) {
    this.events.push(["cancel", 0, t]);
    return this;
  }
}

export class FakeNode {
  readonly outputs = new Set<unknown>();
  constructor(
    readonly ctx: FakeAudioContext,
    readonly kind: string,
  ) {
    ctx.created.push(this);
  }
  connect<T>(to: T): T {
    this.outputs.add(to);
    return to;
  }
  disconnect(): void {
    this.outputs.clear();
    this.ctx.disconnected += 1;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
}
class FakeFilter extends FakeNode {
  type = "lowpass";
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);
}
class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  getFloatTimeDomainData(out: Float32Array) {
    out.fill(this.ctx.signal);
  }
  getByteFrequencyData(out: Uint8Array) {
    out.fill(Math.round(this.ctx.signal * 255));
  }
}
class FakeSource extends FakeNode {
  startAt = -1;
  stopAt = Infinity;
  onended: (() => void) | null = null;
  start(t = 0) {
    if (this.startAt >= 0) throw new Error("started twice");
    this.startAt = t;
    this.ctx.sources.push(this);
  }
  stop(t = 0) {
    if (this.startAt < 0) throw new Error("stopped before start");
    this.stopAt = t;
  }
}
class FakeOscillator extends FakeSource {
  type = "sine";
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);
}
class FakeBufferSource extends FakeSource {
  buffer: unknown = null;
  loop = false;
}

export class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate = 8000;
  state: "running" | "suspended" = "running";
  /** What the analyser reports, 0..1. */
  signal = 0;
  readonly created: FakeNode[] = [];
  readonly sources: FakeSource[] = [];
  disconnected = 0;
  buffers = 0;

  createGain() {
    return new FakeGain(this, "gain");
  }
  createBiquadFilter() {
    return new FakeFilter(this, "filter");
  }
  createDynamicsCompressor() {
    return new FakeCompressor(this, "compressor");
  }
  createAnalyser() {
    return new FakeAnalyser(this, "analyser");
  }
  createOscillator() {
    return new FakeOscillator(this, "oscillator");
  }
  createBufferSource() {
    return new FakeBufferSource(this, "buffer-source");
  }
  createBuffer(_channels: number, length: number, _rate: number) {
    this.buffers += 1;
    const data = new Float32Array(length);
    return { duration: length / this.sampleRate, getChannelData: () => data };
  }

  /** Moves the clock and fires `onended` for sources that stopped by then. */
  advance(seconds: number): void {
    this.currentTime += seconds;
    for (const source of this.sources) {
      if (source.stopAt <= this.currentTime && source.onended) {
        const fn = source.onended;
        source.onended = null;
        fn();
      }
    }
  }

  /** Sources sounding at the current time. */
  sounding(): number {
    return this.sources.filter((s) => s.startAt <= this.currentTime && s.stopAt > this.currentTime).length;
  }
}

/** A manual `every` for MusicPlayer: `tick()` runs the scheduler once. */
export class ManualInterval {
  private fn: (() => void) | null = null;
  readonly every = (fn: () => void): (() => void) => {
    this.fn = fn;
    return () => {
      this.fn = null;
    };
  };
  get running(): boolean {
    return this.fn !== null;
  }
  tick(): void {
    this.fn?.();
  }
}
