import { beforeEach, describe, expect, it } from "bun:test";
import { PROTOCOL_VERSION } from "@tik-live/shared";
import { CLOSE_GONE, CLOSE_REVOKED, connectStage, reconnectDelay, stageSocketUrl, type StageConnectionState } from "../src/client";
import { FakeEngine, FakeSocket, FakeTimers } from "./fakes";

const look = { character: "orb", primary: "#7CF5FF", secondary: "#FF5FD2", background: "#0B0420" } as const;

function setup() {
  const engine = new FakeEngine();
  const timers = new FakeTimers();
  const states: StageConnectionState[] = [];
  let reloads = 0;
  const connection = connectStage({
    engine,
    url: "ws://localhost/ws/stage/key?role=program",
    role: "program",
    WebSocket: FakeSocket as unknown as new (url: string) => WebSocket,
    random: () => 1,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    reload: () => {
      reloads += 1;
    },
    onState: (s) => states.push(s),
  });
  const socket = () => FakeSocket.instances.at(-1) as FakeSocket;
  return { engine, timers, states, connection, socket, reloads: () => reloads };
}

beforeEach(() => {
  FakeSocket.instances = [];
});

describe("stageSocketUrl", () => {
  it("uses wss on https pages and escapes the key", () => {
    expect(stageSocketUrl({ protocol: "https:", host: "app.example.com" }, "a/b", "broadcast")).toBe("wss://app.example.com/ws/stage/a%2Fb?role=broadcast");
    expect(stageSocketUrl({ protocol: "http:", host: "localhost:5173" }, "k", "program")).toBe("ws://localhost:5173/ws/stage/k?role=program");
  });
});

describe("reconnectDelay", () => {
  it("doubles from 0.5 s to a 10 s ceiling with jitter", () => {
    expect(reconnectDelay(0, () => 1)).toBe(500);
    expect(reconnectDelay(1, () => 1)).toBe(1000);
    expect(reconnectDelay(10, () => 1)).toBe(10_000);
    expect(reconnectDelay(10, () => 0)).toBe(5000);
  });
});

describe("connectStage", () => {
  it("announces itself, then feeds messages to the engine", () => {
    const { engine, socket, states } = setup();
    socket().open();
    const [ready, telemetry] = socket().sent;
    expect(ready).toMatchObject({ v: PROTOCOL_VERSION, t: "ready", role: "program", caps: { webgl2: true } });
    expect(telemetry).toMatchObject({ t: "telemetry", fps: 60, renderer: "fake" });
    expect(states).toEqual(["connected"]);

    socket().receive({ v: 1, t: "hello", serverTime: 1, name: "Blip", look, disclosure: "Blip is an AI host" });
    socket().receive({ v: 1, t: "segment", title: "Q&A" });
    expect(engine.applied.map((m) => m.t)).toEqual(["hello", "segment"]);
    expect("v" in (engine.applied[0] as object)).toBe(false);
  });

  it("ignores malformed and unknown messages", () => {
    const { engine, socket } = setup();
    socket().open();
    socket().receive("not json");
    socket().receive({ v: 1, t: "explode" });
    socket().receive({ v: 1, t: "speak", id: 5 });
    expect(engine.applied).toEqual([]);
  });

  it("reports spoken cues back to the server", async () => {
    const { socket } = setup();
    socket().open();
    socket().receive({ v: 1, t: "speak", id: "cue-1", text: "Hi", emotion: "happy", audioUrl: null, durationMs: 800 });
    await Promise.resolve();
    expect(socket().sent.at(-1)).toEqual({ v: PROTOCOL_VERSION, t: "spoken", id: "cue-1" });
  });

  it("reconnects with backoff after losing the connection", () => {
    const { socket, timers, states } = setup();
    socket().open();
    socket().drop();
    expect(states.at(-1)).toBe("reconnecting");
    expect(timers.runNext()).toBe(500);
    expect(FakeSocket.instances).toHaveLength(2);
    socket().drop();
    expect(timers.runNext()).toBe(1000);
    socket().open();
    expect(states.at(-1)).toBe("connected");
    socket().drop();
    expect(timers.runNext()).toBe(500); // backoff resets after a good connection
  });

  it("retries promptly after the server says it is restarting", () => {
    const { socket, timers } = setup();
    socket().open();
    socket().drop();
    timers.runNext();
    socket().drop();
    timers.runNext();
    socket().open();
    socket().receive({ v: 1, t: "hold" });
    socket().drop(1001);
    expect(timers.runNext()).toBeLessThanOrEqual(1500);
  });

  it("stops for good when the link is replaced or the channel deleted", () => {
    for (const [code, state] of [
      [CLOSE_REVOKED, "revoked"],
      [CLOSE_GONE, "gone"],
    ] as const) {
      const { socket, timers, states } = setup();
      socket().open();
      socket().drop(code);
      expect(states.at(-1)).toBe(state);
      expect(timers.pending).toHaveLength(0);
    }
  });

  it("reloads when the server asks or speaks a newer protocol", () => {
    const { socket, reloads, engine } = setup();
    socket().open();
    socket().receive({ v: 1, t: "hello", serverTime: 1, name: "B", look, disclosure: "x", reload: true });
    expect(reloads()).toBe(1);
    socket().receive({ v: 2, t: "hello", serverTime: 1, name: "B", look, disclosure: "x", newThing: 1 });
    expect(reloads()).toBe(2);
    expect(engine.applied).toEqual([]);
  });

  it("close() cancels retries and detaches from the engine", () => {
    const { connection, socket, timers, engine, states } = setup();
    socket().open();
    socket().drop();
    connection.close();
    expect(timers.pending).toHaveLength(0);
    expect(engine.listeners.spoken.size).toBe(0);
    expect(states.at(-1)).toBe("closed");
  });
});
