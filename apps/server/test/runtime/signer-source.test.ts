import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ProtoMessageFetchResult, RouteConfig, TikTokLiveConnection } from "tiktok-live-connector";
import type { LiveEvent } from "@tik-live/shared";
import { createLogger } from "../../src/log";
import { HttpSignerClient } from "../../src/runtime/sources/signer-client";
import { useSigner } from "../../src/runtime/sources/signer-routes";
import { TikTokSource } from "../../src/runtime/sources/tiktok";

/**
 * The real tiktok-live-connector joining a room through our own signer
 * (ADR-0023). The signer and the room's websocket are local stand-ins; what's
 * under test is the seam: the signer's answers become a connection, with the
 * right cookies and parameters, and a connection that doesn't use the signer
 * is left alone.
 */

const TOKEN = "signer-token-0123456789abcdef";
const ROOM = "7000000000000000001";

let signer: ReturnType<typeof Bun.serve>;
let room: Bun.Server<Record<string, never>>;
let signerUrl: string;
let roomSockets: Array<{ url: URL; cookie: string | null }>;
let signerCalls: Array<{ path: string; auth: string | null; body: Record<string, unknown> }>;
let roomReply: { found: boolean; roomId: string | null; status: number | null; isLive: boolean };
let joinFailure: { status: number; code: string; message: string } | null;

const joinResult = () =>
  Buffer.from(
    ProtoMessageFetchResult.encode({
      messages: [],
      cursor: "cur1",
      fetchInterval: "1000",
      now: "1",
      internalExt: "ext1",
      fetchType: 1,
      routeParams: { foo: "bar", empty: "" },
      heartbeatDuration: "10000",
      needAck: false,
      pushServer: `ws://127.0.0.1:${room.port}/webcast/im/ws_proxy/ws_reuse_supp_ws/`,
      isFirst: true,
      historyCommentCursor: "",
      historyNoMore: true,
    }).finish(),
  ).toString("base64");

beforeAll(() => {
  room = Bun.serve<Record<string, never>>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      roomSockets.push({ url: new URL(req.url), cookie: req.headers.get("cookie") });
      if (server.upgrade(req, { data: {} })) return undefined;
      return new Response("expected a websocket", { status: 426 });
    },
    websocket: { message() {} },
  });
  signer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as Record<string, unknown>;
      signerCalls.push({ path, auth: req.headers.get("authorization"), body });
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: { code: "unauthorized", message: "Bad token." } }, { status: 401 });
      if (path === "/v1/room") return Response.json(roomReply);
      if (joinFailure) return Response.json({ error: { code: joinFailure.code, message: joinFailure.message } }, { status: joinFailure.status });
      return Response.json({ roomId: ROOM, cookies: ["s_v_web_id=abc; Path=/", "ttwid=jar-ttwid; Path=/"], body: joinResult() });
    },
  });
  signerUrl = `http://127.0.0.1:${signer.port}`;
});
afterAll(() => {
  signer.stop(true);
  room.stop(true);
});
beforeEach(() => {
  roomSockets = [];
  signerCalls = [];
  roomReply = { found: true, roomId: ROOM, status: 2, isLive: true };
  joinFailure = null;
});

async function until(check: () => boolean, ms = 6_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the source");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function source(overrides: { offlineRetryMs?: number } = {}) {
  const events: LiveEvent[] = [];
  const instance = new TikTokSource({
    username: "maria.test",
    signer: new HttpSignerClient(signerUrl, TOKEN),
    log: createLogger("test"),
    offlineRetryMs: overrides.offlineRetryMs ?? 60_000,
  });
  return { instance, events, start: () => instance.start((event) => events.push(event)) };
}

