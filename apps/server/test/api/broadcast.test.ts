import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { BroadcasterList, BroadcastStatus, ChannelDto, RuntimeSnapshot, StartBroadcast } from "@tik-live/shared";
import type { BroadcasterClient } from "../../src/broadcast/client";
import { LIVE_STUDIO_ACTIONS, LocalLiveStudioClient, type LiveStudioClient, type LiveStudioProbe } from "../../src/broadcast/live-studio";
import { eventually, stageKeyFrom, startTestServer, type TestServer } from "../harness";

/** Records what the app asks the broadcaster to do. */
class FakeBroadcaster implements BroadcasterClient {
  readonly started: StartBroadcast[] = [];
  readonly stopped: string[] = [];
  readonly live = new Map<string, BroadcastStatus>();
  async start(request: StartBroadcast): Promise<BroadcastStatus> {
    this.started.push(request);
    const status: BroadcastStatus = { channelId: request.channelId, state: "live", detail: "Streaming", since: new Date().toISOString(), restarts: 0, stats: { fps: 30, bitrateKbps: 2950, droppedFrames: 0, speed: 1 } };
    this.live.set(request.channelId, status);
    return status;
  }
  async stop(channelId: string): Promise<void> {
    this.stopped.push(channelId);
    this.live.delete(channelId);
  }
  async list(): Promise<BroadcasterList> {
    return { broadcasts: [...this.live.values()], capacity: { max: 2, used: this.live.size } };
  }
  async check(rtmpUrl: string): Promise<{ ok: boolean; detail: string }> {
    return rtmpUrl.includes("unreachable") ? { ok: false, detail: "Couldn't reach it." } : { ok: true, detail: "Reached it." };
  }
}

class FakeLiveStudio implements LiveStudioClient {
  starts = 0;
  stops = 0;
  streamStatus: "stopped" | "paused" | "live" = "stopped";
  async probe(): Promise<LiveStudioProbe> {
    return {
      connected: true,
      port: 28189,
      streamStatus: this.streamStatus,
      scene: "Cena Principal",
      installed: true,
      executablePath: "C:\\Program Files\\TikTok LIVE Studio\\1.38.0\\TikTok LIVE Studio.exe",
    };
  }
  async start(): Promise<{ ok: boolean; detail: string }> {
    this.starts++;
    this.streamStatus = "live";
    return { ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" };
  }
  async stop(): Promise<{ ok: boolean; detail: string }> {
    this.stops++;
    this.streamStatus = "stopped";
    return { ok: true, detail: "Desligada" };
  }
}

const broadcaster = new FakeBroadcaster();
const liveStudio = new FakeLiveStudio();
let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    env: { BROADCAST_ENABLED: "true", BROADCASTER_URL: "http://broadcaster:8090", BROADCASTER_TOKEN: "b".repeat(32), BROADCAST_STAGE_ORIGIN: "http://lantern-app:8080" },
    broadcaster,
    liveStudio,
  });
});
afterAll(async () => {
  await server.close();
});

