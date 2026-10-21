import type { StageServerPayload } from "@tik-live/shared";
import { hold } from "./synth";

/**
 * The automatic DJ on the stage (ADR-0045): recorded tracks streamed with
 * media elements, two decks crossfading into each other, routed through
 * WebAudio into the AudioEngine's mix (after the speech analyser, so they
 * never move the mouth; before volume, mute and the broadcast tap, so OBS
 * and the cloud broadcast carry them). The server says which track plays and
 * from where; the deck only follows.
 *
 * Wiring (engine.ts):
 *
 *   this.dj = new DjDeck(this.audio, { musicPlaying: () => this.music?.nowPlaying() !== null });
 *   apply(message) { if (message.t === "dj") this.dj.handle(message); }
 *   frame:   this.dj.nowPlaying();   // { title, credit, endsAt } (one reused object) or null
 *            this.dj.bands(out);     // the DJ's spectrum, like MusicPlayer.bands
 *   destroy: this.dj.destroy();      // before this.audio.destroy()
 *
 * The DJ ducks under speech (to 30%) and fades out while one of the host's
 * own pieces plays, then comes back. While the stage is muted (a dashboard
 * preview) it doesn't stream at all, and catches up to where the track is
 * once it's unmuted.
 */
export interface DjHost {
  /** Where music joins the mix (AudioEngine.mixInput); null without WebAudio. */
  mixInput(): { context: BaseAudioContext; node: AudioNode } | null;
  readonly speaking?: boolean;
  readonly isMuted?: boolean;
}

/** The parts of HTMLAudioElement the deck uses (tests pass a fake). */
export interface DjMedia {
  src: string;
  preload: string;
  currentTime: number;
  readonly paused: boolean;
  readonly ended: boolean;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: "src"): void;
  load(): void;
  addEventListener(type: "loadedmetadata", listener: () => void, options?: { once?: boolean }): void;
}

export interface DjDeckOptions {
  /** True while one of the host's own pieces plays: the DJ steps aside. */
  musicPlaying?: () => boolean;
  /** Makes a media element. Default `new Audio()`. */
  createMedia?: () => DjMedia;
  /** Routes a media element into WebAudio. Default `ctx.createMediaElementSource`. */
  connectMedia?: (ctx: BaseAudioContext, media: DjMedia) => AudioNode;
  /** Clock in ms. Default performance.now. */
  now?: () => number;
  /** Runs `fn` every `ms`; returns a canceller. Default setInterval. */
  every?: (fn: () => void, ms: number) => () => void;
}

type DjMessage = Extract<StageServerPayload, { t: "dj" }>;

interface Deck {
  media: DjMedia;
  gain: GainNode;
  /** The track's URL this deck holds, playing or preloaded. */
  url: string;
}

interface Current {
  deck: Deck;
  id: string;
  title: string;
  credit: string;
  seconds: number;
  /** Where in the track it was (seconds) at `at` (ms on the `now` clock). */
  offset: number;
  at: number;
}

/** Recorded masters are loud: this sits the DJ under the voice even before ducking. */
const DJ_GAIN = 0.32;
const DUCK = 0.3;
const CROSSFADE_S = 3;
const FADE_IN_S = 0.8;
const STOP_FADE_S = 1.5;
const TICK_MS = 250;
/** A stage this far off the server's position seeks back in line. */
const DRIFT_S = 3;
/** A paused deck that should be playing (autoplay blocked, a stall) is retried this often. */
const RETRY_MS = 2_000;

export class DjDeck {
  private ctx: BaseAudioContext | null = null;
  private decks: [Deck, Deck] | null = null;
  private duck: GainNode | null = null;
  private yieldGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private nodes: AudioNode[] = [];
  private current: Current | null = null;
  /** Decks fading out, with when to pause them (seconds on the audio clock). */
  private readonly fading: Array<{ deck: Deck; until: number }> = [];
  private next: string | null = null;
  private cancel: (() => void) | null = null;
  private ducked = false;
  private yielded = false;
  private suspended = false;
  private retryAt = 0;
  private readonly spectrum = new Uint8Array(256);
  private readonly playing = { title: "", credit: "", endsAt: 0 };
  private readonly now: () => number;
  private readonly every: (fn: () => void, ms: number) => () => void;
  private readonly createMedia: () => DjMedia;
  private readonly connectMedia: (ctx: BaseAudioContext, media: DjMedia) => AudioNode;

