import { estimateCostUsd } from "@tik-live/shared";
import { EMPTY_USAGE, type UsageDelta } from "../repos/usage";

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
    this.pending.costUsd += estimateCostUsd(report.model, report);
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
