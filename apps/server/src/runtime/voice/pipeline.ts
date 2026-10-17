import { randomUUID } from "node:crypto";
import type { Emotion } from "@tik-live/shared";
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
}

export interface SpeechCue {
  id: string;
  text: string;
  emotion: Emotion;
  meta?: CueMeta;
  /** Typed by the channel owner in the studio. */
  operator?: boolean;
  audio: AudioClip | null;
  /** How long the cue should take; the stage may report completion earlier or later. */
  durationMs: number;
}

/**
 * Where cues get performed: the stages (browser sources in OBS, the cloud
 * broadcaster). Cues queue on the stage and play back to back in the order
 * they were sent (ADR-0022), so a cue never cuts off the one before it.
 */
export interface SpeechOutput {
  /** Queues the cue after the ones already sent; resolves once it finished, was dropped, or was interrupted. */
  play(cue: SpeechCue): Promise<void>;
  /** Takes back queued cues that haven't started; one already playing finishes. */
  drop(ids: readonly string[]): void;
  /** Stops everything on stage right now (kill switch). */
  interrupt(): void;
}

export interface SpeechPipelineEvents {
  onSpoken?: (cue: SpeechCue) => void;
  onDropped?: (text: string, reason: string, emotion: Emotion, meta?: CueMeta) => void;
  onUsage?: (usage: UsageReport) => void;
  log?: Logger;
}

export interface EnqueueOptions {
  /** Skips the safety gate (operator-typed lines only). */
  trusted?: boolean;
  meta?: CueMeta;
  /** Higher-priority speech can take the stage from lower-priority lines that haven't started. */
  priority?: number;
}

/** Operator lines can't be preempted by the show. */
export const OPERATOR_PRIORITY = 100;

/** Cues on stage at once: the one playing plus the next, already fetched and decoded there. */
const LOOKAHEAD = 2;
/** A voice slower than this for one sentence falls back to captions for it. */
const TTS_DEADLINE_MS = 12_000;
/** Turns whose rest was cut, remembered so their late sentences are discarded. */
const CUT_TURNS_KEPT = 64;

interface Line {
  id: string;
  /** Sentences of one turn share a key; a line without a turn is its own. */
  turn: string;
  utterance: Utterance;
  trusted: boolean;
  priority: number;
  meta?: CueMeta;
  /** Ready to send: the cue, or null when it must not be said. */
  settled: Promise<SpeechCue | null>;
  cancel(): void;
  cancelled: boolean;
  cue?: SpeechCue;
}

/**
 * Turns utterances into performed speech, in order (ADR-0022).
 *
 * - Safety review and TTS for each sentence start the moment it arrives and
 *   run in parallel, each with a deadline, so one slow call can't stall the
 *   show.
 * - A turn is one thought. If one of its sentences is blocked, the rest of
 *   that turn is dropped too: the host never says sentence three of a reply
 *   whose sentence two was removed.
 * - Cues go to the stage one ahead of time, so the next sentence plays right
 *   after the current one, without a round trip in between.
 * - Higher-priority speech (a reaction to a gift) can take back
 *   lower-priority sentences (filler) that haven't started. Nothing is ever
 *   cut off mid-word except by the kill switch.
 */
export class SpeechPipeline {
  /** Not yet sent to the stage, in speaking order. */
  private lines: Line[] = [];
  /** Sent to the stage, in speaking order; the first one is playing. */
  private onStage: Line[] = [];
  private pumping = false;
  private headSince: number;
  private lastFinishedAt: number;
  private readonly cutTurns = new Set<string>();
  /** The last sentence handed to the voice per turn (recent turns only), so the next one continues its intonation. */
  private readonly previousText = new Map<string, string>();

  constructor(
    private tts: TtsProvider,
    private readonly safety: SafetyGate,
    private readonly output: SpeechOutput,
    private readonly events: SpeechPipelineEvents = {},
    private readonly now: () => number = Date.now,
  ) {
    this.lastFinishedAt = now();
    this.headSince = this.lastFinishedAt;
  }