describe("cloud broadcast", () => {
  it("broadcasts while the host runs, follows setting changes, and stops with it", async () => {
    const created = await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "caster", json: { name: "Cast" } });
    const channel = created.body.channel;

    const configured = await server.json<{ channel: ChannelDto }>(`/api/channels/${channel.id}/broadcast`, {
      method: "PUT",
      user: "caster",
      json: { enabled: true, rtmpUrl: "rtmps://push.example.com/live", streamKey: "live_123_SECRET" },
    });
    expect(configured.status).toBe(200);
    expect(configured.body.channel.broadcast).toEqual({ enabled: true, rtmpUrl: "rtmps://push.example.com/live", hasStreamKey: true, streamKeyLast4: "CRET" });
    expect(JSON.stringify(configured.body)).not.toContain("live_123_SECRET");
    expect(broadcaster.started).toHaveLength(0); // not running yet

    await server.json(`/api/channels/${channel.id}/start`, { method: "POST", user: "caster" });
    await eventually(() => broadcaster.started.length === 1);
    const request = broadcaster.started[0]!;
    expect(request.streamKey).toBe("live_123_SECRET");
    expect(request.rtmpUrl).toBe("rtmps://push.example.com/live");
    expect(request.stageUrl).toBe(`http://lantern-app:8080/s/${stageKeyFrom(channel.stageUrl)}`);
    expect(request.video).toEqual({ width: 720, height: 1280, fps: 30, bitrateKbps: 4000 });

    const studio = await server.socket(`/ws/studio/${channel.id}`, "caster");
    const snapshot = await studio.next<{ state: RuntimeSnapshot }>((m) => m.t === "snapshot");
    expect(snapshot.state.health.broadcast).toEqual({ state: "live", detail: "Streaming", bitrateKbps: 2950 });

    // A new stage link restarts the broadcast on it.
    const rotated = await server.json<{ channel: ChannelDto }>(`/api/channels/${channel.id}/stage-key`, { method: "POST", user: "caster" });
    await eventually(() => broadcaster.started.length === 2);
    expect(broadcaster.started[1]!.stageUrl).toBe(`http://lantern-app:8080/s/${stageKeyFrom(rotated.body.channel.stageUrl)}`);

    // Unchanged settings don't restart it.
    await server.json(`/api/channels/${channel.id}`, { method: "PATCH", user: "caster", json: { name: "Cast two" } });
    await Bun.sleep(50);
    expect(broadcaster.started).toHaveLength(2);

    // Turning it off stops it; stopping the host doesn't start anything.
    await server.json(`/api/channels/${channel.id}/broadcast`, { method: "PUT", user: "caster", json: { enabled: false } });
    await eventually(() => broadcaster.stopped.includes(channel.id));
    await server.json(`/api/channels/${channel.id}/start`, { method: "POST", user: "caster" });
    await server.json(`/api/channels/${channel.id}/stop`, { method: "POST", user: "caster" });
    expect(broadcaster.started).toHaveLength(2);
    studio.close();
  });

  it("checks an ingest server without streaming", async () => {
    const created = await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "checker", json: { name: "Check" } });
    const id = created.body.channel.id;
    expect((await server.json(`/api/channels/${id}/broadcast/check`, { method: "POST", user: "checker", json: {} })).body.error.code).toBe("broadcast_incomplete");
    const good = await server.json(`/api/channels/${id}/broadcast/check`, { method: "POST", user: "checker", json: { rtmpUrl: "rtmps://push.example.com/live" } });
    expect(good.body).toEqual({ ok: true, detail: "Reached it." });
    const bad = await server.json(`/api/channels/${id}/broadcast/check`, { method: "POST", user: "checker", json: { rtmpUrl: "rtmps://unreachable.example/live" } });
    expect(bad.body.ok).toBe(false);
    expect(broadcaster.started).toHaveLength(2);
  });

  it("refuses incomplete settings", async () => {
    const created = await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "caster2", json: { name: "Cast" } });
    const res = await server.json(`/api/channels/${created.body.channel.id}/broadcast`, { method: "PUT", user: "caster2", json: { enabled: true } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("broadcast_incomplete");
  });
});