describe("TikTokSource with our own signer", () => {
  it("looks the room up, joins it through the signer and opens the websocket with the signer's cookies", async () => {
    const { instance, start } = source();
    await start();
    await until(() => instance.status().connected);

    expect(signerCalls.map((c) => c.path)).toEqual(["/v1/room", "/v1/webcast-fetch"]);
    expect(signerCalls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(signerCalls[0]?.body).toEqual({ uniqueId: "maria.test" });
    expect(signerCalls[1]?.body).toEqual({ roomId: ROOM, cursor: "" });

    expect(roomSockets).toHaveLength(1);
    const socket = roomSockets[0]!;
    expect(socket.url.pathname).toBe("/webcast/im/ws_proxy/ws_reuse_supp_ws/");
    expect(Object.fromEntries(socket.url.searchParams)).toMatchObject({ room_id: ROOM, cursor: "cur1", internal_ext: "ext1", foo: "bar", compress: "gzip" });
    // Empty route parameters are dropped, not sent as blanks.
    expect(socket.url.searchParams.has("empty")).toBe(false);
    expect(socket.cookie).toContain("ttwid=jar-ttwid");
    expect(socket.cookie).toContain("s_v_web_id=abc");
    expect(instance.status()).toMatchObject({ connected: true, live: true, detail: `live in room ${ROOM}` });
    await instance.stop();
  });

  it("waits in standby, without joining anything, while the account isn't live, then joins when it goes live", async () => {
    roomReply = { found: true, roomId: ROOM, status: 4, isLive: false };
    const { instance, start } = source({ offlineRetryMs: 100 });
    await start();
    await until(() => signerCalls.length >= 2);
    expect(instance.status()).toMatchObject({ connected: false, live: false });
    expect(instance.status().detail).toContain("is offline");
    expect(signerCalls.every((c) => c.path === "/v1/room")).toBe(true);
    expect(roomSockets).toHaveLength(0);

    roomReply = { found: true, roomId: ROOM, status: 2, isLive: true };
    await until(() => instance.status().connected);
    expect(roomSockets).toHaveLength(1);
    await instance.stop();
  });

  it("says so when TikTok has no such account", async () => {
    roomReply = { found: false, roomId: null, status: null, isLive: false };
    const { instance, start } = source();
    await start();
    await until(() => instance.status().detail.startsWith("connect failed"));
    expect(instance.status().detail).toContain("no account called @maria.test");
    await instance.stop();
  });

  it("reports the signer's own explanation when a join fails, and keeps retrying", async () => {
    joinFailure = { status: 502, code: "empty_response", message: "TikTok returned nothing; try SIGNER_PROXY_URL." };
    const { instance, start } = source();
    await start();
    await until(() => instance.status().detail.startsWith("connect failed"));
    expect(instance.status().detail).toContain("SIGNER_PROXY_URL");
    expect(instance.status().detail).toContain("retrying in");
    expect(roomSockets).toHaveLength(0);
    await instance.stop();
  });

  it("explains an unreachable signer", async () => {
    const instance = new TikTokSource({
      username: "maria.test",
      signer: new HttpSignerClient("http://127.0.0.1:1", TOKEN),
      log: createLogger("test"),
    });
    await instance.start(() => undefined);
    await until(() => instance.status().detail.startsWith("connect failed"));
    expect(instance.status().detail).toContain("signer isn't reachable");
    await instance.stop();
  });
});

describe("the route override", () => {
  it("leaves connections that don't use the signer on the hosted sign server", async () => {
    const using = new TikTokLiveConnection("a_user", { fetchRoomInfoOnConnect: false });
    useSigner(using, new HttpSignerClient(signerUrl, TOKEN)); // installs the override

    const hosted = new TikTokLiveConnection("someone_else", {});
    const hostedCalls: unknown[][] = [];
    const apiClient = {
      rooms: {
        fetchWebcastURL: async (...args: unknown[]) => {
          hostedCalls.push(args);
          return { status: 500, data: new TextEncoder().encode("x").buffer, headers: {} };
        },
      },
    };
    await expect(
      RouteConfig.fetchSignedWebSocketFromProvider({ roomId: ROOM, apiClient: apiClient as never, webClient: hosted.webClient, useMobile: false, authenticateWs: false } as never),
    ).rejects.toThrow(/Unexpected sign server status 500/);
    expect(hostedCalls).toHaveLength(1);
    expect(signerCalls).toHaveLength(0);
  });

  it("refuses authenticated connections, which the signer doesn't serve", async () => {
    const connection = new TikTokLiveConnection("a_user", { fetchRoomInfoOnConnect: false });
    useSigner(connection, new HttpSignerClient(signerUrl, TOKEN));
    await expect(
      RouteConfig.fetchSignedWebSocketFromProvider({ roomId: ROOM, apiClient: {} as never, webClient: connection.webClient, useMobile: false, authenticateWs: true } as never),
    ).rejects.toThrow(/only supports anonymous/);
    expect(signerCalls).toHaveLength(0);
  });
});
