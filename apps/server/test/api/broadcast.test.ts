import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { BroadcasterList, BroadcastStatus, ChannelDto, RuntimeSnapshot, StartBroadcast } from "@tik-live/shared";
import type { BroadcasterClient } from "../../src/broadcast/client";
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
}

const broadcaster = new FakeBroadcaster();
let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    env: { BROADCAST_ENABLED: "true", BROADCASTER_URL: "http://broadcaster:8090", BROADCASTER_TOKEN: "b".repeat(32), BROADCAST_STAGE_ORIGIN: "http://lantern-app:8080" },
    broadcaster,
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

  it("refuses incomplete settings", async () => {
    const created = await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "caster2", json: { name: "Cast" } });
    const res = await server.json(`/api/channels/${created.body.channel.id}/broadcast`, { method: "PUT", user: "caster2", json: { enabled: true } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("broadcast_incomplete");
  });
});
