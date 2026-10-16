import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createLogger } from "../../src/log";
import { PocketTts } from "../../src/runtime/voice/tts";
import { VoiceCatalog } from "../../src/voices/catalog";

/** A stand-in for services/tts: same routes, statuses and headers. */
let sidecar: ReturnType<typeof Bun.serve>;
let url: string;
const requests: Array<{ auth: string | null; body: unknown }> = [];
let healthy = true;

beforeAll(() => {
  sidecar = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/healthz") {
        return healthy ? Response.json({ ok: true, voices: ["rafael", "alba", "../etc"] }) : Response.json({ error: "warming_up" }, { status: 503 });
      }
      const body = (await req.json()) as { text: string; voice: string };
      requests.push({ auth: req.headers.get("authorization"), body });
      if (req.headers.get("authorization") !== "Bearer sidecar-secret-0123") return Response.json({ error: "unauthorized" }, { status: 401 });
      if (body.voice === "nobody") return Response.json({ error: "unknown_voice" }, { status: 400 });
      return new Response(new Uint8Array(44 + 48_000), { headers: { "content-type": "audio/wav", "x-tts-seconds": "1.250" } });
    },
  });
  url = `http://127.0.0.1:${sidecar.port}`;
});
afterAll(() => sidecar.stop(true));

describe("PocketTts", () => {
  it("asks the sidecar for WAV in the channel's voice and reads its length from x-tts-seconds", async () => {
    const tts = new PocketTts({ url, secret: "sidecar-secret-0123", voice: "rafael" });
    expect(tts.language).toBe("pt-BR");
    const clip = await tts.synthesize("Oi, pessoal!", "excited");
    expect(clip).toMatchObject({ mime: "audio/wav", durationMs: 1250 });
    expect(requests.at(-1)).toEqual({ auth: "Bearer sidecar-secret-0123", body: { text: "Oi, pessoal!", voice: "rafael", format: "wav" } });
  });

  it("surfaces the sidecar's error code", async () => {
    await expect(new PocketTts({ url, secret: "sidecar-secret-0123", voice: "nobody" }).synthesize("Oi", "neutral")).rejects.toThrow("Pocket TTS 400 unknown_voice");
    await expect(new PocketTts({ url, secret: "wrong-secret-000000", voice: "rafael" }).synthesize("Oi", "neutral")).rejects.toThrow("Pocket TTS 401 unauthorized");
  });
});

describe("VoiceCatalog with Pocket TTS", () => {
  it("lists the sidecar's voices, skipping malformed names, and samples only known ones", async () => {
    const catalog = new VoiceCatalog(undefined, createLogger("test"), fetch, { url, secret: "sidecar-secret-0123" });
    expect(catalog.providers).toEqual(["pocket"]);
    const voices = await catalog.list();
    expect(voices.map((v) => v.id)).toEqual(["alba", "rafael"]);
    expect(voices.find((v) => v.id === "rafael")).toMatchObject({ provider: "pocket", name: "Rafael", previewUrl: "/api/voices/pocket/rafael/sample" });
    const before = requests.length;
    expect(await catalog.pocketSample("nobody")).toBeNull();
    const sample = await catalog.pocketSample("alba");
    await catalog.pocketSample("alba");
    expect(sample?.mime).toBe("audio/wav");
    expect(requests.length).toBe(before + 1);
  });

  it("doesn't cache an empty list while the sidecar warms up", async () => {
    const catalog = new VoiceCatalog(undefined, createLogger("test"), fetch, { url, secret: "sidecar-secret-0123" });
    healthy = false;
    expect(await catalog.list()).toEqual([]);
    healthy = true;
    expect((await catalog.list()).length).toBe(2);
  });
});
