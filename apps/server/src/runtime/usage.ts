import { estimateCostUsd } from "@tik-live/shared";
import { dayKey, EMPTY_USAGE, type UsageDelta } from "../repos/usage";

/** One metered AI call, reported by the host brain, the moderator or TTS. */
export type UsageReport =
  | {
      kind: "turn" | "moderation";
      model: string;
      inputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      outputTokens: number;
    }
  | { kind: "tts"; characters: number };

/**
 * Accumulates usage in memory between flushes (ADR-0005: never await the
 * database on the speech path) and tracks the rolling hourly token budget.
 */
export class UsageMeter {
  private pending: UsageDelta = { ...EMPTY_USAGE };
  private readonly window: Array<{ at: number; tokens: number }> = [];

  constructor(private readonly now: () => number = Date.now) {}

  private today = { day: "", costUsd: 0 };

  /** Starts the day's running total from what's already recorded (after a restart). */
  seedToday(day: string, costUsd: number): void {
    this.today = { day, costUsd };
  }

  /** Estimated AI spend so far today (UTC), for the daily cap. */
  spentToday(): number {
    const day = dayKey(new Date(this.now()));
    if (this.today.day !== day) this.today = { day, costUsd: 0 };
    return this.today.costUsd;
  }

  record(report: UsageReport): void {
    if (report.kind === "tts") {
      this.pending.ttsCharacters += report.characters;
      return;
    }
    if (report.kind === "turn") this.pending.llmRequests += 1;
    else this.pending.moderationRequests += 1;
    this.pending.inputTokens += report.inputTokens;
    this.pending.cacheReadTokens += report.cacheReadTokens;
    this.pending.cacheWriteTokens += report.cacheWriteTokens;
    this.pending.outputTokens += report.outputTokens;
    const cost = estimateCostUsd(report.model, report);
    this.pending.costUsd += cost;
    this.spentToday();
    this.today.costUsd += cost;
    this.window.push({ at: this.now(), tokens: report.inputTokens + report.cacheWriteTokens + report.outputTokens });
  }

  addRuntimeSeconds(seconds: number): void {
    this.pending.runtimeSeconds += seconds;
  }

  addBroadcastSeconds(seconds: number): void {
    this.pending.broadcastSeconds += seconds;
  }

  /** Tokens spent in the last hour (cache reads excluded: they're cheap and don't signal runaway use). */
  tokensLastHour(): number {
    const cutoff = this.now() - 60 * 60 * 1000;
    while (this.window.length && (this.window[0] as { at: number }).at < cutoff) this.window.shift();
    return this.window.reduce((sum, entry) => sum + entry.tokens, 0);
  }

  /** Returns and clears what accumulated since the last call. */
  drain(): UsageDelta {
    const out = this.pending;
    this.pending = { ...EMPTY_USAGE };
    return out;
  }

  hasPending(): boolean {
    return Object.values(this.pending).some((value) => value !== 0);
  }
}
