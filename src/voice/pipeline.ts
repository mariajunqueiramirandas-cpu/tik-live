import { randomUUID } from "node:crypto";
import type { Emotion, Utterance } from "../brain/sentences.js";
import { createLogger } from "../log.js";
import type { SafetyGate } from "../safety/gate.js";
import { estimateSpeechMs, type AudioClip, type TtsProvider } from "./tts.js";

const log = createLogger("speech");

export interface SpeechCue {
  id: string;
  text: string;
  emotion: Emotion;
  audio: AudioClip | null;
  /** How long the cue should take; the stage may report completion earlier or later. */
  durationMs: number;
}

/** Where cues get performed: the stage server (browser source in OBS). */
export interface SpeechOutput {
  /** Resolves once the cue finished playing (or the signal aborts). */
  play(cue: SpeechCue, signal: AbortSignal): Promise<void>;
  /** Stop whatever is on stage right now. */
  interrupt(): void;
}

interface Pending {
  generation: number;
  prepared: Promise<SpeechCue | null>;
}

export interface SpeechPipelineEvents {
  onSpoken?: (cue: SpeechCue) => void;
  onDropped?: (text: string, reason: string) => void;
}

/**
 * Turns utterances into performed speech, in order.
 *
 * Safety review and TTS for each sentence start the moment the sentence
 * arrives and run in parallel (so moderation adds no latency on top of
 * synthesis), but cues are performed strictly in the order they were
 * enqueued, and only if they passed the safety gate.
 */
export class SpeechPipeline {
  private queue: Pending[] = [];
  private draining = false;
  private generation = 0;
  private playback = new AbortController();
  private current: SpeechCue | undefined;
  private lastFinishedAt: number;

  constructor(
    private readonly tts: TtsProvider,
    private readonly safety: SafetyGate,
    private readonly output: SpeechOutput,
    private readonly events: SpeechPipelineEvents = {},
    private readonly now: () => number = Date.now,
  ) {
    this.lastFinishedAt = now();
  }

  /** Queue a sentence. `trusted` skips the safety gate (operator-typed lines only). */
  enqueue(utterance: Utterance, trusted = false): void {
    const generation = this.generation;
    const prepared = this.prepare(utterance, trusted);
    this.queue.push({ generation, prepared });
    void this.drain();
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

  /** Kill switch: drop everything queued and cut off the current sentence. */
  stop(): void {
    this.generation += 1;
    this.queue = [];
    this.playback.abort();
    this.playback = new AbortController();
    this.output.interrupt();
  }

  private async prepare(utterance: Utterance, trusted: boolean): Promise<SpeechCue | null> {
    const id = randomUUID();
    const [verdict, audio] = await Promise.all([
      trusted ? Promise.resolve({ safe: true as const }) : this.safety.check(utterance.text),
      this.tts.synthesize(utterance.text, utterance.emotion).catch((err: unknown) => {
        log.warn("TTS failed; falling back to captions", err);
        return null;
      }),
    ]);
    if (!verdict.safe) {
      log.warn(`blocked line (${verdict.reason}): ${utterance.text}`);
      this.events.onDropped?.(utterance.text, verdict.reason);
      return null;
    }
    return {
      id,
      text: utterance.text,
      emotion: utterance.emotion,
      audio,
      durationMs: audio?.durationMs ?? estimateSpeechMs(utterance.text),
    };
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift() as Pending;
        const cue = await next.prepared;
        if (!cue || next.generation !== this.generation) continue;
        this.current = cue;
        try {
          await this.output.play(cue, this.playback.signal);
        } catch (err) {
          log.warn("playback failed", err);
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
