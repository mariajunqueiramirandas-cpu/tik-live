import { syllableEnvelope, type Envelope, type MouthShape } from "./envelope";

/**
 * Speech playback (ADR-0009): one AudioContext, decoded clips scheduled on
 * the audio clock, an analyser that drives the mouth, and (for cloud
 * broadcast) a capture stream. The next line's audio is prefetched while the
 * current one plays. Lines without audio play a text-derived envelope so the
 * character still talks in captions-only mode.
 */
export interface PlaybackHandle {
  /** Resolves when the line finished (or was stopped). */
  done: Promise<void>;
  /** Seconds the line will take, known once audio decodes. */
  duration: number;
  stop(): void;
}

export interface AudioEngineOptions {
  muted?: boolean;
  /** Fixes the AudioContext's rate (cloud broadcast: 48 kHz, what the encoder is told). */
  sampleRate?: number;
  now?: () => number;
  fetch?: (url: string) => Promise<Response>;
}

export type AudioState = "running" | "suspended" | "unavailable";

const PREFETCH_LIMIT = 6;
/**
 * A clip that isn't fetched and decoded this soon after its line is due plays
 * as captions instead: a line that starts late puts the stage out of sync
 * with the show, and the server stops waiting for it a few seconds later.
 */
const LOAD_TIMEOUT_MS = 3_500;
/** Past a clip's length plus this, a line counts as done even if the audio clock never got there (a suspended context). */
const END_SLACK_MS = 1_000;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private output: GainNode | null = null;
  /** Voice, music and sound effects together, before volume and mute. */
  private mix: GainNode | null = null;
  /** A brickwall-ish limiter after the mix: speech near 0 dBFS plus music must not clip. */
  private limiter: DynamicsCompressorNode | null = null;
  private readonly samples = new Float32Array(1024);
  private readonly spectrum = new Uint8Array(512);
  private source: AudioBufferSourceNode | null = null;
  private envelope: { fn: Envelope; start: number } | null = null;
  private resolveCurrent: (() => void) | null = null;
  /** Bumped by every play and stop, so a clip that finishes loading late can't start over a newer line. */
  private token = 0;
  private readonly cache = new Map<string, Promise<AudioBuffer | null>>();
  private readonly now: () => number;
  private readonly fetcher: (url: string) => Promise<Response>;
  private muted: boolean;
  private volume = 1;
  private readonly stateListeners = new Set<(state: AudioState) => void>();

  constructor(private readonly options: AudioEngineOptions = {}) {
    this.muted = options.muted ?? false;
    this.now = options.now ?? (() => performance.now());
    this.fetcher = options.fetch ?? ((url) => fetch(url));
  }

  /** "running" means sound will play; "suspended" needs a user gesture (see unlock). */
  get state(): AudioState {
    if (typeof AudioContext === "undefined") return "unavailable";
    return this.ensure()?.state === "running" ? "running" : "suspended";
  }

  /** Notifies when autoplay gets unlocked or suspended (for the "tap for sound" prompt). */
  onStateChange(listener: (state: AudioState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async unlock(): Promise<void> {
    await this.ensure()?.resume();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyGain();
  }

  /**
   * The stage's sound as it leaves the engine (voice, music and sound
   * effects), before volume and mute: cloud broadcast capture connects its
   * PCM tap here (ADR-0020).
   */
  tap(): { context: AudioContext; node: AudioNode } | null {
    const ctx = this.ensure();
    return ctx && this.limiter ? { context: ctx, node: this.limiter } : null;
  }

  /**
   * Where music and sound effects join the voice (ADR-0024): after the
   * speech analyser, so they don't move the mouth, and before volume, mute
   * and the broadcast tap.
   */
  mixInput(): { context: AudioContext; node: AudioNode } | null {
    const ctx = this.ensure();
    return ctx && this.mix ? { context: ctx, node: this.mix } : null;
  }

  /** Starts fetching and decoding a clip so `play` can start it without delay. */
  prefetch(url: string): void {
    void this.load(url);
  }

  /**
   * Plays a line. With `audioUrl`, fetches (or takes the prefetched clip),
   * decodes and schedules it; without one (or if anything fails), plays a
   * silent envelope of `fallbackMs`.
   */
  async play(text: string, audioUrl: string | null, fallbackMs: number): Promise<PlaybackHandle> {
    this.stop();
    const token = this.token;
    const ctx = audioUrl ? this.ensure() : null;
    if (ctx && audioUrl) {
      const buffer = await this.loadWithin(audioUrl, LOAD_TIMEOUT_MS);
      this.cache.delete(audioUrl);
      // Stopped (or replaced) while loading: start nothing.
      if (token !== this.token) return inertHandle(buffer?.duration ?? fallbackMs / 1000);
      if (buffer && ctx.state === "running") return this.playBuffer(ctx, buffer, token);
    }
    return this.playEnvelope(text, fallbackMs, token);
  }

  stop(): void {
    this.token += 1;
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        // already stopped
      }
      this.source.disconnect();
      this.source = null;
    }
    this.envelope = null;
    this.resolveCurrent?.();
    this.resolveCurrent = null;
  }

  /** 0..1 loudness right now, for the mouth and glow. */
  amplitude(): number {
    if (this.source && this.analyser) {
      this.analyser.getFloatTimeDomainData(this.samples);
      let sum = 0;
      for (let i = 0; i < this.samples.length; i++) {
        const v = this.samples[i] as number;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / this.samples.length) * 4.5);
    }
    if (this.envelope) return this.envelope.fn(this.now() - this.envelope.start);
    return 0;
  }

  /**
   * Rough mouth shape right now. From audio: the balance of energy in the
   * low (round: o, u), and high (wide: i, e) formant bands. From the
   * envelope: the vowel of the current syllable.
   */
  mouthShape(out: MouthShape): MouthShape {
    if (this.source && this.analyser && this.ctx) {
      this.analyser.getByteFrequencyData(this.spectrum);
      const binHz = this.ctx.sampleRate / 2 / this.spectrum.length;
      const low = this.band(250, 700, binHz);
      const mid = this.band(700, 1600, binHz);
      const high = this.band(1800, 3200, binHz);
      const total = low + mid + high;
      if (total < 1) {
        out.round = 0;
        out.wide = 0;
      } else {
        out.round = clamp01((low / total - 0.45) * 3);
        out.wide = clamp01((high / total - 0.2) * 3);
      }
      return out;
    }
    if (this.envelope) return this.envelope.fn.shape(this.now() - this.envelope.start, out);
    out.round = 0;
    out.wide = 0;
    return out;
  }

  get speaking(): boolean {
    return this.source !== null || this.envelope !== null;
  }

  destroy(): void {
    this.stop();
    this.cache.clear();
    this.stateListeners.clear();
    void this.ctx?.close();
    this.ctx = null;
  }

  private band(fromHz: number, toHz: number, binHz: number): number {
    const from = Math.max(0, Math.floor(fromHz / binHz));
    const to = Math.min(this.spectrum.length - 1, Math.ceil(toHz / binHz));
    let sum = 0;
    for (let i = from; i <= to; i++) sum += this.spectrum[i] as number;
    return sum / Math.max(1, to - from + 1);
  }

  /** The clip, or null if it isn't ready within `ms` (it keeps loading for the cache). */
  private loadWithin(url: string, ms: number): Promise<AudioBuffer | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    return Promise.race([this.load(url), late]).finally(() => clearTimeout(timer));
  }

  private load(url: string): Promise<AudioBuffer | null> {
    const cached = this.cache.get(url);
    if (cached) return cached;
    const ctx = this.ensure();
    if (!ctx) return Promise.resolve(null);
    const promise = (async () => {
      try {
        const response = await this.fetcher(url);
        if (!response.ok) return null;
        return await ctx.decodeAudioData(await response.arrayBuffer());
      } catch {
        // Fall back to the silent envelope: captions still play in time.
        return null;
      }
    })();
    this.cache.set(url, promise);
    while (this.cache.size > PREFETCH_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
    return promise;
  }

  private applyGain(): void {
    if (this.output) this.output.gain.value = this.muted ? 0 : this.volume;
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof AudioContext === "undefined") return null;
    const ctx = new AudioContext({ latencyHint: "interactive", ...(this.options.sampleRate ? { sampleRate: this.options.sampleRate } : {}) });
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.5;
    this.output = ctx.createGain();
    this.mix = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    this.limiter = limiter;
    this.analyser.connect(this.mix).connect(limiter).connect(this.output).connect(ctx.destination);
    ctx.addEventListener("statechange", () => {
      const state: AudioState = ctx.state === "running" ? "running" : "suspended";
      for (const listener of this.stateListeners) listener(state);
    });
    this.ctx = ctx;
    this.applyGain();
    return ctx;
  }

  /** Stops this line only if it's still the one playing. */
  private stopIf(token: number): void {
    if (token === this.token) this.stop();
  }

  private playBuffer(ctx: AudioContext, buffer: AudioBuffer, token: number): PlaybackHandle {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser!);
    this.source = source;
    const done = new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(watchdog);
        source.onended = null;
        if (this.source === source) {
          try {
            source.stop();
          } catch {
            // already stopped
          }
          source.disconnect();
          this.source = null;
          this.resolveCurrent = null;
        }
        resolve();
      };
      this.resolveCurrent = finish;
      source.onended = finish;
      // If the audio clock stalls (the context got suspended), `onended` never
      // fires: without this the stage would hang on this line for good.
      const watchdog = setTimeout(finish, buffer.duration * 1000 + END_SLACK_MS);
    });
    // A hair of lead time keeps the start sample-accurate and glitch-free.
    source.start(ctx.currentTime + 0.02);
    return { done, duration: buffer.duration, stop: () => this.stopIf(token) };
  }

  private playEnvelope(text: string, durationMs: number, token: number): PlaybackHandle {
    const fn = syllableEnvelope(text, durationMs);
    const envelope = { fn, start: this.now() };
    this.envelope = envelope;
    const done = new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        if (this.envelope === envelope) {
          this.envelope = null;
          this.resolveCurrent = null;
        }
        resolve();
      };
      this.resolveCurrent = finish;
      const timer = setTimeout(finish, durationMs);
    });
    return { done, duration: durationMs / 1000, stop: () => this.stopIf(token) };
  }
}

function inertHandle(duration: number): PlaybackHandle {
  return { done: Promise.resolve(), duration, stop: () => {} };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
