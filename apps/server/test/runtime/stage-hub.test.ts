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
  closedWith: number | undefined;
  bufferedAmount(): number {
    return 0;
  }
  close(code?: number): void {
    this.closedWith = code;
  }
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

  it("doesn't wait for an on-air stage that has gone quiet (a frozen page still answering pings)", async () => {
    const { hub, clock, attach, tracked, after } = setup();
    attach("obs", "program");
    attach("frozen", "program");
    clock.advance(31_000);
    hub.handleMessage("obs", { v: 1, t: "telemetry", fps: 60, frameP95: 4, quality: 0 });
    const line = tracked(hub.play(cue("a"), new AbortController().signal));
    hub.handleMessage("obs", { v: 1, t: "spoken", id: "a" });
    await wait(0);
    expect(line.done).toBe(true);
    after();
  });

  it("stops pacing by a stage that let a line run out, until it reports a line again", async () => {
    const { hub, attach, tracked, after } = setup();
    attach("obs", "program");
    attach("stuck", "program");
    const first = tracked(hub.play(cue("a", 10), new AbortController().signal));
    hub.handleMessage("obs", { v: 1, t: "started", id: "a", durationMs: 10 });
    hub.handleMessage("obs", { v: 1, t: "spoken", id: "a" });
    hub.handleMessage("stuck", { v: 1, t: "started", id: "a", durationMs: 10 });
    await wait(0);
    expect(first.done).toBe(false); // the stuck stage still has 10 ms + 1.5 s
    await wait(2_000);
    expect(first.done).toBe(true);

    // The next line only waits for the stage that keeps up.
    const second = tracked(hub.play(cue("b"), new AbortController().signal));
    hub.handleMessage("obs", { v: 1, t: "spoken", id: "b" });
    await wait(0);
    expect(second.done).toBe(true);

    // Once it reports again, it paces the show again.
    hub.handleMessage("stuck", { v: 1, t: "spoken", id: "b" });
    const third = tracked(hub.play(cue("c"), new AbortController().signal));
    hub.handleMessage("obs", { v: 1, t: "spoken", id: "c" });
    await wait(0);
    expect(third.done).toBe(false);
    hub.handleMessage("stuck", { v: 1, t: "spoken", id: "c" });
    await wait(0);
    expect(third.done).toBe(true);
    after();
  });

  it("disconnects on-air stages silent for a minute, never previews", () => {
    const { hub, clock, attach, after } = setup();
    const obs = attach("obs", "program");
    const frozen = attach("frozen", "program");
    const studio = attach("studio", "preview");
    clock.advance(59_000);
    hub.handleMessage("obs", { v: 1, t: "telemetry", fps: 60, frameP95: 4, quality: 0 });
    expect(hub.sweep()).toBe(0);
    clock.advance(2_000);
    expect(hub.sweep()).toBe(1);
    expect(frozen.closedWith).toBe(4000);
    expect(obs.closedWith).toBeUndefined();
    expect(studio.closedWith).toBeUndefined();
    expect(hub.counts()).toEqual({ program: 1, preview: 1, broadcast: 0 });
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

  it("sends fan level-ups as alerts, and replays a call to passers-by that's still up", () => {
    const { hub, attach, after } = setup();
    const obs = attach("obs", "program");
    hub.fanLevel("duda", 7);
    hub.hook("COMENTA SEU NOME E GANHA UM APELIDO");
    expect(obs.sent.find((m) => m.t === "alert")).toMatchObject({ kind: "level", name: "duda", level: 7 });
    expect(attach("late", "program").sent.find((m) => m.t === "hook")).toMatchObject({ text: "COMENTA SEU NOME E GANHA UM APELIDO" });
    hub.hook(null);
    expect(attach("later", "program").sent.some((m) => m.t === "hook")).toBe(false);
    after();
  });

  it("coalesces goal progress, sends a goal reached at once, and replays the goals to a stage that connects", async () => {
    const { hub, attach, clock, after } = setup();
    const obs = attach("obs", "program");
    const goals = (likes: number, target = 500, level = 1) => [
      { kind: "likes" as const, value: likes, target, level },
      { kind: "gifts" as const, value: 0, target: 100, level: 1 },
    ];
    hub.goals(goals(0));
    for (let likes = 1; likes <= 40; likes++) hub.goals(goals(likes));
    hub.goals(goals(520, 1_000, 2)); // reached: no waiting
    expect(obs.sent.filter((m) => m.t === "goals").map((m) => (m.goals as Array<{ value: number }>)[0]?.value)).toEqual([0, 520]);
    clock.advance(300);
    await wait(300);
    expect(obs.sent.filter((m) => m.t === "goals")).toHaveLength(2); // nothing new to send
    const late = attach("late", "program");
    expect(late.sent.find((m) => m.t === "goals")).toMatchObject({ goals: goals(520, 1_000, 2) });
    after();
  });
  it("sends gift powers, the dono da live and challenges, and replays what's still up with its clock moved on", () => {
    const { hub, attach, clock, after } = setup();
    const obs = attach("obs", "program");
    const card = { title: "Poderes do presente", rows: [{ diamonds: 5, text: "Fura-fila" }, { diamonds: 199, text: "Dono da live" }] };
    hub.perks(card);
    hub.boss({ name: "mari", leftMs: 300_000 });
    hub.crown("caio");
    hub.perk("duda", "Fura-fila");
    hub.raffleWinner("lu");
    hub.vote({ title: "Próximo jogo", options: ["Cabo de guerra", "Batata quente"], tally: [0, 0], by: "mari" });
    const challenge = { kind: "likes" as const, title: "DESAFIO DAS CURTIDAS", detail: "toque na tela", value: 10, target: 500, remainingMs: 45_000, durationMs: 45_000, result: null, winner: null };
    hub.challenge(challenge);
    expect(obs.sent.filter((m) => m.t === "alert")).toEqual([
      { v: 1, t: "alert", kind: "crown", name: "caio" },
      { v: 1, t: "alert", kind: "perk", name: "duda", perk: "Fura-fila" },
      { v: 1, t: "alert", kind: "raffle", name: "lu" },
    ]);
    clock.advance(20_000);
    const late = attach("late", "program");
    expect(late.sent.find((m) => m.t === "perks")).toMatchObject({ card });
    expect(late.sent.find((m) => m.t === "boss")).toMatchObject({ boss: { name: "mari", leftMs: 280_000 } });
    expect(late.sent.find((m) => m.t === "challenge")).toMatchObject({ challenge: { value: 10, remainingMs: 25_000 } });
    expect(late.sent.find((m) => m.t === "vote")).toMatchObject({ vote: { by: "mari" } });
    expect(late.sent.some((m) => m.t === "alert")).toBe(false);

    // A result is replayed for a moment, then it's old news; a reign that ran out isn't replayed.
    hub.challenge({ ...challenge, value: 520, remainingMs: 0, result: "won" });
    clock.advance(2_000);
    expect(attach("soon", "program").sent.find((m) => m.t === "challenge")).toMatchObject({ challenge: { result: "won" } });
    clock.advance(10_000);
    expect(attach("later", "program").sent.some((m) => m.t === "challenge")).toBe(false);
    clock.advance(300_000);
    const gone = attach("gone", "program");
    expect(gone.sent.some((m) => m.t === "boss")).toBe(false);
    hub.perks(null);
    hub.boss(null);
    hub.challenge(null);
    const cleared = attach("cleared", "program");
    expect(cleared.sent.some((m) => m.t === "perks" || m.t === "boss" || m.t === "challenge")).toBe(false);
    after();
  });

  it("replays the support ticker to a stage that connects, until it's taken down", () => {
    const { hub, attach, after } = setup();
    const ticker = { title: "APOIE A LIVE", lines: [{ way: "gift" as const, text: "Presentes pagam as contas da IA" }] };
    hub.ticker(ticker);
    expect(attach("late", "program").sent.find((m) => m.t === "ticker")).toMatchObject({ ticker });
    hub.ticker(null);
    expect(attach("later", "program").sent.some((m) => m.t === "ticker")).toBe(false);
    after();
  });
});

describe("StageHub reload", () => {
  it("reloads OBS sources only, never previews or the cloud broadcast", () => {
    const { hub, attach, after } = setup();
    const obs = attach("obs", "program");
    const obs2 = attach("obs2", "program");
    const cloud = attach("cloud", "broadcast");
    const studio = attach("studio", "preview");
    expect(hub.reloadProgram()).toBe(2);
    expect(obs.sent.at(-1)).toEqual({ v: 1, t: "reload" });
    expect(obs2.sent.at(-1)).toEqual({ v: 1, t: "reload" });
    expect(cloud.sent.some((m) => m.t === "reload")).toBe(false);
    expect(studio.sent.some((m) => m.t === "reload")).toBe(false);
    after();
  });
});
