import { describe, expect, it } from "bun:test";
import { createApi } from "../src/api";
import { loadConfig } from "../src/config";
import { ffmpegArgs, ProgressParser } from "../src/ffmpeg";
import { BroadcastManager } from "../src/manager";
import { ingestUrl, isPrivateAddress, redact, validateRtmpUrl } from "../src/rtmp";
import { backoffMs } from "../src/session";
import { eventually, FakeFactory, quietLog } from "./fakes";

const TOKEN = "t".repeat(32);
const video = { width: 720, height: 1280, fps: 30, bitrateKbps: 3000 };
const publicDns = async () => ["104.16.1.1"];

function setup(maxConcurrent = 2) {
  const factory = new FakeFactory();
  const manager = new BroadcastManager({
    factory,
    log: quietLog,
    maxConcurrent,
    stageOrigins: ["http://app:8080"],
    rtmp: { resolve: publicDns },
    backoff: () => 20,
  });
  return { factory, manager, api: createApi(manager, TOKEN) };
}

const request = (channelId = "ch1", overrides: Record<string, unknown> = {}) => ({
  channelId,
  stageUrl: `http://app:8080/s/key-${channelId}`,
  rtmpUrl: "rtmps://push.example.com/live",
  streamKey: "sk_live_SECRET123",
  ...overrides,
});

describe("RTMP target validation", () => {
  it("accepts public rtmp and rtmps servers", async () => {
    const url = await validateRtmpUrl("rtmps://push.example.com:443/live", { resolve: publicDns });
    expect(url.protocol).toBe("rtmps:");
  });

  it("rejects other schemes, credentials and private addresses", async () => {
    await expect(validateRtmpUrl("http://example.com/live", { resolve: publicDns })).rejects.toThrow("rtmp://");
    await expect(validateRtmpUrl("rtmp://user:pw@example.com/live", { resolve: publicDns })).rejects.toThrow("stream key");
    await expect(validateRtmpUrl("rtmp://127.0.0.1/live")).rejects.toThrow("isn't allowed");
    await expect(validateRtmpUrl("rtmp://internal.example/live", { resolve: async () => ["10.0.0.5"] })).rejects.toThrow("isn't allowed");
    await expect(validateRtmpUrl("rtmp://[::1]/live")).rejects.toThrow("isn't allowed");
  });

  it("allows private targets only when explicitly enabled", async () => {
    expect((await validateRtmpUrl("rtmp://127.0.0.1:1935/live", { allowPrivate: true })).hostname).toBe("127.0.0.1");
  });

  it("classifies addresses", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "104.16.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });

  it("builds the ingest URL and redacts the key from text", () => {
    expect(ingestUrl(new URL("rtmps://push.example.com/live/"), "abc123")).toBe("rtmps://push.example.com/live/abc123");
    expect(redact("Output to rtmps://x/live/abc123 failed", ["abc123"])).toBe("Output to rtmps://x/live/[stream key] failed");
  });
});

describe("ffmpeg", () => {
  it("encodes H.264 and AAC in FLV with a keyframe every two seconds", () => {
    const args = ffmpegArgs("rtmps://x/live/key", video);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("-c:v")).toBe("libx264");
    expect(at("-c:a")).toBe("aac");
    expect(at("-f")).toBe("webm");
    expect(args.at(-1)).toBe("rtmps://x/live/key");
    expect(at("-g")).toBe("60");
    expect(at("-b:v")).toBe("3000k");
    expect(at("-maxrate")).toBe("3000k");
  });

  it("parses -progress blocks", () => {
    const parser = new ProgressParser();
    const lines = ["frame=300", "fps=30.01", "bitrate=  2950.1kbits/s", "drop_frames=2", "speed=1.01x"];
    for (const line of lines) {
      expect(ProgressParser.isProgressLine(line)).toBe(true);
      expect(parser.feed(line)).toBeNull();
    }
    expect(parser.feed("progress=continue")).toEqual({ fps: 30.01, bitrateKbps: 2950.1, droppedFrames: 2, speed: 1.01 });
    expect(ProgressParser.isProgressLine("[flv @ 0x1] Failed to update header with correct duration.")).toBe(false);
    expect(parser.feed("bitrate=N/A")).toBeNull();
    expect(parser.feed("progress=continue")?.bitrateKbps).toBeNull();
  });

  it("backs off exponentially up to 30 s", () => {
    expect([1, 2, 3, 4, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 30_000]);
  });
});

