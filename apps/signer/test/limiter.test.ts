import { describe, expect, test } from "bun:test";
import { SignerError } from "../src/backend";
import { Limiter } from "../src/limiter";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("Limiter", () => {
  test("runs up to the limit at once and queues the rest in order", async () => {
    const limiter = new Limiter(2, 10);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const jobs = gates.map((gate, i) =>
      limiter.run(async () => {
        started.push(i);
        await gate.promise;
        return i;
      }),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(limiter.inflight).toBe(2);
    expect(limiter.queued).toBe(2);

    gates[0]!.resolve();
    await jobs[0];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    expect(limiter.inflight).toBe(2);

    gates.forEach((g) => g.resolve());
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3]);
    expect(limiter.inflight).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  test("says busy when the queue is full, and recovers", async () => {
    const limiter = new Limiter(1, 1);
    const gate = deferred();
    const first = limiter.run(() => gate.promise);
    const second = limiter.run(async () => "second");
    const third = limiter.run(async () => "third");
    await expect(third).rejects.toMatchObject({ code: "busy", status: 429 });
    expect(await Promise.resolve(third.catch((e) => e)).then((e) => e instanceof SignerError)).toBe(true);
    gate.resolve();
    await first;
    expect(await second).toBe("second");
    expect(await limiter.run(async () => "after")).toBe("after");
  });

  test("a failing job frees its slot", async () => {
    const limiter = new Limiter(1, 0);
    await expect(limiter.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await limiter.run(async () => "ok")).toBe("ok");
  });
});
