import { beforeEach, describe, expect, test } from "bun:test";
import { createApi } from "../src/api";
import { SignerError } from "../src/backend";
import { FakeBackend } from "./fakes";

const TOKEN = "t".repeat(32);
let backend: FakeBackend;
let app: ReturnType<typeof createApi>;

const post = (path: string, body: unknown, token: string | null = TOKEN) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  backend = new FakeBackend();
  app = createApi(backend, TOKEN);
});

describe("signer API", () => {
  test("health is open and reports readiness", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ready: true });
  });

  test("every /v1 route needs the token", async () => {
    for (const [path, body] of [["/v1/webcast-fetch", { roomId: "7000000000000000001" }], ["/v1/room", { uniqueId: "someone" }]] as const) {
      expect((await post(path, body, null)).status).toBe(401);
      expect((await post(path, body, "wrong".repeat(8))).status).toBe(401);
      expect((await post(path, body, TOKEN.slice(0, -1))).status).toBe(401);
    }
    expect(backend.fetches).toHaveLength(0);
    expect(backend.lookups).toHaveLength(0);
  });

  test("webcast-fetch returns the protobuf as base64 with its cookies", async () => {
    const res = await post("/v1/webcast-fetch", { roomId: "7000000000000000001", cursor: "c1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ roomId: "7000000000000000001", cookies: ["ttwid=abc; Path=/"], body: "AQID" });
    expect(backend.fetches).toEqual([{ roomId: "7000000000000000001", cursor: "c1" }]);
  });

  test("the cursor defaults to empty", async () => {
    await post("/v1/webcast-fetch", { roomId: "7000000000000000001" });
    expect(backend.fetches[0]?.cursor).toBe("");
  });

  test("room lookups pass the handle through", async () => {
    const res = await post("/v1/room", { uniqueId: "maria.demedeiros" });
    expect(await res.json()).toEqual({ found: true, roomId: "7000000000000000001", status: 2, isLive: true });
    expect(backend.lookups).toEqual(["maria.demedeiros"]);
  });

  test("bad input is rejected before it reaches the browser", async () => {
    for (const body of [{}, { roomId: "abc" }, { roomId: "1" }, { roomId: "7000000000000000001", cursor: "x".repeat(513) }, null]) {
      const res = await post("/v1/webcast-fetch", body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_input");
    }
    for (const body of [{}, { uniqueId: "" }, { uniqueId: "../etc/passwd" }, { uniqueId: "a b" }, { uniqueId: "x".repeat(65) }]) {
      expect((await post("/v1/room", body)).status).toBe(400);
    }
    expect(backend.fetches).toHaveLength(0);
    expect(backend.lookups).toHaveLength(0);
  });

  test("backend errors keep their code, status and message", async () => {
    backend.nextFetch = new SignerError(502, "empty_response", "TikTok returned nothing.");
    const res = await post("/v1/webcast-fetch", { roomId: "7000000000000000001" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "empty_response", message: "TikTok returned nothing." } });
  });

  test("busy answers carry Retry-After", async () => {
    backend.nextRoom = new SignerError(429, "busy", "Slow down.");
    const res = await post("/v1/room", { uniqueId: "someone" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3");
  });

  test("unexpected errors don't leak their message", async () => {
    backend.nextRoom = new Error("secret internal detail");
    const res = await post("/v1/room", { uniqueId: "someone" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret internal detail");
  });
});
