/**
 * Quality governor (ADR-0009): watches frame pacing and steps render scale
 * and particle count down when frames are being dropped, and back up after
 * a sustained period of headroom. Runs every frame, so it never allocates.
 */
export interface QualityLevel {
  renderScale: number;
  moteFraction: number;
  /** The soft background renders at 1/n of the output size, then is scaled up. */
  atmosphereDownscale: number;
}

/**
 * Best first. "Ultra" supersamples: it draws half again past the display
 * and lets the browser or OBS scale it down, so edges and text come out
 * smoother than drawing at the display's own size.
 */
export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { renderScale: 1.5, moteFraction: 1, atmosphereDownscale: 2 },
  { renderScale: 1, moteFraction: 1, atmosphereDownscale: 3 },
  { renderScale: 0.85, moteFraction: 0.6, atmosphereDownscale: 4 },
  { renderScale: 0.7, moteFraction: 0.3, atmosphereDownscale: 4 },
];

const DOWN_AFTER_MS = 2_000;
const UP_AFTER_MS = 10_000;
const WINDOW = 120;

/** Fixed-size ring of samples with allocation-free percentiles. */
export class SampleRing {
  private readonly values: Float64Array;
  private readonly scratch: Float64Array;
  private next = 0;
  size = 0;

  constructor(readonly capacity: number) {
    this.values = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  push(value: number): void {
    this.values[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  clear(): void {
    this.size = 0;
    this.next = 0;
  }

  /** The q-quantile of the most recent `last` samples (all by default). */
  percentile(q: number, last = this.size): number {
    const n = Math.min(last, this.size);
    if (n === 0) return 0;
    for (let i = 0; i < n; i++) {
      this.scratch[i] = this.values[(this.next - n + i + this.capacity * 2) % this.capacity] as number;
    }
    const view = this.scratch.subarray(0, n);
    view.sort();
    return view[Math.min(n - 1, Math.floor(q * n))] as number;
  }
}

export class QualityGovernor {
  private levelIndex: number;
  private readonly intervals = new SampleRing(WINDOW);
  private readonly work = new SampleRing(WINDOW);
  /** The display's own cadence, learned from the first frames (60 Hz, OBS at 30 fps, 120 Hz, ...). */
  private naturalInterval = 0;
  private overSince: number | null = null;
  private underSince: number | null = null;

  constructor(
    initial = 0,
    private readonly locked = false,
  ) {
    this.levelIndex = Math.max(0, Math.min(QUALITY_LEVELS.length - 1, initial));
  }

  get level(): number {
    return this.levelIndex;
  }

  get settings(): QualityLevel {
    return QUALITY_LEVELS[this.levelIndex] as QualityLevel;
  }

  /**
   * Records one frame. `intervalMs` is the time since the previous frame,
   * `workMs` the time spent producing this one. Returns true when the level changed.
   */
  record(intervalMs: number, workMs: number, now: number): boolean {
    if (intervalMs > 250) return false; // tab was hidden or paused; ignore
    this.intervals.push(intervalMs);
    this.work.push(workMs);
    if (this.intervals.size >= 30) {
      // Learned once, then only allowed to creep up slowly, so sustained
      // dropped frames are never mistaken for a slower display.
      const p25 = this.intervals.percentile(0.25);
      this.naturalInterval = this.naturalInterval === 0 ? p25 : Math.min(this.naturalInterval * 1.001, p25);
    }
    if (this.locked || this.intervals.size < 30) return false;

    const recent = this.intervals.percentile(0.5, 30);
    const dropping = recent > this.naturalInterval * 1.45;
    const easy = recent < this.naturalInterval * 1.1 && this.work.percentile(0.95, 60) < this.naturalInterval * 0.5;

    if (dropping) {
      this.underSince = null;
      this.overSince ??= now;
      if (now - this.overSince > DOWN_AFTER_MS && this.levelIndex < QUALITY_LEVELS.length - 1) {
        this.levelIndex += 1;
        this.overSince = null;
        this.intervals.clear();
        return true;
      }
    } else if (easy) {
      this.overSince = null;
      this.underSince ??= now;
      if (now - this.underSince > UP_AFTER_MS && this.levelIndex > 0) {
        this.levelIndex -= 1;
        this.underSince = null;
        this.intervals.clear();
        return true;
      }
    } else {
      this.overSince = null;
      this.underSince = null;
    }
    return false;
  }

  fps(): number {
    return this.intervals.size ? 1000 / this.intervals.percentile(0.5) : 0;
  }

  frameP95(): number {
    return this.work.size ? this.work.percentile(0.95) : 0;
  }
}

/** Quantile of a plain list (tests and one-off use). */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}
