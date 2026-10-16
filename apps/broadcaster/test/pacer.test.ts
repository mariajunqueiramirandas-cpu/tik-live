import { describe, expect, it } from "bun:test";
import { AvPacer } from "../src/pacer";
import { SocketWriter } from "../src/socket-writer";

/** A clock and timers the test advances by hand. */
function manualClock() {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let ids = 0;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++ids;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers = timers.filter((t) => t.id !== id);
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) break;
        timers.shift();
        now = next.at;
        next.fn();
      }
      now = until;
    },
  };
}

const FRAME = 16;
const frame = (fill: number) => new Uint8Array(FRAME).fill(fill);
/** 20 ms of 48 kHz stereo 16-bit PCM. */
const packet = () => new Uint8Array(960 * 4).fill(7);

function setup(audioDelayMs = 0, fps = 30) {
  const clock = manualClock();
  const written = { frames: [] as number[], audioBytes: 0, silentBytes: 0 };
  const pacer = new AvPacer({ fps, frameBytes: FRAME, sampleRate: 48_000, channels: 2, audioDelayMs, ...clock });
  pacer.attach({
    writeVideo: (f) => written.frames.push(f[0] as number),
    writeAudio: (pcm) => {
      written.audioBytes += pcm.byteLength;
      if (pcm[0] === 0) written.silentBytes += pcm.byteLength;
    },
  });
  return { clock, pacer, written };
}

describe("AvPacer", () => {
  it("starts once two frames are queued, then writes exactly fps frames per second of clock time", () => {
    const { clock, pacer, written } = setup(0, 25);
    pacer.audio(packet()); // before the clock starts: dropped
    pacer.video(frame(1));
    expect(written.frames).toEqual([]);
    expect(written.audioBytes).toBe(0);
    pacer.video(frame(2));
    expect(written.frames).toEqual([1]);
    for (let i = 0; i < 25; i++) {
      pacer.video(frame(3 + i));
      clock.advance(40);
    }
    // 1 s later: one frame per 40 ms tick, every one of them new, in order.
    expect(written.frames).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
    expect(pacer.counters).toMatchObject({ frames: 26, repeated: 0, skipped: 0 });
  });

  it("absorbs frames that arrive in uneven bursts", () => {
    const { clock, pacer, written } = setup(0, 25);
    pacer.video(frame(1));
    pacer.video(frame(2));
    // Two frames every other tick: same average rate, uneven arrival.
    let n = 3;
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        pacer.video(frame(n++));
        pacer.video(frame(n++));
      }
      clock.advance(40);
    }
    expect(pacer.counters).toMatchObject({ repeated: 0, skipped: 0 });
    expect(written.frames).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
  });

  it("repeats the last frame when the queue runs dry", () => {
    const { clock, pacer, written } = setup(0, 25);
    pacer.video(frame(1));
    pacer.video(frame(2));
    clock.advance(120); // three ticks, no new frames: 2, then 2 again twice
    expect(written.frames).toEqual([1, 2, 2, 2]);
    expect(pacer.counters.repeated).toBe(2);
  });

  it("drops frames to keep the delay bounded when the stage runs ahead", () => {
    const { clock, pacer } = setup(0, 25);
    for (let i = 0; i < 2; i++) pacer.video(frame(i));
    for (let i = 0; i < 25; i++) {
      // Two frames per tick: twice the clock's rate.
      pacer.video(frame(i));
      pacer.video(frame(i));
      clock.advance(40);
    }
    expect(pacer.counters.skipped).toBeGreaterThan(20);
    expect(pacer.counters.queueMs).toBeLessThanOrEqual(80);
  });

  it("doesn't drift when the timer fires late", () => {
    const clock = manualClock();
    let frames = 0;
    // Every timer fires 10 ms late: deadlines still come from the start time.
    const pacer = new AvPacer({
      fps: 25, frameBytes: FRAME, sampleRate: 48_000, channels: 2,
      now: clock.now,
      setTimer: (fn, ms) => clock.setTimer(fn, ms + 10),
      clearTimer: clock.clearTimer,
    });
    pacer.attach({ writeVideo: () => frames++, writeAudio: () => undefined });
    pacer.video(frame(1));
    pacer.video(frame(2));
    clock.advance(10_000);
    expect(frames).toBeGreaterThanOrEqual(250);
    expect(frames).toBeLessThanOrEqual(251);
  });

  it("ignores frames of the wrong size", () => {
    const { pacer, written } = setup();
    pacer.video(new Uint8Array(FRAME + 1));
    pacer.video(new Uint8Array(FRAME + 1));
    expect(written.frames).toEqual([]);
  });

  it("delays audio behind video, and fills gaps in the voice with silence", () => {
    const { clock, pacer, written } = setup(50);
    pacer.video(frame(1));
    pacer.video(frame(2));
    // 50 ms of 48 kHz stereo 16-bit silence goes first.
    expect(written.silentBytes).toBe(2400 * 4);
    // The voice stops for half a second: silence keeps the audio on the clock.
    clock.advance(500);
    const expectedBytes = ((500 + 50) / 1000) * 48_000 * 4;
    expect(written.audioBytes).toBeGreaterThan(expectedBytes - 0.13 * 48_000 * 4);
    expect(written.audioBytes).toBeLessThanOrEqual(expectedBytes + 4);
  });

  it("drops voice that runs far ahead of the clock", () => {
    const { pacer, written } = setup();
    pacer.video(frame(1));
    pacer.video(frame(2));
    for (let i = 0; i < 100; i++) pacer.audio(packet()); // 2 s of voice at once
    expect(written.audioBytes).toBeLessThan(0.6 * 48_000 * 4);
  });

  it("stops writing when stopped", () => {
    const { clock, pacer, written } = setup();
    pacer.video(frame(1));
    pacer.video(frame(2));
    pacer.stop();
    clock.advance(1000);
    expect(written.frames).toEqual([1]);
  });
});

