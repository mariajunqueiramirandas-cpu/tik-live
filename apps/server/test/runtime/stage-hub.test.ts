import { describe, expect, it } from "bun:test";
import { AudioStore } from "../../src/runtime/audio-store";
import type { Peer } from "../../src/runtime/peer";
import { StageHub } from "../../src/runtime/stage-hub";
import type { SpeechCue } from "../../src/runtime/voice/pipeline";

class FakePeer implements Peer {
  readonly messages: Array<Record<string, unknown>> = [];
  constructor(readonly id: string) {}
  send(data: string): void {
    this.messages.push(JSON.parse(data) as Record<string, unknown>);
  }
  bufferedAmount(): number {
    return 0;
  }
  close(): void {}
  of(t: string) {
    return this.messages.filter((m) => m.t === t);
  }
}

const look = { character: "orb", primary: "#7CF5FF", secondary: "#FF5FD2", background: "#0B0420" } as const;
const cue = (id: string, durationMs = 60_000, words?: number[]): SpeechCue => ({
  id,
  text: `line ${id}`,
  emotion: "neutral",
  audio: words ? { mime: "audio/mpeg", data: Buffer.from([1]), durationMs, words } : null,
  durationMs,
});

function setup() {
  const audio = new AudioStore();
  const hub = new StageHub({ channelId: "ch", stageKey: "key", name: "Blip", look, audio });
  const obs = new FakePeer("obs");
  const cloud = new FakePeer("cloud");
  hub.attach(obs, "program");
  hub.attach(cloud, "broadcast");
  const done: string[] = [];
  const play = (c: SpeechCue) => void hub.play(c).then(() => done.push(c.id));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { hub, obs, cloud, done, play, tick, close: () => audio.close() };
}

describe("StageHub (ADR-0022)", () => {
  it("queues cues on every stage instead of replacing the one playing", async () => {
    const { hub, obs, cloud, done, play, tick, close } = setup();
    play(cue("a"));
    play(cue("b", 2_000, [0, 400]));
    expect(obs.of("cue").map((m) => m.id)).toEqual(["a", "b"]);
    expect(cloud.of("cue")[1]).toMatchObject({ id: "b", words: [0, 400], audioUrl: "/api/stage/key/audio/b" });
    expect(obs.of("stop")).toEqual([]);

    // The faster stage finishing "a" doesn't touch the slower one: it just plays "b" next.
    hub.handleMessage("obs", { v: 2, t: "spoken", id: "a" });
    await tick();
    expect(done).toEqual(["a"]);
    expect(cloud.of("stop")).toEqual([]);
    close();
  });

  it("treats a later line's spoken report as the end of everything before it", async () => {
    const { hub, done, play, tick, close } = setup();
    play(cue("a"));
    play(cue("b"));
    hub.handleMessage("cloud", { v: 2, t: "spoken", id: "b" });
    await tick();
    expect(done).toEqual(["a", "b"]);
    close();
  });

  it("takes back queued lines, but never the one playing", async () => {
    const { hub, obs, done, play, tick, close } = setup();
    play(cue("a"));
    play(cue("b"));
    hub.drop(["a", "b"]);
    await tick();
    expect(obs.of("drop")).toEqual([{ v: 2, t: "drop", ids: ["b"] }]);
    expect(done).toEqual(["b"]);
    hub.interrupt();
    await tick();
    expect(done).toEqual(["b", "a"]);
    expect(obs.of("stop")).toHaveLength(1);
    close();
  });

  it("paces by duration when no on-air stage is connected", async () => {
    const audio = new AudioStore();
    const hub = new StageHub({ channelId: "ch", stageKey: "key", name: "Blip", look, audio });
    const preview = new FakePeer("preview");
    hub.attach(preview, "preview");
    const done: string[] = [];
    void hub.play(cue("a", 20)).then(() => done.push("a"));
    void hub.play(cue("b", 20)).then(() => done.push("b"));
    hub.handleMessage("preview", { v: 2, t: "spoken", id: "b" }); // previews never pace the show
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toEqual(["a"]);
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toEqual(["a", "b"]);
    audio.close();
  });
});
