import type { Emotion } from "@tik-live/shared";
import type { AudioEngine, PlaybackHandle } from "./audio";

/** A line as the server sends it (`speak` or `cue`). */
export interface Line {
  id: string;
  text: string;
  emotion: Emotion;
  audioUrl: string | null;
  durationMs: number;
  /** Word start times in ms, from the voice's alignment; estimated from the text when absent. */
  words?: number[] | undefined;
}

export interface Cue {
  line: Line;
  handle: PlaybackHandle | null;
  cancelled: boolean;
}

/** The breath between two queued lines, on the audio clock. */
const LINE_GAP_S = 0.14;

export interface SpeakerHooks {
  /** The line is about to sound (its audio is decoded and scheduled). */
  started?: (line: Line, handle: PlaybackHandle) => void;
  finished?: (line: Line) => void;
  /** The line played to the end (not stopped); on-air stages report it to the server. */
  spoken?: (id: string) => void;
}

/**
 * Plays lines in order, back to back (ADR-0022). `cue` appends to the queue,
 * so a line is never cut off by the next one; `speak` replaces everything
 * (previews and the demo); `drop` takes back queued lines that haven't
 * started; `stop` is the kill switch. Audio for queued lines is fetched and
 * decoded while the current one plays, so the next starts after a short
 * breath instead of a network round trip.
 */
export class Speaker {
  private cue: Cue | null = null;
  private queue: Line[] = [];
  private generation = 0;
  private runningGeneration = -1;

  constructor(
    private readonly audio: AudioEngine,
    private readonly hooks: SpeakerHooks = {},
  ) {}

  get current(): Cue | null {
    return this.cue;
  }

  /** Lines waiting behind the current one. */
  get queued(): number {
    return this.queue.length;
  }

  /** Cuts off whatever is playing and says this now. */
  speak(line: Line): void {
    this.stop();
    this.enqueue(line);
  }

  enqueue(line: Line): void {
    if (line.audioUrl) this.audio.prefetch(line.audioUrl);
    this.queue.push(line);
    if (this.runningGeneration !== this.generation) void this.run();
  }

  drop(ids: readonly string[]): void {
    this.queue = this.queue.filter((line) => !ids.includes(line.id));
  }

  stop(): void {
    this.generation += 1;
    this.queue = [];
    if (this.cue) {
      this.cue.cancelled = true;
      this.cue.handle?.stop();
      this.cue = null;
    }
    this.audio.stop();
  }

  private async run(): Promise<void> {
    const generation = this.generation;
    this.runningGeneration = generation;
    let lead = 0.02;
    try {
      while (this.queue.length > 0 && generation === this.generation) {
        const line = this.queue.shift() as Line;
        const cue: Cue = { line, handle: null, cancelled: false };
        this.cue = cue;
        const handle = await this.audio.play(line.text, line.audioUrl, line.durationMs, lead);
        if (cue.cancelled || generation !== this.generation) {
          handle.stop();
          return;
        }
        cue.handle = handle;
        this.hooks.started?.(line, handle);
        await handle.done;
        if (cue.cancelled || this.cue !== cue) return;
        this.cue = null;
        this.hooks.finished?.(line);
        this.hooks.spoken?.(line.id);
        lead = LINE_GAP_S;
      }
    } finally {
      if (this.runningGeneration === generation) this.runningGeneration = -1;
    }
  }
}
