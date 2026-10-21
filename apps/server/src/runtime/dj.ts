import { DJ_CATALOG, type DjTrack } from "@tik-live/shared";

/** Where the DJ's tracks go: the stage hub, which turns ids into stage URLs. */
export interface DjOutput {
  dj(track: DjTrack | null, startedAt?: number, next?: DjTrack): void;
}

export interface DjOptions {
  stage: DjOutput;
  /** Starts fetching a track into the server's cache, so it's ready when the stage asks. */
  warm?: (track: DjTrack) => void;
  tracks?: readonly DjTrack[];
  random?: () => number;
  now?: () => number;
  /** Runs `fn` after `ms`; returns a canceller. Default setTimeout (tests inject a manual one). */
  after?: (fn: () => void, ms: number) => () => void;
}

/**
 * The next track starts this long before the current one is due to end, so
 * the stage crossfades over its tail instead of leaving a gap.
 */
export const DJ_CROSSFADE_MS = 4_000;

/**
 * The automatic DJ (ADR-0045): plays the catalog in a shuffled order, every
 * track once before any repeats (and never the same track twice in a row
 * across a reshuffle), each one sent to the stages a moment before the last
 * one ends. Runs as long as the host is on the air with the DJ turned on.
 */
export class Dj {
  private readonly tracks: readonly DjTrack[];
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly after: (fn: () => void, ms: number) => () => void;
  /** What's left of this shuffle, next track last. */
  private bag: DjTrack[] = [];
  private current: { track: DjTrack; startedAt: number } | null = null;
  private upcoming: DjTrack | null = null;
  private cancel: (() => void) | null = null;

  constructor(private readonly options: DjOptions) {
    this.tracks = options.tracks ?? DJ_CATALOG;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.after =
      options.after ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        (timer as { unref?: () => void }).unref?.();
        return () => clearTimeout(timer);
      });
  }

  get running(): boolean {
    return this.current !== null;
  }

  start(): void {
    if (this.current || this.tracks.length === 0) return;
    this.advance();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
    if (!this.current) return;
    this.current = null;
    this.options.stage.dj(null);
  }

  /** Moves on to the next track now. */
  skip(): boolean {
    if (!this.current) return false;
    this.advance();
    return true;
  }

  /** The track playing, when it started and when it ends (server clock). */
  nowPlaying(): { track: DjTrack; startedAt: number; endsAt: number } | null {
    const c = this.current;
    return c ? { ...c, endsAt: c.startedAt + c.track.seconds * 1000 } : null;
  }

  private advance(): void {
    this.cancel?.();
    const track = this.upcoming ?? this.draw();
    const next = this.draw();
    this.upcoming = next;
    const startedAt = this.now();
    this.current = { track, startedAt };
    this.options.stage.dj(track, startedAt, next);
    this.options.warm?.(next);
    this.cancel = this.after(() => this.advance(), Math.max(1_000, track.seconds * 1000 - DJ_CROSSFADE_MS));
  }

  private draw(): DjTrack {
    if (this.bag.length === 0) {
      const bag = [...this.tracks];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j] as DjTrack, bag[i] as DjTrack];
      }
      // The next shuffle mustn't start with the track that's on (or about to be).
      const last = this.upcoming ?? this.current?.track;
      if (bag.length > 1 && bag[bag.length - 1] === last) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1] as DjTrack, bag[0] as DjTrack];
      this.bag = bag;
    }
    return this.bag.pop() as DjTrack;
  }
}
