import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  evaluateStreamSchedule,
  type BroadcasterList,
  type BroadcastStatus,
  type ChannelDto,
  type RuntimeSnapshot,
  type StartBroadcast,
} from "@tik-live/shared";
import { eq } from "drizzle-orm";
import type { BroadcasterClient } from "../../src/broadcast/client";
import { channel as channelTable } from "../../src/db/schema";
import type { LiveStudioClient, LiveStudioProbe } from "../../src/broadcast/live-studio";
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
  highlights = 0;
  recording = false;
  scene = "Cena Principal";
  vibes: string[] = [];
  injectedUrls: string[] = [];
  streamStatus: "stopped" | "paused" | "live" = "stopped";
  async probe(): Promise<LiveStudioProbe> {
    return {
      connected: true,
      port: 28189,
      streamStatus: this.streamStatus,
      scene: this.scene,
      installed: true,
      executablePath: "C:\\Program Files\\TikTok LIVE Studio\\1.38.0\\TikTok LIVE Studio.exe",
      recording: this.recording,
      highlightAble: true,
      tiktokUsername: "curiosabolha",
      stageInjected: this.injectedUrls.length > 0,
      sceneList: [
        {
          name: "Cena Principal",
          sources: [{ id: "src-vincular", label: "Vincular", visible: true }],
        },
        {
          name: "Câmera em tela cheia",
          sources: [{ id: "src-vincular", label: "Vincular", visible: true }],
        },
      ],
      vibeList: [
        { id: "vibe-victory", name: "Vitória!" },
        { id: "vibe-roast", name: "Essa doeu!" },
      ],
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
  async highlight(): Promise<{ ok: boolean; detail: string }> {
    this.highlights++;
    return { ok: true, detail: "Clipe de destaque (60s) salvo no TikTok LIVE Studio!" };
  }
  async toggleRecording(): Promise<{ ok: boolean; detail: string }> {
    this.recording = !this.recording;
    return { ok: true, detail: this.recording ? "Gravação iniciada" : "Gravação encerrada" };
  }
  async switchScene(scene: string): Promise<{ ok: boolean; detail: string }> {
    this.scene = scene;
    return { ok: true, detail: `Cena alterada para "${scene}".` };
  }
  async toggleSource(sourceId: string): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: `Fonte ${sourceId} alternada.` };
  }
  async triggerVibe(vibeId: string): Promise<{ ok: boolean; detail: string }> {
    this.vibes.push(vibeId);
    return { ok: true, detail: `Vibe "${vibeId}" acionada!` };
  }
  async injectStage(stageUrl: string): Promise<{ ok: boolean; detail: string }> {
    this.injectedUrls.push(stageUrl);
    return { ok: true, detail: 'Fonte "Vincular" (1080×1920, com áudio) adicionada.' };
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
      probe: expect.objectContaining({ connected: true, tiktokUsername: "curiosabolha" }),
    });

    await server.json(`/api/channels/${channel.id}/stop`, { method: "POST", user: "studiocaster" });
    await eventually(() => liveStudio.stops === 1);
    studio.close();
  });

  it("executes highlight, recording, scene, vibe, inject_stage, and sync_handle actions via /live-studio/action", async () => {
    const created = await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "actioncaster", json: { name: "Action Host" } });
    const channel = created.body.channel;

    const syncRes = await server.json<{ ok: boolean; detail: string; channel: ChannelDto | null }>(
      `/api/channels/${channel.id}/live-studio/action`,
      { method: "POST", user: "actioncaster", json: { action: "sync_handle" } },
    );
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.ok).toBe(true);
    expect(syncRes.body.channel?.tiktokUsername).toBe("curiosabolha");
    expect(syncRes.body.channel?.source).toBe("tiktok");

    const injectRes = await server.json<{ ok: boolean; probe: LiveStudioProbe }>(
      `/api/channels/${channel.id}/live-studio/action`,
      { method: "POST", user: "actioncaster", json: { action: "inject_stage" } },
    );
    expect(injectRes.status).toBe(200);
    expect(injectRes.body.ok).toBe(true);
    expect(injectRes.body.probe.stageInjected).toBe(true);
    expect(liveStudio.injectedUrls).toContain(channel.stageUrl);

    const sceneRes = await server.json<{ ok: boolean; probe: LiveStudioProbe }>(
      `/api/channels/${channel.id}/live-studio/action`,
      { method: "POST", user: "actioncaster", json: { action: "scene", scene: "Câmera em tela cheia" } },
    );
    expect(sceneRes.body.ok).toBe(true);
    expect(sceneRes.body.probe.scene).toBe("Câmera em tela cheia");

    const vibeRes = await server.json<{ ok: boolean; detail: string }>(
      `/api/channels/${channel.id}/live-studio/action`,
      { method: "POST", user: "actioncaster", json: { action: "vibe", vibeId: "vibe-victory" } },
    );
    expect(vibeRes.body.ok).toBe(true);
    expect(liveStudio.vibes).toContain("vibe-victory");

    const hlRes = await server.json<{ ok: boolean }>(
      `/api/channels/${channel.id}/live-studio/action`,
      { method: "POST", user: "actioncaster", json: { action: "highlight" } },
    );
    expect(hlRes.body.ok).toBe(true);
    expect(liveStudio.highlights).toBe(1);

    const recRes = await server.json<{ ok: boolean; probe: LiveStudioProbe }>(
      `/api/channels/${channel.id}/live-studio/action`,
      { method: "POST", user: "actioncaster", json: { action: "recording" } },
    );
    expect(recRes.body.ok).toBe(true);
    expect(recRes.body.probe.recording).toBe(true);
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
      probe: expect.objectContaining({ connected: true, scene: "Cena do PC" }),
    });

    await server.json(`/api/channels/${channel.id}/stop`, { method: "POST", user: "bridgecaster" });
    await eventually(() => remoteStops === 1);

    // Rotating the stage key disconnects the old bridge agent
    await server.json(`/api/channels/${channel.id}/stage-key`, { method: "POST", user: "bridgecaster" });
    await eventually(() => bridge.closed?.code === 4001);
    studio.close();
  });
});

