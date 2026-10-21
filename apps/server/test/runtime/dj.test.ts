import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DJ_CATALOG, djCredit, djTrack, type DjTrack } from "@tik-live/shared";
import { AudioStore } from "../../src/runtime/audio-store";
import { Dj, DJ_CROSSFADE_MS } from "../../src/runtime/dj";
import { DjCache, looksLikeMp3, parseRange } from "../../src/runtime/dj-cache";
import type { Peer } from "../../src/runtime/peer";
import { StageHub } from "../../src/runtime/stage-hub";
import { fakeClock, persona } from "./helpers";

const tracks = (n: number): DjTrack[] =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Track ${i}`, artist: "A", seconds: 60 + i, bpm: 120, upstream: `https://example.test/t${i}.mp3` }));

/** A manual `after`: `fire()` runs the pending timer. */
function manualTimer() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    after: (fn: () => void, ms: number) => {
      const entry = { fn, ms, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** The one live timer's delay. */
    get ms() {
      return pending.filter((p) => !p.cancelled).at(-1)?.ms;
    },
    fire() {
      const live = pending.filter((p) => !p.cancelled);
      pending.length = 0;
      for (const p of live) p.fn();
    },
  };
}

function setup(list = tracks(5), random: () => number = Math.random) {
  const clock = fakeClock();
  const timer = manualTimer();
  const sent: Array<{ track: DjTrack | null; startedAt?: number; next?: DjTrack }> = [];
  const warmed: string[] = [];
  const dj = new Dj({
    stage: { dj: (track, startedAt, next) => void sent.push({ track, ...(startedAt !== undefined ? { startedAt } : {}), ...(next ? { next } : {}) }) },
    warm: (track) => void warmed.push(track.id),
    tracks: list,
    random,
    now: clock.now,
    after: timer.after,
  });
  return { dj, clock, timer, sent, warmed };
}

describe("the catalog", () => {
  it("is credited Creative Commons music with unique ids and incompetech files", () => {
    expect(DJ_CATALOG.length).toBeGreaterThanOrEqual(30);
    expect(new Set(DJ_CATALOG.map((t) => t.id)).size).toBe(DJ_CATALOG.length);
    for (const track of DJ_CATALOG) {
      expect(track.id).toMatch(/^[a-z0-9-]+$/);
      expect(track.upstream.startsWith("https://incompetech.com/music/royalty-free/mp3-royaltyfree/")).toBe(true);
      expect(track.upstream.endsWith(".mp3")).toBe(true);
      expect(track.seconds).toBeGreaterThan(60);
      expect(djTrack(track.id)).toBe(track);
    }
    expect(djTrack("cipher")?.upstream).toEndWith("/Cipher2.mp3");
    expect(djTrack("rising-tide-faster")?.upstream).toEndWith("/Rising%20Tide%20(faster).mp3");
    expect(djCredit(DJ_CATALOG[0]!)).toBe("Kevin MacLeod (incompetech.com) · CC BY 4.0");
  });
});

describe("Dj", () => {
  it("plays every track once before any repeats, and never the same one twice in a row", () => {
    // A random source that keeps the order: the reshuffle has to swap the repeat away.
    const { dj, timer, sent } = setup(tracks(4), () => 0.999);
    dj.start();
    for (let i = 0; i < 11; i++) timer.fire();
    const ids = sent.map((s) => s.track!.id);
    expect(ids).toHaveLength(12);
    for (let cycle = 0; cycle < 3; cycle++) expect(new Set(ids.slice(cycle * 4, cycle * 4 + 4)).size).toBe(4);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]);
  });

  it("starts the next track a crossfade before this one ends, and says which comes after", () => {
    const { dj, clock, timer, sent, warmed } = setup();
    dj.start();
    const first = sent[0]!;
    expect(first.startedAt).toBe(clock.now());
    expect(timer.ms).toBe(first.track!.seconds * 1000 - DJ_CROSSFADE_MS);
    expect(warmed).toEqual([first.next!.id]);
    clock.advance(timer.ms!);
    timer.fire();
    // What was announced as next is what plays.
    expect(sent[1]!.track).toBe(first.next!);
    expect(dj.nowPlaying()).toMatchObject({ track: first.next, startedAt: clock.now(), endsAt: clock.now() + first.next!.seconds * 1000 });
  });

  it("skips to the next track and fades out on stop", () => {
    const { dj, sent } = setup();
    expect(dj.skip()).toBe(false);
    dj.start();
    dj.start(); // already running: nothing new
    expect(sent).toHaveLength(1);
    expect(dj.skip()).toBe(true);
    expect(sent[1]!.track).toBe(sent[0]!.next!);
    dj.stop();
    expect(sent.at(-1)).toEqual({ track: null });
    expect(dj.running).toBe(false);
    expect(dj.nowPlaying()).toBeNull();
  });
});

