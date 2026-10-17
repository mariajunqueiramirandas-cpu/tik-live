import { DRUMS, MAX_TRACK_SECONDS, parsePattern, STEPS_PER_BAR, type Instrument, type MusicTrack, type MusicTrackInput, type StageServerPayload } from "@tik-live/shared";
import { SoundBoard } from "./sfx";
import { hold, voice, VoicePool } from "./synth";

/**
 * Music as code on the stage (ADR-0024): the host's step-sequencer scores
 * (packages/shared/src/music.ts) synthesized live with WebAudio, plus the
 * show's sound effects. Both join the voice in the AudioEngine's mix, after
 * the speech analyser (so they never move the mouth) and before volume and
 * mute and the broadcast tap (so OBS and the cloud broadcast carry them).
 *
 * Wiring (engine.ts):
 *
 *   this.music = new MusicPlayer(this.audio);   // AudioEngine; nothing is built until the first sound
 *   apply(message) { if (this.music.handle(message)) return; ... }  // takes {t:"music"} and {t:"sfx"}
 *   frame:   const level = this.music.level();  // 0..1, music only, for an equalizer (no allocation)
 *            this.music.bands(this.eqBands);    // optional: Float32Array of n bands, 0..1 each
 *            this.music.nowPlaying();           // { title, endsAt } (one reused object) or null
 *   destroy: this.music.destroy();              // before this.audio.destroy()
 *
 * Ducking under speech is automatic: the scheduler polls `host.speaking`
 * (music to 30%, sound effects to 60%). `setDucking` sets it by hand.
 */
export interface MusicHost {
  /** Where music joins the mix (AudioEngine.mixInput); null without WebAudio. */
  mixInput(): { context: BaseAudioContext; node: AudioNode } | null;
  readonly speaking?: boolean;
}

export interface MusicPlayerOptions {
  /** Clock for `nowPlaying().endsAt` and sound-effect rate limits, in ms. Default performance.now. */
  now?: () => number;
  /** Runs `fn` every `ms`; returns a canceller. Default setInterval (tests inject a manual one). */
  every?: (fn: () => void, ms: number) => () => void;
}

/** One note to play: seconds from the start of the track. Chords are one event per note. */
export interface NoteEvent {
  time: number;
  duration: number;
  instrument: Instrument;
  midi: number;
  velocity: number;
}

export interface Score {
  events: NoteEvent[];
  /** Seconds, repeats included, never past MAX_TRACK_SECONDS. */
  duration: number;
}

/** What `x` plays on a melodic part (and the pitch of a perc hit). */
const DEFAULT_NOTE: Partial<Record<Instrument, number>> = { lead: 72, pluck: 60, bass: 36, pad: 60, bell: 72, keys: 60, perc: 64 };

/** Start of sixteenth `step`: swing pushes odd steps late, by up to 0.3 of a step at swing 0.6. */
export function stepTime(step: number, stepSeconds: number, swing: number): number {
  return (step + (step % 2) * swing * 0.5) * stepSeconds;
}

/**
 * Expands a track into timed notes: patterns loop to fill the track, holds
 * (`-`) lengthen the note before them (across a loop, too), the whole piece
 * plays `repeat` times, and nothing starts or rings past MAX_TRACK_SECONDS.
 * Invalid patterns are skipped.
 */
export function scheduleTrack(track: Pick<MusicTrackInput, "bpm" | "bars" | "repeat" | "swing" | "parts">): Score {
  const stepSeconds = 60 / (track.bpm * 4);
  const swing = Math.max(0, Math.min(0.6, track.swing ?? 0));
  const total = Math.min(track.bars * STEPS_PER_BAR * Math.max(1, track.repeat ?? 1), Math.floor(MAX_TRACK_SECONDS / stepSeconds + 1e-9));
  const duration = total * stepSeconds;
  const events: NoteEvent[] = [];
  for (const part of track.parts) {
    const steps = parsePattern(part.pattern);
    if (!steps) continue;
    const { instrument } = part;
    const velocity = part.volume ?? 0.8;
    const pitched = !DRUMS.has(instrument) || instrument === "perc";
    for (let i = 0; i < total; i++) {
      const step = steps[i % steps.length];
      if (!step || step.kind === "rest" || step.kind === "hold") continue;
      let j = i + 1;
      while (j < total && steps[j % steps.length]?.kind === "hold") j++;
      const time = stepTime(i, stepSeconds, swing);
      const length = Math.min(duration, stepTime(j, stepSeconds, swing)) - time;
      const notes = step.kind === "hit" ? [DEFAULT_NOTE[instrument] ?? 60] : pitched ? step.midi : step.midi.slice(0, 1);
      for (const midi of notes) events.push({ time, duration: length, instrument, midi, velocity });
    }
  }
  events.sort((a, b) => a.time - b.time);
  return { events, duration };
}

