import { randomUUID } from "node:crypto";
import type { Effect, Emotion } from "@tik-live/shared";
import type { Logger } from "../../log";
import type { Utterance } from "../brain/sentences";
import type { SafetyGate } from "../safety/gate";
import type { UsageReport } from "../usage";
import { estimateSpeechMs, type AudioClip, type TtsProvider } from "./tts";

/** Where a line came from, for latency metrics and analytics. */
export interface CueMeta {
  turnId: string;
  turnKind: string;
  /** When the event that triggered the turn arrived (or when the turn started). */
  originAt: number;
  /** True for the first line of a turn. */
  first: boolean;
  /** When the turn started being written. */
  startedAt?: number;
  /** When the model finished writing this line. */
  writtenAt?: number;
}

export interface SpeechCue {
  id: string;
  text: string;
  emotion: Emotion;
  /** Reactions the stage plays as the line starts. */
  fx?: Effect[];
  meta?: CueMeta;
  /** Typed by the channel owner in the studio. */
  operator?: boolean;
  audio: AudioClip | null;
  /** How long the cue should take; the stage may report completion earlier or later. */
  durationMs: number;
  /** When it passed the safety gate and its audio was ready. */
  readyAt?: number;
}

/** Where cues get performed: the stage server (browser source in OBS). */
export interface SpeechOutput {
  /** Resolves once the cue finished playing (or the signal aborts). */
  play(cue: SpeechCue, signal: AbortSignal): Promise<void>;
  /** Stop whatever is on stage right now. */
  interrupt(): void;
  /** Optional: a cue is ready ahead of time; stages can start loading its audio. */
  prefetch?(cue: SpeechCue): void;
}

interface Pending {
  generation: number;
  text: string;
  meta: CueMeta | undefined;
  operator: boolean;
  prepared: Promise<SpeechCue | null>;
  /** Set once preparation finished (null: blocked or failed). */
  ready?: SpeechCue | null;
  /** Cancels synthesis when the line is dropped before it's performed. */
  abort: AbortController;
}

/** A line that was taken off the queue before it aired. */
export interface DroppedLine {
  text: string;
  meta: CueMeta | undefined;
  operator: boolean;
}

function droppedLine(item: Pending): DroppedLine {
  return { text: item.text, meta: item.meta, operator: item.operator };
}

export interface EnqueueOptions {
  /** Skips the safety gate (operator-typed lines only). */
  trusted?: boolean;
  meta?: CueMeta;
  /** Goes ahead of the host's queued lines, right after the current sentence (operator lines). */
  front?: boolean;
  /** What the line replies to, for the safety moderator. */
  context?: string;
}

export interface SpeechPipelineEvents {
  onSpoken?: (cue: SpeechCue) => void;
  onDropped?: (text: string, reason: string, emotion: Emotion, meta?: CueMeta) => void;
  onUsage?: (usage: UsageReport) => void;
  log?: Logger;
}

/**
 * Turns utterances into performed speech, in order.
 *
 * Safety review and TTS for each sentence start the moment the sentence
 * arrives and run in parallel (so moderation adds no latency on top of
 * synthesis), but cues are performed strictly in the order they were
 * enqueued, and only if they passed the safety gate.
 *
 * The sentence is the unit of speech (ADR-0022): once a sentence is on
 * stage it plays to the end. The director changes course between sentences
 * by dropping lines that are still queued (`drop`), which also cancels their
 * synthesis; only the kill switch (`stop`) cuts a sentence.
 */
export class SpeechPipeline {
  private queue: Pending[] = [];
  private draining = false;
  private generation = 0;
  private playback = new AbortController();
  private current: SpeechCue | undefined;
  /** Taken off the queue, waiting for its audio before going on stage. */
  private head: Pending | undefined;
  private lastFinishedAt: number;

  constructor(
    private tts: TtsProvider,
    private readonly safety: SafetyGate,
    private readonly output: SpeechOutput,
    private readonly events: SpeechPipelineEvents = {},
    private readonly now: () => number = Date.now,
  ) {
    this.lastFinishedAt = now();
  }

  /** Swaps the voice (e.g. the owner picked a new one while live). */
  setTts(tts: TtsProvider): void {
    this.tts = tts;
  }

  /** The voice's only language, if it has one. */
  get ttsLanguage(): string | undefined {
    return this.tts.language;
  }

  get ttsName(): string {
    return this.tts.name;
  }

  /** Queue a sentence. */
  enqueue(utterance: Utterance, options: EnqueueOptions = {}): void {
    const abort = new AbortController();
    const operator = options.trusted ?? false;
    const pending: Pending = {
      generation: this.generation,
      text: utterance.text,
      meta: options.meta,
      operator,
      abort,
      prepared: Promise.resolve(null),
    };
    pending.prepared = this.prepare(utterance, operator, options.meta, options.context, abort.signal).then((cue) => {
      pending.ready = cue;
      return cue;
    });
    if (options.front) {
      // After any operator lines already waiting, so they keep their order.
      const at = this.queue.findIndex((item) => !item.operator);
      this.queue.splice(at === -1 ? this.queue.length : at, 0, pending);
    } else {
      this.queue.push(pending);
    }
    void this.drain();
  }