describe("DjCache", () => {
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]);

  async function withDir(run: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(tmpdir(), "dj-test-"));
    try {
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("fetches a track once, even when asked twice at the same time, and serves it from disk after", () =>
    withDir(async (dir) => {
      const calls: string[] = [];
      const fetcher = (async (url: string) => {
        calls.push(url);
        return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
      }) as unknown as typeof fetch;
      const cache = new DjCache({ dir, fetch: fetcher });
      const track = tracks(1)[0]!;
      const [a, b] = await Promise.all([cache.file(track), cache.file(track)]);
      expect(a).toBe(path.join(dir, "t0.mp3"));
      expect(b).toBe(a);
      expect(await cache.file(track)).toBe(a);
      expect(calls).toEqual([track.upstream]);
      expect(new Uint8Array(await Bun.file(a!).arrayBuffer())).toEqual(mp3);
      // Nothing half-written is left behind.
      expect(await readdir(dir)).toEqual(["t0.mp3"]);
    }));

  it("refuses what isn't an MP3, and waits before trying a failed track again", () =>
    withDir(async (dir) => {
      const clock = fakeClock();
      let body: Uint8Array = new TextEncoder().encode("<html>not found</html>");
      let calls = 0;
      const fetcher = (async () => {
        calls += 1;
        return new Response(body);
      }) as unknown as typeof fetch;
      const cache = new DjCache({ dir, fetch: fetcher, now: clock.now });
      const track = tracks(1)[0]!;
      expect(await cache.file(track)).toBeNull();
      body = mp3;
      expect(await cache.file(track)).toBeNull(); // still in the back-off window
      expect(calls).toBe(1);
      clock.advance(5 * 60_000);
      expect(await cache.file(track)).toBe(path.join(dir, "t0.mp3"));
      expect(calls).toBe(2);
      expect(await readdir(dir)).toEqual(["t0.mp3"]);
    }));

  it("recognizes MP3s by their ID3 tag or frame sync", () => {
    expect(looksLikeMp3(mp3)).toBe(true);
    expect(looksLikeMp3(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe(true);
    expect(looksLikeMp3(new TextEncoder().encode("<!doctype html>"))).toBe(false);
    expect(looksLikeMp3(new Uint8Array([0xff]))).toBe(false);
  });

  it("parses single byte ranges", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=20-10", 100)).toBe("invalid");
    expect(parseRange("bytes=-", 100)).toBe("invalid");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });
});

class FakePeer implements Peer {
  readonly sent: Array<{ t: string } & Record<string, unknown>> = [];
  constructor(readonly id: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as { t: string });
  }
  bufferedAmount(): number {
    return 0;
  }
  close(): void {}
}

describe("StageHub and the DJ", () => {
  it("sends stages the track's credit and a same-origin URL, and joins late stages mid-track", () => {
    const clock = fakeClock();
    const audio = new AudioStore();
    const hub = new StageHub({ channelId: "c1", stageKey: "key123", name: persona.name, look: persona.look, audio, now: clock.now });
    const obs = new FakePeer("obs");
    hub.attach(obs, "program");
    const [werq, realizer] = [djTrack("werq")!, djTrack("realizer")!];
    hub.dj(werq, clock.now(), realizer);
    expect(obs.sent.at(-1)).toEqual({
      v: 1,
      t: "dj",
      track: { id: "werq", title: "Werq", artist: "Kevin MacLeod", credit: "Kevin MacLeod (incompetech.com) · CC BY 4.0", url: "/api/stage/key123/dj/werq", seconds: werq.seconds },
      offsetMs: 0,
      next: "/api/stage/key123/dj/realizer",
    });

    clock.advance(30_000);
    const late = new FakePeer("late");
    hub.attach(late, "broadcast");
    expect(late.sent.find((m) => m.t === "dj")).toMatchObject({ track: { id: "werq" }, offsetMs: 30_000 });

    // Past the track's end there's nothing to join.
    clock.advance(werq.seconds * 1000);
    const later = new FakePeer("later");
    hub.attach(later, "program");
    expect(later.sent.some((m) => m.t === "dj")).toBe(false);

    hub.dj(null);
    expect(obs.sent.at(-1)).toEqual({ v: 1, t: "dj", track: null });
    const fresh = new FakePeer("fresh");
    hub.attach(fresh, "program");
    expect(fresh.sent.some((m) => m.t === "dj")).toBe(false);
    audio.close();
  });
});
