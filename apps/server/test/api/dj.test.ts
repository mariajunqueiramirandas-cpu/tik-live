import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DJ_CATALOG, type ChannelDto, type RuntimeSnapshot } from "@tik-live/shared";
import { startTestServer, stageKeyFrom, type TestServer } from "../harness";

let server: TestServer;
let cacheDir: string;
/** A small stand-in MP3 (an ID3 header and some bytes). */
const FAKE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, ...Array.from({ length: 90 }, (_, i) => i)]);

beforeAll(async () => {
  // Every catalog track is already on disk, so nothing is fetched from the internet.
  cacheDir = await mkdtemp(path.join(tmpdir(), "dj-api-"));
  await Promise.all(DJ_CATALOG.map((track) => Bun.write(path.join(cacheDir, `${track.id}.mp3`), FAKE_MP3)));
  server = await startTestServer({ env: { DJ_CACHE_DIR: cacheDir } });
});
afterAll(async () => {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
});

async function newChannel(): Promise<ChannelDto> {
  return (await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "dj", json: { name: "DJ test" } })).body.channel;
}

describe("the automatic DJ", () => {
  it("serves catalog tracks to the channel's stages, with byte ranges", async () => {
    const channel = await newChannel();
    const key = stageKeyFrom(channel.stageUrl);
    const full = await server.api(`/api/stage/${key}/dj/werq`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("audio/mpeg");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(FAKE_MP3);

    const part = await server.api(`/api/stage/${key}/dj/werq`, { headers: { range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 10-19/${FAKE_MP3.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(FAKE_MP3.slice(10, 20));

    const beyond = await server.api(`/api/stage/${key}/dj/werq`, { headers: { range: "bytes=5000-" } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${FAKE_MP3.length}`);

    // Only catalog tracks, and only with a real stage key.
    expect((await server.api(`/api/stage/${key}/dj/not-a-track`)).status).toBe(404);
    expect((await server.api(`/api/stage/${key}/dj/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await server.api("/api/stage/AAAAAAAAAAAAAAAAAAAAAA/dj/werq")).status).toBe(404);
  });

  it("starts when switched on while live, plays to the stage, skips, and stops when switched off", async () => {
    const channel = await newChannel();
    const key = stageKeyFrom(channel.stageUrl);
    const stage = await server.socket(`/ws/stage/${key}?role=program`);
    stage.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.t === "speak") stage.send({ v: 1, t: "spoken", id: message.id });
    });
    await stage.next((m) => m.t === "hello");
    const studio = await server.socket(`/ws/studio/${channel.id}`, "dj");
    await studio.next((m) => m.t === "snapshot");
    await server.json(`/api/channels/${channel.id}/start`, { method: "POST", user: "dj" });
    await stage.next((m) => m.t === "speak");

    // Off by default.
    studio.send({ v: 1, t: "command", id: "s0", command: { kind: "dj_skip" } });
    expect(await studio.next((m) => m.t === "ack" && m.id === "s0")).toMatchObject({ ok: false });

    const persona = { ...channel.persona, sound: { music: true, effects: true, dj: true } };
    expect((await server.json(`/api/channels/${channel.id}`, { method: "PATCH", user: "dj", json: { persona } })).status).toBe(200);
    const first = await stage.next<{ track: { id: string; url: string; credit: string }; next: string }>((m) => m.t === "dj" && m.track !== null);
    expect(first.track.url).toBe(`/api/stage/${key}/dj/${first.track.id}`);
    expect(first.track.credit).toContain("CC BY 4.0");
    expect(first.next).toStartWith(`/api/stage/${key}/dj/`);
    // The stage can fetch what it was told to play.
    expect((await server.api(first.track.url)).status).toBe(200);
    const status = await studio.next<{ state: RuntimeSnapshot }>((m) => m.t === "patch" && m.state.dj?.id === first.track.id);
    expect(status.state.dj).toMatchObject({ artist: "Kevin MacLeod" });

    studio.send({ v: 1, t: "command", id: "s1", command: { kind: "dj_skip" } });
    expect(await studio.next((m) => m.t === "ack" && m.id === "s1")).toMatchObject({ ok: true });
    const second = await stage.next<{ track: { url: string } }>((m) => m.t === "dj" && m.track !== null);
    expect(second.track.url).toBe(first.next);

    const off = { ...channel.persona, sound: { music: true, effects: true, dj: false } };
    await server.json(`/api/channels/${channel.id}`, { method: "PATCH", user: "dj", json: { persona: off } });
    await stage.next((m) => m.t === "dj" && m.track === null);

    await server.json(`/api/channels/${channel.id}/stop`, { method: "POST", user: "dj" });
    stage.close();
    studio.close();
  });
});
