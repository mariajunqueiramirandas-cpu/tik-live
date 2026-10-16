/**
 * Turns frames and voice that arrive whenever the stage produces them into
 * the steady streams a raw encoder input needs (ADR-0020). ffmpeg reads raw
 * video and PCM without timestamps: it counts frames and samples. So the
 * pacer writes exactly `fps` frames per second of wall-clock time from a
 * small queue that absorbs uneven arrival (repeating the last frame only
 * when the queue runs dry, dropping one when it runs long), and keeps the
 * audio within a few packets of the same clock (silence fills gaps). Both
 * start together once the queue has its first frames.
 */
export interface AvTarget {
  writeVideo(frame: Uint8Array): void;
  writeAudio(pcm: Uint8Array): void;
}

export interface PacerOptions {
  /**
   * "frames": raw frames, paced here (queued, repeated or dropped to hit `fps`).
   * "stream": an encoded stream the stage already paced (ADR-0020); passed
   * through in order, never dropped, since every chunk matters to the decoder.
   */
  video?: "frames" | "stream";
  fps: number;
  /** Size of one raw frame (frames mode); other sizes are ignored. */
  frameBytes: number;
  sampleRate: number;
  channels: number;
  /**
   * How much later audio is written than video. A frame reaches the
   * broadcaster about two frames after it was drawn (asynchronous readback);
   * voice arrives within one 20 ms packet. Delaying audio keeps them in sync.
   */
  audioDelayMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface PacerStats {
  frames: number;
  /** Ticks with the queue empty: the stage was late, the last frame went out again. */
  repeated: number;
  /** Frames dropped because the queue ran long (the stage was ahead of the clock). */
  skipped: number;
  /** Average time a frame waited in the queue, in ms. */
  queueMs: number;
  /** Milliseconds of silence written to cover gaps in the voice stream. */
  silenceMs: number;
}

/** Frames queued before the clock starts, and the most the queue keeps after a tick. */
const START_DEPTH = 2;
/** Hard limit on queued frames. */
const MAX_DEPTH = 4;
/** Stream mode: chunks held before the encoder is attached (a few seconds of video). */
const MAX_PENDING_CHUNKS = 300;
/** Stream mode: how often the audio is checked against the clock. */
const AUDIO_CHECK_MS = 40;

/** Bytes per sample for 16-bit PCM. */
const SAMPLE_BYTES = 2;
/** Audio may run this far behind the clock before silence fills the gap. */
const UNDERRUN_MS = 120;
/** Audio running this far ahead of the clock is dropped (never expected). */
const OVERRUN_MS = 500;

export class AvPacer {
  private target: AvTarget | null = null;
  private readonly queue: Array<{ frame: Uint8Array; at: number }> = [];
  private readonly pending: Uint8Array[] = [];
  private readonly stream: boolean;
  private last: Uint8Array | null = null;
  private started = false;
  private stopped = false;
  private t0 = 0;
  private ticks = 0;
  private samplesWritten = 0;
  private timer: unknown = null;
  private readonly frameMs: number;
  private readonly bytesPerFrame: number;
  private readonly delaySamples: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private silence = new Uint8Array(0);
  private readonly stats: PacerStats = { frames: 0, repeated: 0, skipped: 0, queueMs: 0, silenceMs: 0 };

