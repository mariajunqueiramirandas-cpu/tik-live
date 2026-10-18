/** Likes older than this no longer count toward the like ranking (ADR-0028). */
export const LIKE_WINDOW_MS = 15 * 60_000;
/** Gifts older than this no longer count toward the gift ranking (ADR-0029). */
export const GIFT_WINDOW_MS = 60 * 60_000;

interface Batch {
  id: string;
  count: number;
  at: number;
}

/**
 * Who gave the most recently: a sliding window over events (likes, or a
 * gift's diamonds). Everything older than the window is dropped, so the
 * board shows who's giving now, not who gave hours ago.
 */
export class RollingBoard {
  /** Events in arrival order, oldest first. */
  private batches: Batch[] = [];
  /** Index of the oldest batch still in the window. */
  private head = 0;
  private readonly totals = new Map<string, { name: string; value: number }>();
  private version = 0;

  constructor(
    private readonly now: () => number = Date.now,
    readonly windowMs: number,
  ) {}

  add(id: string, name: string, count: number): void {
    if (count <= 0) return;
    const at = this.now();
    this.prune(at);
    this.batches.push({ id, count, at });
    const row = this.totals.get(id);
    if (row) {
      row.name = name;
      row.value += count;
    } else this.totals.set(id, { name, value: count });
    this.version += 1;
  }

  /** The top `n` in the window, most first (ties: who started first). */
  top(n: number): Array<{ name: string; value: number }> {
    this.prune(this.now());
    return [...this.totals.values()]
      .sort((a, b) => b.value - a.value)
      .slice(0, n)
      .map((row) => ({ name: row.name, value: row.value }));
  }

  /** Changes whenever the board does (a like came in or one expired). */
  revision(): number {
    this.prune(this.now());
    return this.version;
  }

  clear(): void {
    this.batches = [];
    this.head = 0;
    this.totals.clear();
    this.version += 1;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    const batches = this.batches;
    let changed = false;
    while (this.head < batches.length && (batches[this.head] as Batch).at <= cutoff) {
      const batch = batches[this.head] as Batch;
      this.head += 1;
      const row = this.totals.get(batch.id);
      if (!row) continue;
      row.value -= batch.count;
      if (row.value <= 0) this.totals.delete(batch.id);
      changed = true;
    }
    // Compact once the expired prefix is most of the array.
    if (this.head > 1024 && this.head * 2 > batches.length) {
      this.batches = batches.slice(this.head);
      this.head = 0;
    }
    if (changed) this.version += 1;
  }
}