describe("AvPacer in stream mode (H.264 from the stage)", () => {
  function streamSetup() {
    const clock = manualClock();
    const written = { chunks: [] as number[], audioBytes: 0 };
    const pacer = new AvPacer({ video: "stream", fps: 30, frameBytes: 0, sampleRate: 48_000, channels: 2, audioDelayMs: 0, ...clock });
    const attach = () =>
      pacer.attach({
        writeVideo: (chunk) => written.chunks.push(chunk[0] as number),
        writeAudio: (pcm) => {
          written.audioBytes += pcm.byteLength;
        },
      });
    return { clock, pacer, written, attach };
  }

  it("holds chunks until attached, then passes every chunk through in order", () => {
    const { pacer, written, attach } = streamSetup();
    pacer.video(new Uint8Array([1]));
    pacer.video(new Uint8Array([2, 9, 9]));
    expect(written.chunks).toEqual([]);
    attach();
    pacer.video(new Uint8Array([3]));
    expect(written.chunks).toEqual([1, 2, 3]);
    expect(pacer.counters).toMatchObject({ frames: 3, repeated: 0, skipped: 0 });
  });

  it("keeps the voice on the clock with silence, without video ticks", () => {
    const { clock, pacer, written, attach } = streamSetup();
    attach();
    pacer.video(new Uint8Array([1]));
    clock.advance(1000);
    expect(written.audioBytes).toBeGreaterThan(0.85 * 48_000 * 4);
    expect(written.chunks).toEqual([1]);
    pacer.stop();
  });
});

describe("SocketWriter", () => {
  function fakeSocket(capacity: number) {
    const received: number[] = [];
    let room = capacity;
    let handlers: { drain(): void; close(): void } | null = null;
    let connectNow: (() => void) | null = null;
    const socket = {
      write(chunk: Uint8Array) {
        const n = Math.min(room, chunk.byteLength);
        for (let i = 0; i < n; i++) received.push(chunk[i] as number);
        room -= n;
        return n;
      },
      end() {
        return 0;
      },
    };
    return {
      received,
      connect: (_path: string, h: { drain(): void; close(): void }) =>
        new Promise<typeof socket>((resolve) => {
          handlers = h;
          connectNow = () => resolve(socket);
        }),
      open: () => connectNow?.(),
      drain(more: number) {
        room += more;
        handlers?.drain();
      },
    };
  }

  it("queues until connected, then writes everything in order", async () => {
    const fake = fakeSocket(1000);
    const writer = new SocketWriter("/x.sock", { maxQueuedBytes: 1000, connect: fake.connect });
    writer.write(new Uint8Array([1, 2]));
    writer.write(new Uint8Array([3]));
    fake.open();
    await Bun.sleep(0);
    writer.write(new Uint8Array([4]));
    expect(fake.received).toEqual([1, 2, 3, 4]);
    writer.close();
  });

  it("resumes partial writes when the socket drains", async () => {
    const fake = fakeSocket(2);
    const writer = new SocketWriter("/x.sock", { maxQueuedBytes: 1000, connect: fake.connect });
    fake.open();
    await Bun.sleep(0);
    writer.write(new Uint8Array([1, 2, 3, 4, 5]));
    expect(fake.received).toEqual([1, 2]);
    fake.drain(10);
    expect(fake.received).toEqual([1, 2, 3, 4, 5]);
    writer.close();
  });

  it("drops the oldest data past its limit, and copies what it queues", async () => {
    const fake = fakeSocket(1000);
    const writer = new SocketWriter("/x.sock", { maxQueuedBytes: 4, connect: fake.connect });
    const reused = new Uint8Array([1, 1]);
    writer.write(reused);
    reused.fill(9);
    writer.write(new Uint8Array([2, 2]));
    writer.write(new Uint8Array([3, 3]));
    fake.open();
    await Bun.sleep(0);
    expect(fake.received).toEqual([2, 2, 3, 3]);
    expect(writer.dropped).toBe(2);
    writer.close();
  });
});
