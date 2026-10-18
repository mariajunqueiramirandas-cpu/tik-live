/** Where a reply's time went, from the viewer's event to the host's first line going on stage. */
export interface LatencyStages {
  /** Waiting for the host's turn: the turn before it, a game moment. */
  waitMs: number;
  /** The model writing the first line. */
  writeMs: number;
  /** The safety check and the voice for that line. */
  voiceMs: number;
  /** Waiting for the line before it to finish playing. */
  queueMs: number;
}

/** Rolling window of chat-to-first-audio latencies, for the studio health panel (ADR-0012). */
export class LatencyTracker {
  private readonly samples: number[] = [];
  private readonly stages: LatencyStages[] = [];

  constructor(private readonly size = 200) {}

  record(ms: number, stages?: LatencyStages): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples.push(ms);
    if (this.samples.length > this.size) this.samples.shift();
    if (!stages || !Object.values(stages).every(Number.isFinite)) return;
    this.stages.push(stages);
    if (this.stages.length > this.size) this.stages.shift();
  }

  summary(): { p50: number; p95: number; samples: number; stages: LatencyStages | null } | null {
    if (this.samples.length === 0) return null;
    // Each stage's own median: they needn't add up to the overall one.
    const median = (key: keyof LatencyStages) => Math.max(0, quantile(this.stages.map((stage) => stage[key]), 0.5));
    return {
      p50: quantile(this.samples, 0.5),
      p95: quantile(this.samples, 0.95),
      samples: this.samples.length,
      stages: this.stages.length ? { waitMs: median("waitMs"), writeMs: median("writeMs"), voiceMs: median("voiceMs"), queueMs: median("queueMs") } : null,
    };
  }
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number);
}
