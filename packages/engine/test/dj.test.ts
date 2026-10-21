import { describe, expect, test } from "bun:test";
import type { DjStageTrack } from "@tik-live/shared";
import { DjDeck, type DjMedia } from "../src/audio/dj";
import { FakeAudioContext, FakeNode, ManualInterval } from "./music-fakes";

class FakeMedia implements DjMedia {
  src = "";
  preload = "none";
  currentTime = 0;
  paused = true;
  ended = false;
  plays = 0;
  /** Set to make play() fail like a blocked autoplay. */
  blocked = false;
  private metadata: Array<() => void> = [];
  play(): Promise<void> {
    this.plays += 1;
    if (this.blocked) return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  removeAttribute(): void {
    this.src = "";
  }
  load(): void {}
  addEventListener(_type: "loadedmetadata", listener: () => void): void {
    this.metadata.push(listener);
  }
  /** The file's header arrived. */
  loaded(): void {
    const listeners = this.metadata;
    this.metadata = [];
    for (const fn of listeners) fn();
  }
}

const track = (id: string, seconds = 200): DjStageTrack => ({ id, title: `Title ${id}`, artist: "Kevin MacLeod", credit: "Kevin MacLeod (incompetech.com) · CC BY 4.0", url: `/api/stage/k/dj/${id}`, seconds });

function setup() {
  const ctx = new FakeAudioContext();
  const mix = ctx.createGain();
  const interval = new ManualInterval();
  let ms = 0;
  const media: FakeMedia[] = [];
  const host = { speaking: false, isMuted: false, mixInput: () => ({ context: ctx as unknown as BaseAudioContext, node: mix as unknown as AudioNode }) };
  const state = { music: false };
  const deck = new DjDeck(host, {
    musicPlaying: () => state.music,
    createMedia: () => {
      const m = new FakeMedia();
      media.push(m);
      return m;
    },
    connectMedia: (c) => new FakeNode(c as unknown as FakeAudioContext, "media-source") as unknown as AudioNode,
    now: () => ms,
    every: interval.every,
  });
  const advance = (seconds: number) => {
    ms += seconds * 1000;
    ctx.advance(seconds);
    interval.tick();
  };
  /** The gain node right after a deck's media source. */
  const deckGain = (i: number) => {
    const sources = ctx.created.filter((n) => n.kind === "media-source");
    return [...sources[i]!.outputs][0] as unknown as { gain: { events: Array<[string, number, number]> } };
  };
  const gainNamed = (kind: string) => ctx.created.filter((n) => n.kind === kind);
  return { ctx, deck, media, host, state, advance, interval, deckGain, gainNamed };
}

describe("DjDeck", () => {
  test("streams the first track with a short fade-in and shows its credit", () => {
    const { deck, media, deckGain } = setup();
    expect(deck.nowPlaying()).toBeNull();
    expect(deck.handle({ t: "dj", track: track("a"), offsetMs: 0, next: "/api/stage/k/dj/b" })).toBe(true);
    expect(media).toHaveLength(2);
    expect(media[0]!.src).toBe("/api/stage/k/dj/a");
    expect(media[0]!.paused).toBe(false);
    expect(media[0]!.currentTime).toBe(0);
    expect(deckGain(0).gain.events.at(-1)).toEqual(["linear", 1, 0.8]);
    expect(deck.nowPlaying()).toMatchObject({ title: "Title a", credit: "Kevin MacLeod (incompetech.com) · CC BY 4.0", endsAt: 200_000 });
    expect(deck.handle({ t: "sfx", sound: "pop" })).toBe(false);
  });

  test("a stage that joins mid-track seeks to where the track is once the file's header is in", () => {
    const { deck, media, advance } = setup();
    deck.handle({ t: "dj", track: track("a"), offsetMs: 42_000 });
    expect(media[0]!.currentTime).toBe(42);
    // Loading took two seconds: still in step with everyone else.
    advance(2);
    media[0]!.loaded();
    expect(media[0]!.currentTime).toBe(44);
  });

  test("crossfades into the next track on the other deck, then preloads the one after", () => {
    const { deck, media, advance, deckGain } = setup();
    deck.handle({ t: "dj", track: track("a"), offsetMs: 0, next: "/api/stage/k/dj/b" });
    advance(100);
    deck.handle({ t: "dj", track: track("b"), offsetMs: 0, next: "/api/stage/k/dj/c" });
    expect(media[1]!.src).toBe("/api/stage/k/dj/b");
    expect(media[1]!.paused).toBe(false);
    expect(deckGain(1).gain.events.at(-1)).toEqual(["linear", 1, 103]);
    expect(deckGain(0).gain.events.at(-1)).toEqual(["linear", 0, 103]);
    // Mid-fade both decks sound.
    advance(1);
    expect(media[0]!.paused).toBe(false);
    advance(3);
    expect(media[0]!.paused).toBe(true);
    expect(media[0]!.src).toBe("/api/stage/k/dj/c");
    expect(media[0]!.preload).toBe("auto");
    // The preloaded deck takes the next track without loading it again.
    const plays = media[0]!.plays;
    deck.handle({ t: "dj", track: track("c"), offsetMs: 0 });
    expect(media[0]!.src).toBe("/api/stage/k/dj/c");
    expect(media[0]!.plays).toBe(plays + 1);
  });

  test("the same track again (a reconnect) doesn't restart it, unless the stage drifted", () => {
    const { deck, media, advance } = setup();
    deck.handle({ t: "dj", track: track("a"), offsetMs: 0 });
    advance(10);
    media[0]!.currentTime = 10;
    const plays = media[0]!.plays;
    deck.handle({ t: "dj", track: track("a"), offsetMs: 11_000 });
    expect(media[0]!.currentTime).toBe(10);
    expect(media[0]!.plays).toBe(plays);
    deck.handle({ t: "dj", track: track("a"), offsetMs: 60_000 });
    expect(media[0]!.currentTime).toBe(60);
  });

  test("ducks under speech and steps aside while the host's own piece plays", () => {
    const { deck, host, state, advance, gainNamed } = setup();
    deck.handle({ t: "dj", track: track("a") });
    // After the test's mix: the bus's level, duck and yield gains, then the two decks'.
    const [, duck, yieldGain] = gainNamed("gain").slice(1) as unknown as Array<{ gain: { events: Array<[string, number, number]> } }>;
    host.speaking = true;
    advance(0.25);
    expect(duck!.gain.events.at(-1)?.[1]).toBe(0.3);
    host.speaking = false;
    advance(0.25);
    expect(duck!.gain.events.at(-1)?.[1]).toBe(1);
    state.music = true;
    advance(0.25);
    expect(yieldGain!.gain.events.at(-1)?.[1]).toBe(0);
    state.music = false;
    advance(0.25);
    expect(yieldGain!.gain.events.at(-1)?.[1]).toBe(1);
  });

  test("retries a blocked start, and doesn't replay a track that already ended", () => {
    const { deck, media, advance } = setup();
    media.length = 0;
    deck.handle({ t: "dj", track: track("a") });
    const m = media[0]!;
    m.blocked = true;
    m.paused = true;
    advance(2.25);
    expect(m.plays).toBe(2);
    m.blocked = false;
    advance(2.25);
    expect(m.paused).toBe(false);
    m.paused = true;
    m.ended = true;
    const plays = m.plays;
    advance(4);
    expect(m.plays).toBe(plays);
  });

  test("a muted stage doesn't stream, and picks the track up where it is when unmuted", () => {
    const { deck, media, host, advance } = setup();
    host.isMuted = true;
    deck.handle({ t: "dj", track: track("a"), offsetMs: 0 });
    advance(0.25);
    expect(media[0]!.paused).toBe(true);
    const plays = media[0]!.plays;
    advance(30);
    expect(media[0]!.plays).toBe(plays);
    host.isMuted = false;
    advance(0.25);
    expect(media[0]!.paused).toBe(false);
    expect(media[0]!.currentTime).toBeCloseTo(30.5, 5);
  });

  test("fades out and stops on null, then lets the scheduler rest", () => {
    const { deck, media, advance, interval, deckGain } = setup();
    deck.handle({ t: "dj", track: track("a") });
    advance(5);
    deck.handle({ t: "dj", track: null });
    expect(deck.nowPlaying()).toBeNull();
    expect(deckGain(0).gain.events.at(-1)).toEqual(["linear", 0, 6.5]);
    advance(2);
    expect(media[0]!.paused).toBe(true);
    expect(interval.running).toBe(false);
    deck.destroy();
    expect(media.every((m) => m.src === "")).toBe(true);
  });
});