/** The music and sound-effect buses, from the instruments to the stage mix. */
export interface MusicBus {
  ctx: BaseAudioContext;
  /** Tracks connect here. */
  music: GainNode;
  /** Sound effects connect here. */
  sfx: GainNode;
  /** Music only, after its compressor and before ducking (for the equalizer). */
  analyser: AnalyserNode;
  duckMusic: GainNode;
  duckSfx: GainNode;
  nodes: AudioNode[];
}

/**
 * Music runs through a gentle compressor at about -9 dB (a full mix measures
 * around -20 dB RMS, peaks near -6 dBFS), so the voice stays on top even
 * before ducking. Sound effects get their own compressor and duck less.
 */
export function buildBus(ctx: BaseAudioContext, dest: AudioNode): MusicBus {
  const gain = (value: number) => {
    const node = ctx.createGain();
    node.gain.value = value;
    return node;
  };
  const compressor = () => {
    const node = ctx.createDynamicsCompressor();
    node.threshold.value = -14;
    node.knee.value = 10;
    node.ratio.value = 4;
    node.attack.value = 0.005;
    node.release.value = 0.2;
    return node;
  };
  const music = gain(MUSIC_GAIN);
  const sfx = gain(0.6);
  const musicComp = compressor();
  const sfxComp = compressor();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  const duckMusic = gain(1);
  const duckSfx = gain(1);
  music.connect(musicComp).connect(analyser).connect(duckMusic).connect(dest);
  sfx.connect(sfxComp).connect(duckSfx).connect(dest);
  return { ctx, music, sfx, analyser, duckMusic, duckSfx, nodes: [music, sfx, musicComp, sfxComp, analyser, duckMusic, duckSfx] };
}

interface Playing {
  title: string;
  score: Score;
  cursor: number;
  /** Audio-clock time of the track's first step, and of its end. */
  start: number;
  end: number;
  gain: GainNode;
}

const MUSIC_GAIN = 0.36;
const TICK_MS = 25;
const LOOKAHEAD = 0.12;
const MUSIC_DUCK = 0.3;
const SFX_DUCK = 0.6;

export class MusicPlayer {
  readonly sfx: SoundBoard;
  private bus: MusicBus | null = null;
  private current: Playing | null = null;
  private readonly fading: Array<{ gain: GainNode; until: number }> = [];
  private readonly pool = new VoicePool(24);
  private cancel: (() => void) | null = null;
  private lastTick = 0;
  private ducked = false;
  private smoothed = 0;
  private readonly samples = new Float32Array(512);
  private readonly spectrum = new Uint8Array(256);
  private readonly playing = { title: "", endsAt: 0 };
  private readonly now: () => number;
  private readonly every: (fn: () => void, ms: number) => () => void;

  constructor(
    private readonly host: MusicHost,
    options: MusicPlayerOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.every =
      options.every ??
      ((fn, ms) => {
        const id = setInterval(fn, ms);
        return () => clearInterval(id);
      });
    this.sfx = new SoundBoard(
      () => {
        const bus = this.ensure();
        return bus && { ctx: bus.ctx, input: bus.sfx };
      },
      this.now,
      () => this.run(),
    );
  }

  /** Takes the stage's `music` and `sfx` messages; returns false for anything else. */
  handle(message: StageServerPayload): boolean {
    if (message.t === "music") {
      if (message.track) this.play(message.track);
      else this.stop();
      return true;
    }
    if (message.t === "sfx") {
      this.sfx.play(message.sound);
      return true;
    }
    return false;
  }

  /** Starts a track, crossfading out whatever was playing. */
  play(track: MusicTrack): void {
    const bus = this.ensure();
    if (!bus) return;
    const t = bus.ctx.currentTime;
    this.release(t, 0.25);
    const score = scheduleTrack(track);
    const gain = bus.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(1, t + 0.15);
    gain.connect(bus.music);
    const start = t + 0.08;
    this.current = { title: track.title, score, cursor: 0, start, end: start + score.duration, gain };
    this.run();
  }

  /** Fades the music out quickly. Sound effects keep playing. */
  stop(): void {
    if (this.bus) this.release(this.bus.ctx.currentTime, 0.12);
  }

