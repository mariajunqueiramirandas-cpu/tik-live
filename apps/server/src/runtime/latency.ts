/** Rolling window of chat-to-first-audio latencies, for the studio health panel (ADR-0012). */
export class LatencyTracker {
  private readonly samples: number[] = [];

  constructor(private readonly size = 200) {}

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples.push(ms);
    if (this.samples.length > this.size) this.samples.shift();
  }

  summary(): { p50: number; p95: number; samples: number } | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
    return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), samples: sorted.length };
  }
}
