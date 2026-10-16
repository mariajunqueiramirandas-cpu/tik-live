import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ChannelDto } from "@tik-live/shared";
import { startTestServer, stageKeyFrom, type TestServer } from "../harness";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.close();
});

async function createChannel(user: string, body: Record<string, unknown> = { name: "My host" }) {
  const res = await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user, json: body });
  expect(res.status).toBe(201);
  return res.body.channel;
}

describe("channels API", () => {
  it("serves public config without identity", async () => {
    const res = await server.json("/api/config");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ productName: "Lantern", authMode: "dev", billing: { enabled: false } });
  });

  it("provisions the dev user just in time", async () => {
    const res = await server.json("/api/me", { user: "alice" });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("alice@localhost");
    expect(res.body.plan.id).toBe("self-hosted");
    expect(res.body.devUser).toBe("alice");
  });

  it("creates a channel from a preset with a working stage link", async () => {
    const channel = await createChannel("alice", { name: "Night show", presetId: "nova", tiktokUsername: "@night.owl" });
    expect(channel.persona.name).toBe("Nova");
    expect(channel.tiktokUsername).toBe("night.owl");
    expect(channel.source).toBe("tiktok");
    expect(channel.runtime.status).toBe("stopped");
    expect(channel.stageUrl).toMatch(/^http:\/\/localhost:9999\/s\/[A-Za-z0-9_-]{22}$/);
    expect(channel.broadcast).toEqual({ enabled: false, rtmpUrl: null, hasStreamKey: false, streamKeyLast4: null });
  });

  it("validates input with a clear message", async () => {
    const res = await server.json("/api/channels", { method: "POST", user: "alice", json: { name: "", tiktokUsername: "not a handle!" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_input");
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it("updates persona, safety and voice, and rejects a TikTok source without a handle", async () => {
    const channel = await createChannel("alice");
    const persona = { ...channel.persona, name: "Pixel", catchphrases: ["Pew pew!"] };
    const updated = await server.json<{ channel: ChannelDto }>(`/api/channels/${channel.id}`, {
      method: "PATCH",
      user: "alice",
      json: { persona, safety: { blocklist: ["Spoilers"], strictness: "strict", avoidTopics: ["exams"] } },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.channel.persona.name).toBe("Pixel");
    expect(updated.body.channel.safety).toEqual({ blocklist: ["spoilers"], strictness: "strict", avoidTopics: ["exams"] });

    const bad = await server.json(`/api/channels/${channel.id}`, { method: "PATCH", user: "alice", json: { source: "tiktok" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("tiktok_handle_required");
  });

  it("rotates the stage key and invalidates the old link", async () => {
    const channel = await createChannel("alice");
    const oldKey = stageKeyFrom(channel.stageUrl);
    const rotated = await server.json<{ channel: ChannelDto }>(`/api/channels/${channel.id}/stage-key`, { method: "POST", user: "alice" });
    const newKey = stageKeyFrom(rotated.body.channel.stageUrl);
    expect(newKey).not.toBe(oldKey);
    expect((await server.api(`/ws/stage/${oldKey}`)).status).toBe(404);
  });

  it("stores the stream key write-only and encrypted", async () => {
    const channel = await createChannel("alice");
    const res = await server.json<{ channel: ChannelDto }>(`/api/channels/${channel.id}/broadcast`, {
      method: "PUT",
      user: "alice",
      json: { rtmpUrl: "rtmps://push.example.com/live", streamKey: "live_123456789_SECRET" },
    });
    expect(res.status).toBe(200);
    expect(res.body.channel.broadcast).toEqual({ enabled: false, rtmpUrl: "rtmps://push.example.com/live", hasStreamKey: true, streamKeyLast4: "CRET" });
    expect(JSON.stringify(res.body)).not.toContain("live_123456789_SECRET");
    const row = await server.deps.db.query.channel.findFirst({ where: (t, { eq }) => eq(t.id, channel.id) });
    expect(row?.broadcast.streamKeyCiphertext).toMatch(/^v1\./);
    expect(row?.broadcast.streamKeyCiphertext).not.toContain("SECRET");

    const enable = await server.json(`/api/channels/${channel.id}/broadcast`, { method: "PUT", user: "alice", json: { enabled: true } });
    expect(enable.status).toBe(409);
    expect(enable.body.error.code).toBe("broadcast_disabled");
  });

  it("deletes a channel", async () => {
    const channel = await createChannel("alice");
    expect((await server.api(`/api/channels/${channel.id}`, { method: "DELETE", user: "alice" })).status).toBe(204);
    expect((await server.api(`/api/channels/${channel.id}`, { user: "alice" })).status).toBe(404);
  });
});

describe("tenancy (ADR-0016)", () => {
  it("never lets one user see or control another user's channel", async () => {
    const mine = await createChannel("owner");
    const paths: Array<[string, string, unknown?]> = [
      ["GET", `/api/channels/${mine.id}`],
      ["PATCH", `/api/channels/${mine.id}`, { name: "hijacked" }],
      ["DELETE", `/api/channels/${mine.id}`],
      ["POST", `/api/channels/${mine.id}/start`],
      ["POST", `/api/channels/${mine.id}/stop`],
      ["POST", `/api/channels/${mine.id}/stage-key`],
      ["PUT", `/api/channels/${mine.id}/broadcast`, { rtmpUrl: "rtmp://x.example.com/a" }],
      ["GET", `/api/channels/${mine.id}/sessions`],
      ["GET", `/api/channels/${mine.id}/audience`],
    ];
    for (const [method, path, json] of paths) {
      const res = await server.api(path, { method, user: "intruder", ...(json ? { json } : {}) });
      expect(`${method} ${path} -> ${res.status}`).toBe(`${method} ${path} -> 404`);
    }
    const list = await server.json("/api/channels", { user: "intruder" });
    expect(list.body.channels).toEqual([]);
    expect((await server.api(`/ws/studio/${mine.id}?devUser=intruder`)).status).toBe(404);

    const still = await server.json(`/api/channels/${mine.id}`, { user: "owner" });
    expect(still.body.channel.name).toBe("My host");
  });

  it("treats malformed ids as not found", async () => {
    expect((await server.api("/api/channels/not-a-uuid", { user: "owner" })).status).toBe(404);
  });
});

describe("request protection", () => {
  it("blocks cross-site writes and sets security headers", async () => {
    const res = await server.api("/api/channels", {
      method: "POST",
      user: "alice",
      json: { name: "x" },
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
    const ok = await server.api("/api/config");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("answers unknown API routes with the problem shape", async () => {
    const res = await server.json("/api/nope", { user: "alice" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});