describe("TikTok LIVE Studio automation", () => {
  it("starts and stops TikTok LIVE Studio automatically with the channel without requiring cloud broadcast", async () => {
    const created = await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "studiocaster", json: { name: "Studio" } });
    const channel = created.body.channel;

    const checkRes = await server.json<{ ok: boolean; connected: boolean; streamStatus: string }>(`/api/channels/${channel.id}/live-studio/check`, {
      method: "POST",
      user: "studiocaster",
      json: {},
    });
    expect(checkRes.status).toBe(200);
    expect(checkRes.body.ok).toBe(true);
    expect(checkRes.body.connected).toBe(true);

    const configured = await server.json<{ channel: ChannelDto }>(`/api/channels/${channel.id}/broadcast`, {
      method: "PUT",
      user: "studiocaster",
      json: { liveStudio: true },
    });
    expect(configured.status).toBe(200);
    expect(configured.body.channel.broadcast.liveStudio).toBe(true);
    expect(liveStudio.starts).toBe(0);

    await server.json(`/api/channels/${channel.id}/start`, { method: "POST", user: "studiocaster" });
    await eventually(() => liveStudio.starts === 1);

    const studio = await server.socket(`/ws/studio/${channel.id}`, "studiocaster");
    const snapshot = await studio.next<{ state: RuntimeSnapshot }>((m) => m.t === "snapshot");
    expect(snapshot.state.health.liveStudio).toEqual({
      state: "live",
      detail: "Transmitindo pelo TikTok LIVE Studio",
      bridgeConnected: false,
    });

    await server.json(`/api/channels/${channel.id}/stop`, { method: "POST", user: "studiocaster" });
    await eventually(() => liveStudio.stops === 1);
    studio.close();
  });

  it("controls TikTok LIVE Studio remotely through a connected Local Bridge Agent (/ws/bridge/:stageKey)", async () => {
    const created = await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "bridgecaster", json: { name: "Bridge Host" } });
    const channel = created.body.channel;
    const stageKey = stageKeyFrom(channel.stageUrl);

    let remoteStarts = 0;
    let remoteStops = 0;
    let remoteStatus: "stopped" | "live" = "stopped";

    const bridge = await server.socket(`/ws/bridge/${stageKey}`);
    const hello = await bridge.next<{ t: "hello"; channelName: string }>((m) => m.t === "hello");
    expect(hello.channelName).toBe("Bridge Host");

    // Respond to server RPC requests on the bridge socket
    bridge.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.t !== "request") return;
      if (msg.action === "probe") {
        bridge.send({
          v: 1,
          t: "response",
          id: msg.id,
          probe: {
            connected: true,
            port: 28189,
            streamStatus: remoteStatus,
            scene: "Cena do PC",
            installed: true,
            executablePath: "C:\\Program Files\\TikTok LIVE Studio\\1.38.0\\TikTok LIVE Studio.exe",
          },
        });
      } else if (msg.action === "start") {
        remoteStarts += 1;
        remoteStatus = "live";
        bridge.send({
          v: 1,
          t: "response",
          id: msg.id,
          result: { ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" },
        });
      } else if (msg.action === "stop") {
        remoteStops += 1;
        remoteStatus = "stopped";
        bridge.send({
          v: 1,
          t: "response",
          id: msg.id,
          result: { ok: true, detail: "Desligada" },
        });
      }
    });

    const checkRes = await server.json<{ ok: boolean; connected: boolean; bridgeConnected: boolean; detail: string }>(
      `/api/channels/${channel.id}/live-studio/check`,
      { method: "POST", user: "bridgecaster", json: {} },
    );
    expect(checkRes.status).toBe(200);
    expect(checkRes.body.ok).toBe(true);
    expect(checkRes.body.bridgeConnected).toBe(true);
    expect(checkRes.body.detail).toContain("Agente conectado ao TikTok LIVE Studio no seu PC");

    const localStartsBefore = liveStudio.starts;
    await server.json(`/api/channels/${channel.id}/broadcast`, {
      method: "PUT",
      user: "bridgecaster",
      json: { liveStudio: true },
    });
    await server.json(`/api/channels/${channel.id}/start`, { method: "POST", user: "bridgecaster" });
    await eventually(() => remoteStarts === 1);
    expect(liveStudio.starts).toBe(localStartsBefore);

    const studio = await server.socket(`/ws/studio/${channel.id}`, "bridgecaster");
    const snapshot = await studio.next<{ state: RuntimeSnapshot }>((m) => m.t === "snapshot");
    expect(snapshot.state.health.liveStudio).toEqual({
      state: "live",
      detail: "Transmitindo pelo TikTok LIVE Studio",
      bridgeConnected: true,
    });

    await server.json(`/api/channels/${channel.id}/stop`, { method: "POST", user: "bridgecaster" });
    await eventually(() => remoteStops === 1);

    // Rotating the stage key disconnects the old bridge agent
    await server.json(`/api/channels/${channel.id}/stage-key`, { method: "POST", user: "bridgecaster" });
    await eventually(() => bridge.closed?.code === 4001);
    studio.close();
  });

  it("speaks the TikTok LIVE Studio StreamDeckService Socket.IO protocol idempotently", async () => {
    let streamStatus = 0; // 0 = stopped, 1 = paused, 2 = live
    const actionsReceived: string[] = [];

    const mockServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send('0{"sid":"mock-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
        },
        message(ws, message) {
          const text = String(message);
          if (text === "40") {
            ws.send('40{"sid":"mock-room-sid"}');
            return;
          }
          if (text === '42["stream_deck/sync_settings"]') {
            const payload = JSON.stringify({ stream_status: streamStatus, scene: "Cena 1" });
            ws.send(`42${JSON.stringify(["stream_deck/sync_settings", payload])}`);
            return;
          }
          if (text.startsWith('42["stream_deck/action_emit"')) {
            const [, raw] = JSON.parse(text.slice(2)) as [string, string];
            const parsed = JSON.parse(raw) as { action: string; context: string };
            actionsReceived.push(parsed.action);
            if (parsed.action === LIVE_STUDIO_ACTIONS.liveStartEnd) {
              streamStatus = streamStatus === 0 ? 2 : 0;
            } else if (parsed.action === LIVE_STUDIO_ACTIONS.livePauseResume) {
              streamStatus = streamStatus === 1 ? 2 : 1;
            }
            ws.send(`42${JSON.stringify([`stream_deck/${parsed.context}`, JSON.stringify({ code: 0 })])}`);
          }
        },
      },
    });

    try {
      const client = new LocalLiveStudioClient({
        host: "127.0.0.1",
        ports: [mockServer.port!],
        executablePath: "C:\\Program Files\\TikTok LIVE Studio\\1.38.0\\TikTok LIVE Studio.exe",
      });

      const initial = await client.probe();
      expect(initial.connected).toBe(true);
      expect(initial.streamStatus).toBe("stopped");
      expect(initial.scene).toBe("Cena 1");

      // Starting from stopped triggers livestartend once
      const started = await client.start();
      expect(started.ok).toBe(true);
      expect(actionsReceived).toEqual([LIVE_STUDIO_ACTIONS.liveStartEnd]);
      expect((await client.probe()).streamStatus).toBe("live");

      // Starting again while already live is a no-op (does not toggle off!)
      const startedAgain = await client.start();
      expect(startedAgain.ok).toBe(true);
      expect(actionsReceived).toEqual([LIVE_STUDIO_ACTIONS.liveStartEnd]);

      // Starting while paused sends livepauseresume
      streamStatus = 1;
      const resumed = await client.start();
      expect(resumed.ok).toBe(true);
      expect(actionsReceived).toEqual([LIVE_STUDIO_ACTIONS.liveStartEnd, LIVE_STUDIO_ACTIONS.livePauseResume]);
      expect((await client.probe()).streamStatus).toBe("live");

      // Stopping from live triggers livestartend
      const stopped = await client.stop();
      expect(stopped.ok).toBe(true);
      expect((await client.probe()).streamStatus).toBe("stopped");

      // Stopping again while already stopped is a no-op
      const countBefore = actionsReceived.length;
      const stoppedAgain = await client.stop();
      expect(stoppedAgain.ok).toBe(true);
      expect(actionsReceived).toHaveLength(countBefore);
    } finally {
      mockServer.stop(true);
    }
  });
});
