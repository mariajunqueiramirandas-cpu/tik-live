import { describe, expect, it } from "bun:test";
import { AudioStore } from "../../src/runtime/audio-store";
import type { Peer } from "../../src/runtime/peer";
import { StageHub } from "../../src/runtime/stage-hub";
import type { SpeechCue } from "../../src/runtime/voice/pipeline";
import { fakeClock, persona } from "./helpers";

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

const cue = (id: string, durationMs = 2_000): SpeechCue => ({ id, text: `line ${id}`, emotion: "neutral", audio: null, durationMs });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup() {
  const clock = fakeClock();
  const audio = new AudioStore();
  const hub = new StageHub({ channelId: "c1", stageKey: "k", name: persona.name, look: persona.look, audio, now: clock.now });
  const attach = (id: string, role: "program" | "preview" | "broadcast") => {
    const peer = new FakePeer(id);
    hub.attach(peer, role);
    return peer;
  };
  const tracked = (promise: Promise<void>) => {
    const state = { done: false };
    void promise.then(() => (state.done = true));
    return state;
  };
  const after = () => audio.close();
  return { hub, clock, attach, tracked, after };
}

describe("StageHub pacing", () => {
  it("waits for every on-air stage to finish a line, ignoring previews", async () => {
    const { hub, attach, tracked, after } = setup();
    attach("obs", "program");
    attach("cloud", "broadcast");
    attach("studio", "preview");
    const line = tracked(hub.play(cue("a"), new AbortController().signal));
    hub.handleMessage("studio", { v: 1, t: "spoken", id: "a" });
    hub.handleMessage("obs", { v: 1, t: "spoken", id: "a" });
    await wait(0);
    expect(line.done).toBe(false); // the cloud broadcast is still saying it
    hub.handleMessage("cloud", { v: 1, t: "spoken", id: "a" });
    await wait(0);
    expect(line.done).toBe(true);
    after();
  });

  it("stops waiting for a stage that disconnects", async () => {
    const { hub, attach, tracked, after } = setup();
    attach("obs", "program");
    attach("cloud", "broadcast");
    const line = tracked(hub.play(cue("a"), new AbortController().signal));
    hub.handleMessage("obs", { v: 1, t: "spoken", id: "a" });
    hub.detach("cloud");
    await wait(0);
    expect(line.done).toBe(true);
    after();
  });

  it("moves the deadline to the real duration once a stage starts the line", async () => {
    const { hub, attach, tracked, after } = setup();
    attach("obs", "program");
    // Estimated 10 ms, so 4 s to start; the stage says the audio really lasts 20 ms.
    const line = tracked(hub.play(cue("a", 10), new AbortController().signal));
    hub.handleMessage("obs", { v: 1, t: "started", id: "a", durationMs: 20 });
    await wait(200);
    expect(line.done).toBe(false); // still inside 20 ms + 1.5 s grace
    await wait(1_500);
    expect(line.done).toBe(true); // well before the 4 s start deadline
    after();
  });

  it("interrupt() releases every line in progress", async () => {
    const { hub, attach, tracked, after } = setup();
    const obs = attach("obs", "program");
    const line = tracked(hub.play(cue("a"), new AbortController().signal));
    hub.interrupt();
    await wait(0);
    expect(line.done).toBe(true);
    expect(obs.sent.at(-1)).toMatchObject({ t: "stop" });
    after();
  });

  it("coalesces a burst of stats into a few messages", async () => {
    const { hub, attach, clock, after } = setup();
    const obs = attach("obs", "program");
    for (let likes = 1; likes <= 50; likes++) hub.stats({ viewers: 3, likes });
    clock.advance(300);
    await wait(300);
    const stats = obs.sent.filter((m) => m.t === "stats");
    expect(stats.length).toBe(2);
    expect(stats.at(-1)).toMatchObject({ viewers: 3, likes: 50 });
    after();
  });
});
