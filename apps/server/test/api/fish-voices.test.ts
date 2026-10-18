import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ChannelDto } from "@tik-live/shared";
import { TtsError, type TtsProvider } from "../../src/runtime/voice/tts";
import { FISH_VOICES } from "../../src/voices/fish-voices";
import { startTestServer, type TestServer } from "../harness";

const BIA = "4b0adc6775774eb48b92c7e99ac92a89";
const THEO = "b5e67744e9ae4c0784fac789ad7c580d";

/** A stand-in for OpenRouter's speech API. */
let openrouter: ReturnType<typeof Bun.serve>;
let server: TestServer;
const spoken: Array<{ voice: string; input: string }> = [];

beforeAll(async () => {
  openrouter = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      spoken.push((await req.json()) as { voice: string; input: string });
      return new Response(new Uint8Array(8_000), { headers: { "content-type": "audio/mpeg" } });
    },
  });
  server = await startTestServer({ env: { OPENROUTER_API_KEY: "sk-or-test", OPENROUTER_BASE_URL: `http://127.0.0.1:${openrouter.port}/api/v1` } });
});
afterAll(async () => {
  await server.close();
  openrouter.stop(true);
});

describe("voices API with Fish Audio", () => {
  it("lists the Fish voices and the default one", async () => {
    const res = await server.json("/api/voices", { user: "alice" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, providers: ["fish"], canChoose: true, defaultFishVoiceId: BIA, defaultPocketVoiceId: null });
    expect(res.body.voices.map((v: { id: string }) => v.id)).toEqual(FISH_VOICES.map((v) => v.id));
  });

  it("serves a sample per voice, synthesized once, and 404s voices not on the list", async () => {
    const first = await server.api(`/api/voices/fish/${THEO}/sample`, { user: "alice" });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("audio/mpeg");
    expect((await first.arrayBuffer()).byteLength).toBe(8_000);
    expect((await server.api(`/api/voices/fish/${THEO}/sample`, { user: "alice" })).status).toBe(200);
    expect(spoken.filter((s) => s.voice === THEO).length).toBe(1);
    expect((await server.api(`/api/voices/fish/${"0".repeat(32)}/sample`, { user: "alice" })).status).toBe(404);
    expect((await server.api(`/api/voices/fish/${"a".repeat(200)}/sample`, { user: "alice" })).status).toBe(404);
  });

  it("gives new hosts the Fish voice, and takes only listed voices", async () => {
    const created = await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "alice", json: { name: "Show" } });
    expect(created.status).toBe(201);
    expect(created.body.channel.voice).toEqual({ provider: "fish", voiceId: null });
    const path = `/api/channels/${created.body.channel.id}`;

    const chosen = await server.json<{ channel: ChannelDto }>(path, { method: "PATCH", user: "alice", json: { voice: { provider: "fish", voiceId: THEO } } });
    expect(chosen.status).toBe(200);
    expect(chosen.body.channel.voice).toEqual({ provider: "fish", voiceId: THEO });

    const refused = await server.json(path, { method: "PATCH", user: "alice", json: { voice: { provider: "fish", voiceId: "0".repeat(32) } } });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("voice_not_found");
  });
});

describe("a voice that fails while live", () => {
  let failing: TestServer;
  let calls = 0;
  const broken: TtsProvider = {
    name: "fish",
    async synthesize() {
      calls += 1;
      throw new TtsError("Fish TTS 402: Insufficient credits", "account");
    },
  };

  beforeAll(async () => {
    failing = await startTestServer({ tts: () => broken });
  });
  afterAll(async () => {
    await failing.close();
  });

  it("keeps the show going in captions and tells the owner once", async () => {
    const created = await failing.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", user: "bob", json: { name: "Show" } });
    const channel = created.body.channel;
    const studio = await failing.socket(`/ws/studio/${channel.id}`, "bob");
    await failing.json(`/api/channels/${channel.id}/start`, { method: "POST", user: "bob" });

    const notice = await studio.next<{ code: string; message: string }>((m) => m.t === "notice" && m.code === "voice_failed");
    expect(notice.message).toContain("legenda");
    await studio.next((m) => m.t === "transcript" && m.line.status === "spoken");

    // Later lines fail too, and air as captions without another notice.
    const source = failing.sources.get(channel.id)!;
    source.push({ kind: "chat", at: Date.now(), viewer: { id: "v1", handle: "maria", nickname: "Maria" }, text: "oi blip, tudo bem?" });
    await studio.next((m) => m.t === "transcript" && m.line.status === "spoken", 15_000);
    expect(calls).toBeGreaterThan(1);
    expect(studio.messages.filter((m) => m.t === "notice" && m.code === "voice_failed")).toEqual([]);
    studio.close();
  }, 20_000);
});
