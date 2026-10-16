import type { Entitlements } from "../billing/entitlements";
import type { Db } from "../db/client";
import type { Logger } from "../log";
import { listAllChannelOwners } from "../repos/channels";
import { purgeSamples, purgeUtterances } from "../repos/streams";

const DAY_MS = 86_400_000;

/**
 * Transcript retention (ADR-0005, ADR-0013): deletes what each host said and
 * per-minute stream samples older than the owner's plan keeps. Stream
 * summaries (peak viewers, gifts) stay for analytics.
 */
export class RetentionJob {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: { db: Db; entitlements: Entitlements; log: Logger; now?: () => number; intervalMs?: number },
  ) {}

  /** First run a few minutes after boot (not during the restart rush), then daily. */
  start(firstDelayMs = 5 * 60_000): void {
    const schedule = (delay: number) => {
      this.timer = setTimeout(async () => {
        await this.runOnce().catch((err) => this.options.log.error("retention run failed", err));
        schedule(this.options.intervalMs ?? DAY_MS);
      }, delay);
      (this.timer as { unref?: () => void }).unref?.();
    };
    schedule(firstDelayMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<{ lines: number; samples: number }> {
    const { db, entitlements, log } = this.options;
    const now = this.options.now?.() ?? Date.now();
    let lines = 0;
    let samples = 0;
    for (const { id, ownerId } of await listAllChannelOwners(db)) {
      const plan = await entitlements.planFor(ownerId);
      const days = plan.limits.transcriptRetentionDays;
      if (!Number.isFinite(days)) continue;
      const before = new Date(now - days * DAY_MS);
      lines += await purgeUtterances(db, id, before);
      samples += await purgeSamples(db, id, before);
    }
    if (lines || samples) log.info(`retention removed ${lines} transcript lines and ${samples} samples`);
    return { lines, samples };
  }
}
