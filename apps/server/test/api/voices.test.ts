import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ChannelDto } from "@tik-live/shared";
import { ConfigError, loadConfig } from "../../src/config";
import { startTestServer, type TestServer } from "../harness";

let sidecar: ReturnType<typeof Bun.serve>;
let server: TestServer;
let speaks = 0;

beforeAll(async () => {
  sidecar = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/healthz") return Response.json({ ok: true, voices: ["rafael", "alba"] });
      speaks += 1;
      return new Response(new Uint8Array(1_000), { headers: { "content-type": "audio/wav", "x-tts-seconds": "2.000" } });
    },
  });
  server = await startTestServer({ env: { POCKET_TTS_URL: `http://127.0.0.1:${sidecar.port}`, POCKET_TTS_SECRET: "sidecar-secret-0123" } });
});
afterAll(async () => {
  await server.close();
  sidecar.stop(true);
});

describe("voices API with the self-hosted voice", () => {
  it("lists Pocket voices and its default", async () => {
    const res = await server.json("/api/voices", { user: "alice" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, providers: ["pocket"], defaultPocketVoiceId: "rafael" });
    expect(res.body.voices.map((v: { id: string }) => v.id)).toEqual(["alba", "rafael"]);
  });

  it("serves a sample per voice, synthesized once, and 404s unknown voices", async () => {
    const first = await server.api("/api/voices/pocket/alba/sample", { user: "alice" });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("audio/wav");
    expect((await first.arrayBuffer()).byteLength).toBe(1_000);
    expect((await server.api("/api/voices/pocket/alba/sample", { user: "alice" })).status).toBe(200);
    expect(speaks).toBe(1);
    expect((await server.api("/api/voices/pocket/nobody/sample", { user: "alice" })).status).toBe(404);
    expect((await server.api(`/api/voices/pocket/${"a".repeat(200)}/sample`, { user: "alice" })).status).toBe(404);
  });

  it("gives new channels the self-hosted voice when it's the only one", async () => {
    const res = await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "alice", json: { name: "Show" } });
    expect(res.status).toBe(201);
    expect(res.body.channel.voice).toEqual({ provider: "pocket", voiceId: null });
  });
});

describe("Pocket TTS config", () => {
  const base = { NODE_ENV: "test", DATABASE_URL: "pglite://memory" };
  it("is on only with both the URL and the secret", () => {
    expect(loadConfig({ ...base, POCKET_TTS_URL: "http://lantern-tts:8793" }).pocketEnabled).toBe(false);
    expect(loadConfig({ ...base, POCKET_TTS_URL: "http://lantern-tts:8793", POCKET_TTS_SECRET: "x".repeat(16) })).toMatchObject({ pocketEnabled: true, ttsEnabled: true });
    expect(() => loadConfig({ ...base, POCKET_TTS_SECRET: "x".repeat(16) })).toThrow(ConfigError);
  });
});