describe("scheduled stream hours", () => {
  it("evaluates same-day and overnight schedules across time zones and weekdays", () => {
    // 2026-10-21T23:30:00Z is Wednesday 20:30 in America/Sao_Paulo (UTC-3)
    const wed2030Brt = new Date("2026-10-21T23:30:00Z");
    const sameDay = evaluateStreamSchedule(
      {
        enabled: true,
        startTime: "20:00",
        endTime: "23:00",
        days: [3], // Wednesday
        timezone: "America/Sao_Paulo",
      },
      wed2030Brt,
    );
    expect(sameDay.inWindow).toBe(true);
    expect(sameDay.localTime).toBe("20:30");
    expect(sameDay.windowKey).toBe("2026-10-21:20:00-23:00");

    // Overnight: Wednesday 22:00 -> Thursday 02:00 in America/Sao_Paulo
    // At Thursday 01:15 BRT (2026-10-22T04:15:00Z), it is still inside Wednesday's overnight window!
    const thu0115Brt = new Date("2026-10-22T04:15:00Z");
    const overnight = evaluateStreamSchedule(
      {
        enabled: true,
        startTime: "22:00",
        endTime: "02:00",
        days: [3], // Wednesday only
        timezone: "America/Sao_Paulo",
      },
      thu0115Brt,
    );
    expect(overnight.inWindow).toBe(true);
    expect(overnight.windowKey).toBe("2026-10-21:22:00-02:00");

    // At Thursday 02:05 BRT (2026-10-22T05:05:00Z), the overnight window has ended
    const thu0205Brt = new Date("2026-10-22T05:05:00Z");
    const afterOvernight = evaluateStreamSchedule(
      {
        enabled: true,
        startTime: "22:00",
        endTime: "02:00",
        days: [3],
        timezone: "America/Sao_Paulo",
      },
      thu0205Brt,
    );
    expect(afterOvernight.inWindow).toBe(false);
    expect(afterOvernight.windowKey).toBeNull();
  });

  it("saves scheduled stream hours and automatically starts and stops the channel at the scheduled times", async () => {
    const created = await server.json<{ channel: ChannelDto }>("/api/channels", {
      method: "POST",
      user: "schedcaster",
      json: { name: "Scheduled Host" },
    });
    const channel = created.body.channel;

    const saved = await server.json<{ channel: ChannelDto }>(`/api/channels/${channel.id}/broadcast`, {
      method: "PUT",
      user: "schedcaster",
      json: {
        liveStudio: true,
        schedule: {
          enabled: true,
          startTime: "20:00",
          endTime: "23:00",
          days: [3], // Wednesday
          timezone: "America/Sao_Paulo",
        },
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.channel.broadcast.schedule).toEqual({
      enabled: true,
      startTime: "20:00",
      endTime: "23:00",
      days: [3],
      timezone: "America/Sao_Paulo",
    });

    const startsBefore = liveStudio.starts;
    const stopsBefore = liveStudio.stops;

    // 19:30 BRT on Wednesday -> outside window, remains stopped
    await server.deps.manager.checkSchedules(new Date("2026-10-21T22:30:00Z"));
    let checkChannel = await server.json<{ channel: ChannelDto }>(`/api/channels/${channel.id}`, { user: "schedcaster" });
    expect(checkChannel.body.channel.desiredState).toBe("stopped");

    // 20:05 BRT on Wednesday -> inside window, starts automatically (including TikTok LIVE Studio!)
    await server.deps.manager.checkSchedules(new Date("2026-10-21T23:05:00Z"));
    await eventually(() => liveStudio.starts === startsBefore + 1);
    checkChannel = await server.json<{ channel: ChannelDto }>(`/api/channels/${channel.id}`, { user: "schedcaster" });
    expect(checkChannel.body.channel.desiredState).toBe("running");

    // 23:01 BRT on Wednesday -> window ended, stops automatically
    await server.deps.manager.checkSchedules(new Date("2026-10-22T02:01:00Z"));
    await eventually(() => liveStudio.stops === stopsBefore + 1);
    checkChannel = await server.json<{ channel: ChannelDto }>(`/api/channels/${channel.id}`, { user: "schedcaster" });
    expect(checkChannel.body.channel.desiredState).toBe("stopped");
  });

  /** A window around the real time now, since a manual stop is judged against the clock. */
  function windowAroundNow(): { startTime: string; endTime: string } {
    const hhmm = (offsetMin: number) =>
      new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
        new Date(Date.now() + offsetMin * 60_000),
      );
    return { startTime: hhmm(-60), endTime: hhmm(60) };
  }

  it("keeps a manual stop for the rest of the window, unless the schedule itself changes", async () => {
    const channel = (await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "holdcaster", json: { name: "Hold" } })).body.channel;
    const window = windowAroundNow();
    const schedule = { enabled: true, ...window, timezone: "America/Sao_Paulo" };
    await server.json(`/api/channels/${channel.id}/broadcast`, { method: "PUT", user: "holdcaster", json: { schedule } });
    await server.deps.manager.checkSchedules();
    const state = async () => (await server.json<{ channel: ChannelDto }>(`/api/channels/${channel.id}`, { user: "holdcaster" })).body.channel.desiredState;
    await eventually(async () => (await state()) === "running");

    await server.json(`/api/channels/${channel.id}/stop`, { method: "POST", user: "holdcaster" });
    // Renaming the host is not a reason to come back on.
    await server.json(`/api/channels/${channel.id}`, { method: "PATCH", user: "holdcaster", json: { name: "Hold 2" } });
    await server.deps.manager.checkSchedules();
    expect(await state()).toBe("stopped");

    // Changing the hours is.
    const [h, m] = window.endTime.split(":").map(Number) as [number, number];
    const later = `${String((h + (m >= 59 ? 1 : 0)) % 24).padStart(2, "0")}:${String((m + 1) % 60).padStart(2, "0")}`;
    await server.json(`/api/channels/${channel.id}/broadcast`, { method: "PUT", user: "holdcaster", json: { schedule: { ...schedule, endTime: later } } });
    await server.deps.manager.checkSchedules();
    await eventually(async () => (await state()) === "running");
    await server.json(`/api/channels/${channel.id}/stop`, { method: "POST", user: "holdcaster" });
  });

  it("tells the owner once when a scheduled start can't happen", async () => {
    const channel = (await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "failcaster", json: { name: "Fail" } })).body.channel;
    // A host left following TikTok with no account to follow (the dashboard no longer allows it, older rows may).
    await server.deps.db.update(channelTable).set({ source: "tiktok", tiktokUsername: null }).where(eq(channelTable.id, channel.id));
    const studio = await server.socket(`/ws/studio/${channel.id}`, "failcaster");
    const notices: string[] = [];
    studio.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as { t: string; code?: string };
      if (msg.t === "notice" && msg.code) notices.push(msg.code);
    });
    await server.json(`/api/channels/${channel.id}/broadcast`, { method: "PUT", user: "failcaster", json: { schedule: { enabled: true, ...windowAroundNow() } } });
    await server.deps.manager.checkSchedules();
    await server.deps.manager.checkSchedules();
    await eventually(() => notices.includes("schedule_start_failed"));
    await Bun.sleep(100);
    expect(notices.filter((code) => code === "schedule_start_failed")).toHaveLength(1);
    studio.close();
  });
});
