/**
 * Event-loop lag (ADR-0007): a timer that should fire every 500 ms records
 * how late it actually fired. The worst delay over the last ten seconds
 * goes into /readyz, where sustained lag over 200 ms means "overloaded".
 */
export class LagMonitor {
  private readonly samples: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private expected = 0;

  constructor(private readonly intervalMs = 500) {}

  start(): void {
    this.expected = performance.now() + this.intervalMs;
    this.timer = setInterval(() => {
      const now = performance.now();
      this.samples.push(Math.max(0, now - this.expected));
      if (this.samples.length > 20) this.samples.shift();
      this.expected = now + this.intervalMs;
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Worst lag in milliseconds over the recent window. */
  maxLagMs(): number {
    return this.samples.length ? Math.round(Math.max(...this.samples)) : 0;
  }
}

export const lagMonitor = new LagMonitor();
