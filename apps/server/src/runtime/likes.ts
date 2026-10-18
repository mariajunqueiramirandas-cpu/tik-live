/** Likes older than this no longer count toward the ranking (ADR-0028). */
export const LIKE_WINDOW_MS = 15 * 60_000;

interface LikeBatch {
  id: string;
  count: number;
  at: number;
}

/**
 * Who sent the most likes recently: a sliding window over like events.
 * Every like older than the window is dropped, so the board shows who's
 * tapping now, not who tapped an hour ago.
 */
export class LikeBoard {
  /** Like events in arrival order, oldest first. */
  private batches: LikeBatch[] = [];
  /** Index of the oldest batch still in the window. */
  private head = 0;
  private readonly totals = new Map<string, { name: string; likes: number }>();
  private version = 0;

  constructor(
    private readonly now: () => number = Date.now,
    readonly windowMs = LIKE_WINDOW_MS,
  ) {}

  add(id: string, name: string, count: number): void {
    if (count <= 0) return;
    const at = this.now();
    this.prune(at);
    this.batches.push({ id, count, at });
    const row = this.totals.get(id);
    if (row) {
      row.name = name;
      row.likes += count;
    } else this.totals.set(id, { name, likes: count });
    this.version += 1;
  }

  /** The top `n` likers in the window, most first (ties: who reached it first). */
  top(n: number): Array<{ name: string; likes: number }> {
    this.prune(this.now());
    return [...this.totals.values()]
      .sort((a, b) => b.likes - a.likes)
      .slice(0, n)
      .map((row) => ({ name: row.name, likes: row.likes }));
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
    while (this.head < batches.length && (batches[this.head] as LikeBatch).at <= cutoff) {
      const batch = batches[this.head] as LikeBatch;
      this.head += 1;
      const row = this.totals.get(batch.id);
      if (!row) continue;
      row.likes -= batch.count;
      if (row.likes <= 0) this.totals.delete(batch.id);
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
