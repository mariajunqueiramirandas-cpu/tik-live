import { SignerError } from "./backend";

/** Runs at most `max` jobs at once and queues up to `maxQueue` more; beyond that it says "busy". */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}

  get inflight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active < this.max) {
      this.active += 1;
    } else {
      if (this.waiting.length >= this.maxQueue) {
        throw new SignerError(429, "busy", "The signer is handling as many requests as it can. Retry in a few seconds.");
      }
      // The finishing job hands its slot over, so `active` already counts this one.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