  /**
   * Drops queued lines that match, including the next one if it's still
   * waiting for its audio (never the one on stage), and cancels their
   * synthesis. Returns the lines dropped, in order.
   */
  drop(match: (meta: CueMeta | undefined, operator: boolean) => boolean): DroppedLine[] {
    const kept: Pending[] = [];
    const dropped: DroppedLine[] = [];
    // Not on stage yet: the drain loop skips it once its preparation settles.
    if (this.head && !this.head.abort.signal.aborted && match(this.head.meta, this.head.operator)) {
      this.head.abort.abort();
      dropped.push(droppedLine(this.head));
    }
    for (const item of this.queue) {
      if (match(item.meta, item.operator)) {
        item.abort.abort();
        dropped.push(droppedLine(item));
      } else {
        kept.push(item);
      }
    }
    this.queue = kept;
    return dropped;
  }

  /** What the host is saying and has queued to say next, in order. */
  upcoming(): string[] {
    const now = this.current?.text ?? this.nextUp()?.text;
    return [...(now !== undefined ? [now] : []), ...this.queue.map((item) => item.text)];
  }

  /** The turn the line on stage (or, between lines, the next one) belongs to. */
  activeMeta(): CueMeta | undefined {
    return this.current?.meta ?? this.nextUp()?.meta ?? this.queue[0]?.meta;
  }

  /** The line waiting for its audio before going on stage, unless it was dropped. */
  private nextUp(): Pending | undefined {
    return this.head && !this.head.abort.signal.aborted ? this.head : undefined;
  }

  /** Sentences waiting to be performed, not counting the one on stage. */
  pending(): number {
    return this.queue.length;
  }

  isSpeaking(): boolean {
    return this.current !== undefined;
  }

  isIdle(): boolean {
    return !this.draining && this.queue.length === 0;
  }

  /** Milliseconds since the host last finished a sentence (0 while talking). */
  silenceMs(): number {
    return this.isIdle() ? this.now() - this.lastFinishedAt : 0;
  }

  nowPlaying(): SpeechCue | undefined {
    return this.current;
  }

  /** Kill switch: drop everything queued and cut off the current sentence. Returns what was cut, in order. */
  stop(): DroppedLine[] {
    const cut: DroppedLine[] = [];
    if (this.current) cut.push({ text: this.current.text, meta: this.current.meta, operator: this.current.operator === true });
    if (this.head) cut.push(droppedLine(this.head));
    for (const item of this.queue) cut.push(droppedLine(item));
    this.generation += 1;
    for (const item of this.queue) item.abort.abort();
    this.head?.abort.abort();
    this.head = undefined;
    this.queue = [];
    this.playback.abort();
    this.playback = new AbortController();
    this.output.interrupt();
    return cut;
  }

  private async prepare(utterance: Utterance, trusted: boolean, meta: CueMeta | undefined, context: string | undefined, signal: AbortSignal): Promise<SpeechCue | null> {
    const id = randomUUID();
    const tts = this.tts;
    const [verdict, audio] = await Promise.all([
      trusted ? Promise.resolve({ safe: true as const }) : this.safety.check(utterance.text, context),
      tts.synthesize(utterance.text, utterance.emotion, signal).catch((err: unknown) => {
        if (!signal.aborted) this.events.log?.warn("TTS failed; falling back to captions", err);
        return null;
      }),
    ]);
    if (audio) this.events.onUsage?.({ kind: "tts", characters: utterance.text.length });
    // Dropped while preparing: it will never be performed, so it isn't reported either.
    if (signal.aborted) return null;
    if (!verdict.safe) {
      this.events.log?.warn(`blocked line (${verdict.reason}): ${utterance.text}`);
      this.events.onDropped?.(utterance.text, verdict.reason, utterance.emotion, meta);
      return null;
    }
    const cue: SpeechCue = {
      id,
      text: utterance.text,
      emotion: utterance.emotion,
      audio,
      durationMs: audio?.durationMs ?? estimateSpeechMs(utterance.text),
      readyAt: this.now(),
      ...(utterance.fx?.length ? { fx: utterance.fx } : {}),
      ...(meta ? { meta } : {}),
      ...(trusted ? { operator: true } : {}),
    };
    // Lines usually finish preparing while the previous one is still playing.
    if (audio && this.current) this.output.prefetch?.(cue);
    return cue;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift() as Pending;
        this.head = next;
        const cue = await next.prepared;
        this.head = undefined;
        if (!cue || next.generation !== this.generation || next.abort.signal.aborted) continue;
        this.current = cue;
        // The next line is often ready already: let the stage load it now.
        const upcoming = this.queue[0]?.ready;
        if (upcoming?.audio) this.output.prefetch?.(upcoming);
        try {
          await this.output.play(cue, this.playback.signal);
        } catch (err) {
          this.events.log?.warn("playback failed", err);
        }
        this.current = undefined;
        this.lastFinishedAt = this.now();
        if (next.generation === this.generation) this.events.onSpoken?.(cue);
      }
    } finally {
      this.draining = false;
      this.lastFinishedAt = this.now();
    }
  }
}