  constructor(
    private readonly host: DjHost,
    private readonly options: DjDeckOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.every =
      options.every ??
      ((fn, ms) => {
        const id = setInterval(fn, ms);
        return () => clearInterval(id);
      });
    this.createMedia = options.createMedia ?? (() => new Audio() as DjMedia);
    this.connectMedia = options.connectMedia ?? ((ctx, media) => (ctx as AudioContext).createMediaElementSource(media as HTMLMediaElement));
  }

  /** Takes the stage's `dj` messages; returns false for anything else. */
  handle(message: StageServerPayload): boolean {
    if (message.t !== "dj") return false;
    if (message.track) this.play(message);
    else this.stop();
    return true;
  }

  /** The track playing, its credit and when it ends (ms on the `now` clock); one reused object, or null. */
  nowPlaying(): { title: string; credit: string; endsAt: number } | null {
    const c = this.current;
    if (!c) return null;
    this.playing.title = c.title;
    this.playing.credit = c.credit;
    this.playing.endsAt = this.now() + Math.max(0, c.seconds - this.position(c)) * 1000;
    return this.playing;
  }

  /** Fills `out` with the DJ's spectrum in out.length log-spaced bands, 0..1. Doesn't allocate. */
  bands(out: Float32Array): Float32Array {
    const analyser = this.analyser;
    if (!analyser) return out.fill(0);
    analyser.getByteFrequencyData(this.spectrum);
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

  destroy(): void {
    this.cancel?.();
    this.cancel = null;
    this.current = null;
    this.fading.length = 0;
    for (const deck of this.decks ?? []) release(deck.media);
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    this.decks = null;
    this.ctx = null;
  }

  private play(message: DjMessage): void {
    const track = message.track!;
    const offset = (message.offsetMs ?? 0) / 1000;
    if (!this.ensure()) return;
    this.next = message.next ?? null;
    const c = this.current;
    if (c?.id === track.id) {
      // The same track again (a reconnect): stay put unless we drifted.
      if (Math.abs(this.position(c) - offset) > DRIFT_S) {
        c.offset = offset;
        c.at = this.now();
        if (!this.suspended) c.deck.media.currentTime = offset;
      }
      return;
    }
    const decks = this.decks!;
    // The deck that isn't on: it may already hold this track, preloaded.
    const deck = c?.deck === decks[0] ? decks[1] : decks[0];
    this.fading.splice(0, this.fading.length, ...this.fading.filter((f) => f.deck !== deck));
    const t = this.ctx!.currentTime;
    if (c) this.fadeOut(c.deck, t, CROSSFADE_S);
    this.current = { deck, id: track.id, title: track.title, credit: track.credit, seconds: track.seconds, offset, at: this.now() };
    hold(deck.gain.gain, t);
    deck.gain.gain.setValueAtTime(0, t);
    deck.gain.gain.linearRampToValueAtTime(1, t + (c ? CROSSFADE_S : FADE_IN_S));
    if (deck.url !== track.url) {
      deck.url = track.url;
      deck.media.src = track.url;
    }
    if (!this.suspended) this.start(this.current);
    this.run();
  }

  private stop(): void {
    const c = this.current;
    if (!c || !this.ctx) return;
    this.current = null;
    this.next = null;
    this.fadeOut(c.deck, this.ctx.currentTime, STOP_FADE_S);
  }

  /** Seconds into the current track right now, by the server's account. */
  private position(c: Current): number {
    return c.offset + (this.now() - c.at) / 1000;
  }

  /** Starts a deck where the track should be by now (once its metadata is in, if it isn't yet). */
  private start(c: Current): void {
    const media = c.deck.media;
    media.preload = "auto";
    const seek = () => {
      if (this.current !== c) return;
      const at = this.position(c);
      // A fresh track starts from the top; only catching up seeks in.
      if (at > 1) media.currentTime = Math.min(at, Math.max(0, c.seconds - 1));
    };
    seek();
    media.addEventListener("loadedmetadata", seek, { once: true });
    this.retryAt = this.now() + RETRY_MS;
    media.play().catch(() => {
      // Autoplay is blocked until someone clicks (a normal browser tab), or the file isn't ready:
      // the tick tries again.
    });
  }

  private fadeOut(deck: Deck, t: number, seconds: number): void {
    hold(deck.gain.gain, t);
    deck.gain.gain.linearRampToValueAtTime(0, t + seconds);
    this.fading.push({ deck, until: t + seconds + 0.1 });
  }

  private ensure(): boolean {
    const input = this.host.mixInput();
    if (!input) return false;
    if (this.ctx === input.context && this.decks) return true;
    this.destroy();
    const ctx = input.context;
    const gain = (value: number) => {
      const node = ctx.createGain();
      node.gain.value = value;
      return node;
    };
    const level = gain(DJ_GAIN);
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 10;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.2;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    const duck = gain(1);
    const yieldGain = gain(1);
    level.connect(compressor).connect(analyser).connect(duck).connect(yieldGain).connect(input.node);
    const deck = (): Deck => {
      const media = this.createMedia();
      media.preload = "auto";
      const g = gain(0);
      const source = this.connectMedia(ctx, media);
      source.connect(g).connect(level);
      this.nodes.push(source, g);
      return { media, gain: g, url: "" };
    };
    this.decks = [deck(), deck()];
    this.nodes.push(level, compressor, analyser, duck, yieldGain);
    this.ctx = ctx;
    this.duck = duck;
    this.yieldGain = yieldGain;
    this.analyser = analyser;
    this.ducked = false;
    this.yielded = false;
    return true;
  }

  private run(): void {
    if (this.cancel) return;
    this.cancel = this.every(this.tick, TICK_MS);
  }

  private setGain(node: GainNode | null, value: number, tau: number): void {
    if (!node || !this.ctx) return;
    const t = this.ctx.currentTime;
    hold(node.gain, t);
    node.gain.setTargetAtTime(value, t, tau);
  }

  private readonly tick = (): void => {
    const ctx = this.ctx;
    if (!ctx || !this.decks) return;
    const t = ctx.currentTime;
    const speaking = this.host.speaking === true;
    if (speaking !== this.ducked) {
      this.ducked = speaking;
      this.setGain(this.duck, speaking ? DUCK : 1, speaking ? 0.04 : 0.15);
    }
    const yielded = this.options.musicPlaying?.() === true;
    if (yielded !== this.yielded) {
      this.yielded = yielded;
      this.setGain(this.yieldGain, yielded ? 0 : 1, yielded ? 0.1 : 0.4);
    }
    // Muted (a preview): stop streaming; unmuted again, pick the track up where it is now.
    const suspended = this.host.isMuted === true;
    if (suspended !== this.suspended) {
      this.suspended = suspended;
      if (suspended) for (const deck of this.decks) deck.media.pause();
      else if (this.current) this.start(this.current);
    }
    const c = this.current;
    if (c && !this.suspended && c.deck.media.paused && !c.deck.media.ended && this.now() >= this.retryAt) this.start(c);
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i] as { deck: Deck; until: number };
      if (t < f.until) continue;
      this.fading.splice(i, 1);
      if (f.deck === this.current?.deck) continue;
      f.deck.media.pause();
      // The free deck starts loading the next track, so the crossfade doesn't wait on the network.
      if (this.next && !this.suspended && f.deck.url !== this.next) {
        f.deck.url = this.next;
        f.deck.media.src = this.next;
        f.deck.media.preload = "auto";
      }
    }
    if (!this.current && this.fading.length === 0) {
      this.cancel?.();
      this.cancel = null;
    }
  };
}

function release(media: DjMedia): void {
  media.pause();
  media.removeAttribute("src");
  media.load();
}