describe("BroadcastManager", () => {
  it("starts a broadcast and pipes stage chunks into the encoder", async () => {
    const { factory, manager } = setup();
    const status = await manager.ensure(request());
    expect(status.state).toBe("starting");
    await eventually(() => manager.get("ch1")?.state === "live");
    expect(factory.encoders[0]?.output).toBe("rtmps://push.example.com/live/sk_live_SECRET123");
    expect(factory.encoders[0]?.chunks.length).toBe(1);
    await manager.stop("ch1");
    expect(factory.encoders[0]?.killed).toBe(true);
    expect(factory.stages[0]?.closedCount).toBe(1);
  });

  it("is idempotent, and restarts when the target changes", async () => {
    const { factory, manager } = setup();
    await manager.ensure(request());
    await manager.ensure(request());
    await eventually(() => factory.encoders.length === 1);
    await manager.ensure(request("ch1", { streamKey: "a-new-key-456" }));
    await eventually(() => factory.encoders.length === 2);
    expect(factory.encoders[0]?.killed).toBe(true);
    await manager.stopAll();
  });

  it("restarts the pipeline when the encoder or page dies, and recovers", async () => {
    const { factory, manager } = setup();
    await manager.ensure(request());
    await eventually(() => manager.get("ch1")?.state === "live");
    factory.encoders[0]?.crash(1);
    await eventually(() => factory.encoders.length === 2 && manager.get("ch1")?.state === "live");
    expect(manager.get("ch1")?.restarts).toBe(1);
    factory.stages[1]?.crash("The stage page crashed");
    await eventually(() => factory.encoders.length === 3);
    await manager.stopAll();
  });

  it("reports failure after repeated quick failures, without leaking the key", async () => {
    const { factory, manager } = setup();
    factory.failOpen = "connect to rtmps://push.example.com/live/sk_live_SECRET123 refused";
    await manager.ensure(request());
    await eventually(() => manager.get("ch1")?.state === "failed", 3000);
    const status = manager.get("ch1")!;
    expect(status.detail).not.toContain("SECRET123");
    expect(status.detail).toContain("[stream key]");
    await manager.stopAll();
  });

  it("enforces capacity and the stage origin", async () => {
    const { manager } = setup(1);
    await manager.ensure(request("a"));
    await expect(manager.ensure(request("b"))).rejects.toMatchObject({ code: "at_capacity" });
    await expect(manager.ensure(request("a", { stageUrl: "http://evil.example/s/x" }))).rejects.toMatchObject({ code: "stage_not_allowed" });
    await expect(manager.ensure(request("a", { rtmpUrl: "rtmp://192.168.0.10/live" }))).rejects.toMatchObject({ code: "bad_rtmp_url" });
    await manager.stopAll();
  });
});

describe("internal API", () => {
  it("requires the bearer token", async () => {
    const { api } = setup();
    expect((await api.request("/broadcasts")).status).toBe(401);
    expect((await api.request("/broadcasts", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await api.request("/healthz")).status).toBe(200);
  });

  it("starts, reports and stops broadcasts", async () => {
    const { api, manager } = setup();
    const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const start = await api.request("/broadcasts", { method: "POST", headers: auth, body: JSON.stringify(request()) });
    expect(start.status).toBe(202);
    const list = (await (await api.request("/broadcasts", { headers: auth })).json()) as { broadcasts: unknown[]; capacity: { used: number } };
    expect(list.capacity.used).toBe(1);
    const bad = await api.request("/broadcasts", { method: "POST", headers: auth, body: JSON.stringify(request("x", { rtmpUrl: "file:///etc/passwd" })) });
    expect(bad.status).toBe(422);
    expect((await api.request("/broadcasts/ch1", { method: "DELETE", headers: auth })).status).toBe(204);
    expect((await api.request("/broadcasts/ch1", { headers: auth })).status).toBe(404);
    await manager.stopAll();
  });
});

describe("config", () => {
  it("requires a long token and refuses private RTMP in production", () => {
    expect(() => loadConfig({ BROADCASTER_TOKEN: "short" })).toThrow("BROADCASTER_TOKEN");
    expect(() => loadConfig({ BROADCASTER_TOKEN: TOKEN, NODE_ENV: "production", ALLOW_PRIVATE_RTMP: "true" })).toThrow("ALLOW_PRIVATE_RTMP");
    expect(loadConfig({ BROADCASTER_TOKEN: TOKEN, STAGE_ORIGINS: "http://app:8080/, https://lantern.example" }).stageOrigins).toEqual(["http://app:8080", "https://lantern.example"]);
  });
});
