import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { decodeBridgeStamp, type BridgePairResponse, type ChannelDto } from "@tik-live/shared";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bridgePairing } from "../../src/db/schema";
import { eventually, startTestServer, type TestServer, type TestSocket } from "../harness";

const FAKE_EXE = new Uint8Array(200_000).map((_, i) => (i * 31) % 251);

describe("Local Bridge Agent pairing (ADR-0047)", () => {
  let server: TestServer;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "bridge-exe-"));
    writeFileSync(path.join(dir, "lantern-bridge.exe"), FAKE_EXE);
    server = await startTestServer({ env: { BRIDGE_EXE_PATH: path.join(dir, "lantern-bridge.exe") } });
  });
  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const newChannel = async (user: string) =>
    (await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user, json: { name: "Bridge Host" } })).body.channel;
  const pairingCode = async (user: string, channelId: string) =>
    (await server.json<{ code: string; expiresAt: string }>(`/api/channels/${channelId}/live-studio/pairing`, { method: "POST", user })).body;
  const pair = (code: string) => server.json<BridgePairResponse>("/api/bridge/pair", { method: "POST", json: { code, device: "PC-DA-SALA" } });
  const connect = (token: string) => server.socket("/ws/bridge", undefined, { authorization: `Bearer ${token}` });
  const devices = async (user: string, channelId: string) =>
    (await server.json<{ devices: Array<{ id: string; name: string; connected: boolean }> }>(`/api/channels/${channelId}/live-studio/devices`, { user })).body.devices;

  it("pairs with a one-time code, connects with the device token, and lists the PC", async () => {
    const channel = await newChannel("pairer");
    const { code, expiresAt } = await pairingCode("pairer", channel.id);
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    // People type it with a dash and in lower case.
    const paired = await pair(`${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`);
    expect(paired.status).toBe(200);
    expect(paired.body).toMatchObject({ channelId: channel.id, channelName: "Bridge Host" });
    expect(paired.body.token).toStartWith("lbt_");

    // The code is used up.
    expect((await pair(code)).status).toBe(400);

    const bridge = await connect(paired.body.token);
    expect((await bridge.next<{ channelName: string }>((m) => m.t === "hello")).channelName).toBe("Bridge Host");
    await eventually(async () => (await devices("pairer", channel.id))[0]?.connected === true);
    expect(await devices("pairer", channel.id)).toMatchObject([{ id: paired.body.deviceId, name: "PC-DA-SALA", connected: true }]);

    // A paired agent doesn't use the stage link, so rotating it leaves the agent connected.
    await server.json(`/api/channels/${channel.id}/stage-key`, { method: "POST", user: "pairer" });
    await Bun.sleep(100);
    expect(bridge.closed).toBeNull();

    // Removing the PC disconnects it and its token stops working.
    const removed = await server.api(`/api/channels/${channel.id}/live-studio/devices/${paired.body.deviceId}`, { method: "DELETE", user: "pairer" });
    expect(removed.status).toBe(204);
    await eventually(() => bridge.closed?.code === 4003);
    expect(await devices("pairer", channel.id)).toEqual([]);
    const again = await connect(paired.body.token);
    await eventually(() => again.closed?.code === 4003);
  });

  it("rejects wrong, malformed and expired codes, and unknown tokens", async () => {
    const channel = await newChannel("rejecter");
    expect((await pair("ABCD-2345")).status).toBe(400);
    expect((await pair("not a code")).status).toBe(400);

    const { code } = await pairingCode("rejecter", channel.id);
    await server.deps.db.update(bridgePairing).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await pair(code)).status).toBe(400);

    const stranger: TestSocket = await connect("lbt_nope");
    await eventually(() => stranger.closed?.code === 4003);
    const bare = await server.socket("/ws/bridge");
    await eventually(() => bare.closed?.code === 4003);
  });

  it("keeps the first connected PC when a second paired PC connects, so they don't kick each other off", async () => {
    const channel = await newChannel("twopcs");
    const first = (await pair((await pairingCode("twopcs", channel.id)).code)).body;
    const second = (await pair((await pairingCode("twopcs", channel.id)).code)).body;

    const a = await connect(first.token);
    await a.next((m) => m.t === "hello");
    const b = await connect(second.token);
    await eventually(() => b.closed?.code === 4009);
    expect(a.closed).toBeNull();

    // The same PC reconnecting replaces its own old socket.
    const a2 = await connect(first.token);
    await a2.next((m) => m.t === "hello");
    await eventually(() => a.closed?.code === 4000);

    // Once it leaves, the other PC gets in.
    a2.close();
    await eventually(async () => !(await devices("twopcs", channel.id)).some((d) => d.connected));
    const b2 = await connect(second.token);
    await b2.next((m) => m.t === "hello");
    b2.close();
  });

  it("only the owner can make codes or see and remove PCs", async () => {
    const channel = await newChannel("owner");
    expect((await server.api(`/api/channels/${channel.id}/live-studio/pairing`, { method: "POST", user: "intruder" })).status).toBe(404);
    expect((await server.api(`/api/channels/${channel.id}/live-studio/devices`, { user: "intruder" })).status).toBe(404);
    expect((await server.api(`/api/channels/${channel.id}/live-studio/bridge.exe`, { user: "intruder" })).status).toBe(404);
  });

  it("stamps each download with the app's address and a pairing code that works", async () => {
    const channel = await newChannel("downloader");
    const res = await server.api(`/api/channels/${channel.id}/live-studio/bridge.exe`, { user: "downloader" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("lantern-bridge.exe");
    const body = new Uint8Array(await res.arrayBuffer());
    // The executable itself is untouched; the stamp follows it.
    expect(body.subarray(0, FAKE_EXE.length)).toEqual(FAKE_EXE);
    const stamp = decodeBridgeStamp(body.subarray(body.length - 4096));
    expect(stamp?.server).toBe("http://localhost:9999");

    const paired = await pair(stamp!.code);
    expect(paired.status).toBe(200);
    expect(paired.body.channelId).toBe(channel.id);

    const config = await server.json<{ bridge: { download: boolean; bytes: number } }>("/api/config");
    expect(config.body.bridge).toEqual({ download: true, bytes: FAKE_EXE.length });
  });
});

describe("without a built agent", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ env: { BRIDGE_EXE_PATH: "/nonexistent/lantern-bridge.exe" } });
  });
  afterAll(() => server.close());

  it("says the download isn't available, and pairing by code still works", async () => {
    const channel = (await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "nobuild", json: { name: "No Build" } })).body.channel;
    const res = await server.json<{ error: { code: string } }>(`/api/channels/${channel.id}/live-studio/bridge.exe`, { user: "nobuild" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("bridge_exe_not_built");
    expect((await server.json<{ bridge: { download: boolean } }>("/api/config")).body.bridge.download).toBe(false);

    const { code } = (await server.json<{ code: string }>(`/api/channels/${channel.id}/live-studio/pairing`, { method: "POST", user: "nobuild" })).body;
    expect((await server.json("/api/bridge/pair", { method: "POST", json: { code } })).status).toBe(200);
  });
});