  constructor(private readonly options: PacerOptions) {
    this.stream = options.video === "stream";
    this.frameMs = 1000 / options.fps;
    this.bytesPerFrame = SAMPLE_BYTES * options.channels;
    this.delaySamples = Math.round(((options.audioDelayMs ?? 0) / 1000) * options.sampleRate);
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get counters(): PacerStats {
    return { ...this.stats, queueMs: Math.round(this.stats.queueMs * 10) / 10 };
  }

  /** A finished frame from the stage (I420, exactly `frameBytes`). Anything else is ignored. */
  video(frame: Uint8Array): void {
    if (this.stopped) return;
    if (this.stream) {
      if (this.started && this.target) {
        this.target.writeVideo(frame);
        this.stats.frames += 1;
        return;
      }
      if (this.pending.length < MAX_PENDING_CHUNKS) this.pending.push(frame);
      if (this.target) this.start();
      return;
    }
    if (frame.byteLength !== this.options.frameBytes) return;
    this.queue.push({ frame, at: this.now() });
    if (this.queue.length > MAX_DEPTH) {
      this.queue.shift();
      this.stats.skipped += 1;
    }
    if (this.target && !this.started && this.queue.length >= START_DEPTH) this.start();
  }

  /** Voice from the stage: 16-bit stereo PCM. Dropped until the first frame starts the clock. */
  audio(pcm: Uint8Array): void {
    if (!this.started || this.stopped || !this.target) return;
    const samples = Math.floor(pcm.byteLength / this.bytesPerFrame);
    if (samples === 0) return;
    if (this.samplesWritten - this.expectedSamples() > (OVERRUN_MS / 1000) * this.options.sampleRate) return;
    this.target.writeAudio(samples * this.bytesPerFrame === pcm.byteLength ? pcm : pcm.subarray(0, samples * this.bytesPerFrame));
    this.samplesWritten += samples;
  }

  /** Starts writing to the encoder once the queue has its first frames. */
  attach(target: AvTarget): void {
    this.target = target;
    if (this.started) return;
    if (this.stream ? this.pending.length > 0 : this.queue.length >= START_DEPTH) this.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private start(): void {
    this.started = true;
    this.t0 = this.now();
    this.writeSilence(this.delaySamples);
    if (!this.stream) {
      this.tick();
      return;
    }
    for (const chunk of this.pending.splice(0)) {
      this.target?.writeVideo(chunk);
      this.stats.frames += 1;
    }
    const check = () => {
      if (this.stopped) return;
      this.checkAudio();
      this.timer = this.setTimer(check, AUDIO_CHECK_MS);
    };
    this.timer = this.setTimer(check, AUDIO_CHECK_MS);
  }

  /** Fills a gap in the voice with silence so the audio stays on the clock. */
  private checkAudio(): void {
    const behind = this.expectedSamples() - this.samplesWritten;
    if (behind > (UNDERRUN_MS / 1000) * this.options.sampleRate) this.writeSilence(Math.round(behind));
  }

  /** Samples that should have been written by now, by the wall clock. */
  private expectedSamples(): number {
    return ((this.now() - this.t0) / 1000) * this.options.sampleRate + this.delaySamples;
  }

  private tick(): void {
    if (this.stopped || !this.target) return;
    let next = this.queue.shift();
    // Running long (the stage is a little faster than this clock): drop one so the delay stays bounded.
    if (next && this.queue.length > START_DEPTH) {
      next = this.queue.shift();
      this.stats.skipped += 1;
    }
    if (next) {
      this.last = next.frame;
      const waited = this.now() - next.at;
      this.stats.queueMs = this.stats.frames === 0 ? waited : this.stats.queueMs * 0.95 + waited * 0.05;
    } else {
      this.stats.repeated += 1;
    }
    if (!this.last) return;
    this.target.writeVideo(this.last);
    this.stats.frames += 1;
    this.ticks += 1;

    this.checkAudio();

    // Deadlines come from the start time, so timer jitter never accumulates.
    // After a long stall (event loop blocked), catch up one frame per tick.
    const due = this.t0 + this.ticks * this.frameMs;
    this.timer = this.setTimer(() => this.tick(), Math.max(0, due - this.now()));
  }

  private writeSilence(samples: number): void {
    if (samples <= 0 || !this.target) return;
    const bytes = samples * this.bytesPerFrame;
    if (this.silence.byteLength < bytes) this.silence = new Uint8Array(bytes);
    this.target.writeAudio(this.silence.subarray(0, bytes));
    this.samplesWritten += samples;
    this.stats.silenceMs += Math.round((samples / this.options.sampleRate) * 1000);
  }
}