  /** Ducks music (to 30%) and sound effects (to 60%) under speech: ~120 ms down, ~400 ms back up. */
  setDucking(speaking: boolean): void {
    if (speaking === this.ducked) return;
    this.ducked = speaking;
    const bus = this.bus;
    if (!bus) return;
    const t = bus.ctx.currentTime;
    const tau = speaking ? 0.04 : 0.13;
    for (const [node, low] of [[bus.duckMusic, MUSIC_DUCK], [bus.duckSfx, SFX_DUCK]] as const) {
      hold(node.gain, t);
      node.gain.setTargetAtTime(speaking ? low : 1, t, tau);
    }
  }

  /** The music's loudness right now, 0..1 (sound effects and voice excluded). Doesn't allocate. */
  level(): number {
    const bus = this.bus;
    if (!bus) return 0;
    bus.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const v = this.samples[i] as number;
      sum += v * v;
    }
    const v = Math.min(1, Math.sqrt(sum / this.samples.length) * 3);
    // Fast up, slower down, so an equalizer doesn't flicker.
    this.smoothed = v > this.smoothed ? v : this.smoothed * 0.85 + v * 0.15;
    return this.smoothed < 0.002 ? 0 : this.smoothed;
  }

  /** Fills `out` with the music's spectrum in out.length log-spaced bands, 0..1. Doesn't allocate. */
  bands(out: Float32Array): Float32Array {
    const bus = this.bus;
    if (!bus) return out.fill(0);
    bus.analyser.getByteFrequencyData(this.spectrum);
    const bins = this.spectrum.length;
    const n = out.length;
    for (let b = 0; b < n; b++) {
      const from = Math.floor(bins ** (b / n));
      const to = Math.max(from + 1, Math.floor(bins ** ((b + 1) / n)));
      let sum = 0;
      for (let i = from; i < to; i++) sum += this.spectrum[i] as number;
      out[b] = sum / (to - from) / 255;
    }
    return out;
  }

  /** The track playing, with when it ends (ms on the `now` clock); one reused object, or null. */
  nowPlaying(): { title: string; endsAt: number } | null {
    const c = this.current;
    if (!c || !this.bus) return null;
    this.playing.title = c.title;
    this.playing.endsAt = this.now() + Math.max(0, c.end - this.bus.ctx.currentTime) * 1000;
    return this.playing;
  }

  /** Voices sounding now (at most 24). */
  get voices(): number {
    return this.pool.size;
  }

  destroy(): void {
    this.cancel?.();
    this.cancel = null;
    this.current = null;
    this.fading.length = 0;
    if (this.bus) {
      this.pool.stopAll(this.bus.ctx.currentTime);
      for (const node of this.bus.nodes) node.disconnect();
    }
    this.bus = null;
  }

  private ensure(): MusicBus | null {
    const input = this.host.mixInput();
    if (!input) return null;
    if (this.bus?.ctx !== input.context) {
      this.destroy();
      this.bus = buildBus(input.context, input.node);
      this.ducked = false;
    }
    return this.bus;
  }

  private release(t: number, seconds: number): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    hold(c.gain.gain, t);
    c.gain.gain.linearRampToValueAtTime(0, t + seconds);
    this.fading.push({ gain: c.gain, until: t + seconds + 0.05 });
  }

  private run(): void {
    if (this.cancel || !this.bus) return;
    this.lastTick = this.bus.ctx.currentTime;
    this.cancel = this.every(this.tick, TICK_MS);
    this.tick();
  }

  private readonly tick = (): void => {
    const bus = this.bus;
    if (!bus) return;
    const now = bus.ctx.currentTime;
    if (this.host.speaking !== undefined) this.setDucking(this.host.speaking);
    // Look further ahead when the timer runs late (a busy or background tab).
    const ahead = Math.min(1, Math.max(LOOKAHEAD, (now - this.lastTick) * 1.5));
    this.lastTick = now;
    const c = this.current;
    if (c) {
      const events = c.score.events;
      while (c.cursor < events.length) {
        const e = events[c.cursor] as NoteEvent;
        const at = c.start + e.time;
        if (at > now + ahead) break;
        c.cursor++;
        // Missed while the timer stalled: skip it rather than play a pile of late notes.
        if (at < now - 0.05) continue;
        this.pool.add(voice(bus.ctx, c.gain, e.instrument, e.midi, Math.max(at, now), e.duration, e.velocity), now);
      }
      if (now >= c.end) this.release(now, 0.5);
    }
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i] as { gain: GainNode; until: number };
      if (now < f.until) continue;
      f.gain.disconnect();
      this.fading.splice(i, 1);
    }
    if (!this.current && this.fading.length === 0 && !this.sfx.busy(now)) {
      this.cancel?.();
      this.cancel = null;
    }
  };
}