  /** Swaps the voice (e.g. the owner picked a new one while live). */
  setTts(tts: TtsProvider): void {
    this.tts = tts;
  }

  get ttsName(): string {
    return this.tts.name;
  }

  /**
   * Queues a sentence. Returns false when it was discarded because its turn
   * was already cut (a blocked sentence, or preempted): stop generating that turn.
   */
  enqueue(utterance: Utterance, options: EnqueueOptions = {}): boolean {
    const id = randomUUID();
    const turn = options.meta?.turnId ?? id;
    if (this.cutTurns.has(turn)) return false;
    let cancel!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      cancel = () => resolve(null);
    });
    const abort = new AbortController();
    const line: Line = {
      id,
      turn,
      utterance,
      trusted: options.trusted ?? false,
      priority: options.priority ?? (options.trusted ? OPERATOR_PRIORITY : 0),
      ...(options.meta ? { meta: options.meta } : {}),
      settled: cancelled,
      cancelled: false,
      cancel: () => {
        line.cancelled = true;
        abort.abort();
        cancel();
      },
    };
    line.settled = Promise.race([this.prepare(line, abort.signal), cancelled]);
    this.lines.push(line);
    void this.pump();
    return true;
  }

  /** Sentences waiting to be performed, not counting the one playing. */
  pending(): number {
    return this.lines.length + Math.max(0, this.onStage.length - 1);
  }

  isSpeaking(): boolean {
    return this.onStage.length > 0;
  }

  isIdle(): boolean {
    return this.lines.length === 0 && this.onStage.length === 0;
  }

  /** Milliseconds since the host last finished a sentence (0 while talking). */
  silenceMs(): number {
    return this.isIdle() ? this.now() - this.lastFinishedAt : 0;
  }

  /** Roughly how long until everything queued has been said. */
  remainingMs(): number {
    let total = 0;
    for (const [i, line] of this.onStage.entries()) {
      const duration = line.cue?.durationMs ?? 0;
      total += i === 0 ? Math.max(0, duration - (this.now() - this.headSince)) : duration;
    }
    for (const line of this.lines) total += line.cue?.durationMs ?? estimateSpeechMs(line.utterance.text);
    return total;
  }

  /** What the host is about to say (playing now, then queued), so the next turn can follow on from it. */
  upcoming(): string[] {
    return [...this.onStage, ...this.lines].map((line) => line.utterance.text);
  }

  nowPlaying(): SpeechCue | undefined {
    return this.onStage[0]?.cue;
  }

  /**
   * Takes the stage for speech of `priority`: lower-priority sentences that
   * haven't started are dropped, and their turns end there. The sentence
   * playing now finishes. Returns how many sentences were dropped.
   */
  preempt(priority: number): number {
    const queued = this.lines.filter((line) => line.priority < priority);
    const sent = this.onStage.slice(1).filter((line) => line.priority < priority);
    if (queued.length === 0 && sent.length === 0) return 0;
    for (const line of [...queued, ...sent]) this.cutTurn(line.turn);
    for (const line of queued) line.cancel();
    this.lines = this.lines.filter((line) => !line.cancelled);
    if (sent.length) {
      this.onStage = this.onStage.filter((line) => !sent.includes(line));
      this.output.drop(sent.map((line) => line.cue!.id));
    }
    this.events.log?.debug(`made way for priority ${priority} speech (${queued.length + sent.length} lines dropped)`);
    void this.pump();
    return queued.length + sent.length;
  }

  /** Kill switch: drop everything queued and cut off the current sentence. */
  stop(): void {
    for (const line of [...this.lines, ...this.onStage]) {
      line.cancel();
      this.cutTurn(line.turn);
    }
    this.lines = [];
    this.onStage = [];
    this.output.interrupt();
    this.lastFinishedAt = this.now();
  }

  private cutTurn(turn: string): void {
    this.cutTurns.add(turn);
    this.previousText.delete(turn);
    if (this.cutTurns.size > CUT_TURNS_KEPT) this.cutTurns.delete(this.cutTurns.values().next().value as string);
  }

  private async prepare(line: Line, signal: AbortSignal): Promise<SpeechCue | null> {
    const { utterance, trusted, meta } = line;
    const tts = this.tts;
    const previousText = this.previousText.get(line.turn);
    if (line.turn !== line.id) {
      this.previousText.delete(line.turn);
      this.previousText.set(line.turn, utterance.text);
      if (this.previousText.size > CUT_TURNS_KEPT) this.previousText.delete(this.previousText.keys().next().value as string);
    }
    const ttsSignal = AbortSignal.any([signal, AbortSignal.timeout(TTS_DEADLINE_MS)]);
    const [verdict, audio] = await Promise.all([
      trusted ? Promise.resolve({ safe: true as const }) : this.safety.check(utterance.text),
      // The deadline also covers voices that ignore the abort signal.
      withDeadline(tts.synthesize(utterance.text, utterance.emotion, ttsSignal, previousText ? { previousText } : undefined), TTS_DEADLINE_MS, "the voice").catch(
        (err: unknown) => {
          if (!signal.aborted) this.events.log?.warn("TTS failed; falling back to captions for this line", err);
          return null;
        },
      ),
    ]);
    if (audio) this.events.onUsage?.({ kind: "tts", characters: utterance.text.length });
    if (line.cancelled) return null;
    if (!verdict.safe) {
      this.events.log?.warn(`blocked line (${verdict.reason}): ${utterance.text}`);
      this.events.onDropped?.(utterance.text, verdict.reason, utterance.emotion, meta);
      this.dropRestOfTurn(line);
      return null;
    }
    return {
      id: line.id,
      text: utterance.text,
      emotion: utterance.emotion,
      audio,
      durationMs: audio?.durationMs ?? estimateSpeechMs(utterance.text),
      ...(meta ? { meta } : {}),
      ...(trusted ? { operator: true } : {}),
    };
  }

  /** A sentence was blocked: what came after it in the same turn no longer makes sense. */
  private dropRestOfTurn(blocked: Line): void {
    if (blocked.turn === blocked.id) return;
    this.cutTurn(blocked.turn);
    const index = this.lines.indexOf(blocked);
    const rest = this.lines.filter((line, i) => line.turn === blocked.turn && i > index);
    for (const line of rest) {
      line.cancel();
      this.events.onDropped?.(line.utterance.text, "skipped after a blocked line", line.utterance.emotion, line.meta);
    }
    this.lines = this.lines.filter((line) => !line.cancelled || line === blocked);
  }

  /** Sends lines to the stage in order, keeping one ready behind the one playing. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.lines.length > 0 && this.onStage.length < LOOKAHEAD) {
        const line = this.lines[0] as Line;
        const cue = await line.settled;
        if (this.lines[0] !== line) continue; // removed while it was being prepared
        this.lines.shift();
        if (cue) this.send(line, cue);
      }
    } finally {
      this.pumping = false;
    }
  }

  private send(line: Line, cue: SpeechCue): void {
    line.cue = cue;
    this.onStage.push(line);
    if (this.onStage.length === 1) this.headSince = this.now();
    this.output
      .play(cue)
      .catch((err: unknown) => this.events.log?.warn("playback failed", err))
      .then(() => this.finished(line));
  }

  private finished(line: Line): void {
    const index = this.onStage.indexOf(line);
    if (index === -1) return; // dropped or stopped
    // The stage plays in order: anything before this line is over too.
    this.onStage.splice(0, index + 1);
    this.headSince = this.lastFinishedAt = this.now();
    if (!line.cancelled) this.events.onSpoken?.(line.cue!);
    void this.pump();
  }
}

/** Rejects if `promise` takes longer than `ms`. */
export function withDeadline<T>(promise: Promise<T>, ms: number, what = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
