import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createLogger } from "../../src/log";
import { FISH_DIRECTIONS, FishTts, fishInput, type FishTtsOptions } from "../../src/runtime/voice/fish";
import { TtsError, type TtsProvider } from "../../src/runtime/voice/tts";
import { FISH_VOICES } from "../../src/voices/fish-voices";
import { VoiceCatalog } from "../../src/voices/catalog";

const BIA = "4b0adc6775774eb48b92c7e99ac92a89";
/** One second of Drama 3's 128 kbps MP3. */
const MP3_SECOND = new Uint8Array(16_000);

/** A stand-in for OpenRouter's speech API: same route, shapes and statuses. Each test queues its answers. */
let openrouter: ReturnType<typeof Bun.serve>;
const requests: Array<{ path: string; auth: string | null; title: string | null; body: Record<string, unknown> }> = [];
let answers: Array<() => Response | Promise<Response>> = [];
const audio = () => new Response(MP3_SECOND, { headers: { "content-type": "audio/mpeg", "x-generation-id": "gen-tts-1" } });
const error = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ error: { code: status, message } }, { status, headers });

beforeAll(() => {
  openrouter = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        title: req.headers.get("x-title"),
        body: (await req.json()) as Record<string, unknown>,
      });
      return (answers.shift() ?? audio)();
    },
  });
});
afterAll(() => openrouter.stop(true));
beforeEach(() => {
  requests.length = 0;
  answers = [];
});

const options = (): FishTtsOptions => ({
  apiKey: "sk-or-test",
  baseUrl: `http://127.0.0.1:${openrouter.port}/api/v1/`,
  model: "fish-audio/drama-3",
  voice: BIA,
  retryDelayMs: 0,
});

describe("fishInput", () => {
  it("puts the emotion's direction before the line, in words", () => {
    expect(fishInput("Valeu pelo leão, Ju! 🦁", "excited")).toBe("[excited] Valeu pelo leão, Ju!");
    expect(fishInput("São 21h30.", "neutral")).toBe("São vinte e uma e trinta.");
  });

  it("has nothing to say for a line of emoji", () => {
    expect(fishInput("🔥🔥🔥", "happy")).toBeNull();
  });

  it("only ever sends its own directions", () => {
    expect(fishInput("[whisper] te amo", "neutral")).toBe("whisper te amo");
    expect(fishInput("<angry>sai daqui</angry>", "love")).toBe("[warm, affectionate] angry sai daqui angry");
  });

  it("directs every emotion with a short English phrase, or none", () => {
    for (const direction of Object.values(FISH_DIRECTIONS)) {
      if (direction !== null) expect(direction).toMatch(/^[a-z ,]{3,30}$/);
    }
  });
});

describe("FishTts", () => {
  it("asks OpenRouter for Drama 3 in the channel's voice and reads length and cost from the answer", async () => {
    const tts = new FishTts(options());
    expect(tts.voice).toBe(BIA);
    // Drama 3 speaks many languages; the host speaks Portuguese anyway (ADR-0027).
    expect((tts as TtsProvider).language).toBeUndefined();
    const clip = await tts.synthesize("Valeu demais, Juliana!", "excited");
    expect(clip).toMatchObject({ mime: "audio/mpeg", durationMs: 1000 });
    expect(clip?.data.length).toBe(16_000);
    const input = "[excited] Valeu demais, Juliana!";
    expect(clip?.costUsd).toBeCloseTo((Buffer.byteLength(input) * 2) / 1_000_000, 12);
    expect(requests).toEqual([
      {
        path: "/api/v1/audio/speech",
        auth: "Bearer sk-or-test",
        title: "Lantern",
        body: { model: "fish-audio/drama-3", input, voice: BIA, response_format: "mp3" },
      },
    ]);
  });

  it("captions a line with nothing to say without calling OpenRouter", async () => {
    expect(await new FishTts(options()).synthesize("👏👏", "happy")).toBeNull();
    expect(requests).toEqual([]);
  });

  it("retries once when OpenRouter or Fish is down, then gives up", async () => {
    answers = [() => error(502, "Provider returned 502")];
    expect(await new FishTts(options()).synthesize("Oi!", "neutral")).toMatchObject({ durationMs: 1000 });
    expect(requests.length).toBe(2);

    requests.length = 0;
    answers = [() => error(503, "busy"), () => error(502, "Provider returned 502")];
    const err = await new FishTts(options()).synthesize("Oi!", "neutral").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect(err).toMatchObject({ reason: "unavailable", message: "Fish TTS 502: Provider returned 502" });
    expect(requests.length).toBe(2);
  });

  it("waits out a short rate limit, but captions the line rather than wait long", async () => {
    answers = [() => error(429, "slow down", { "retry-after": "0" })];
    expect(await new FishTts(options()).synthesize("Oi!", "neutral")).not.toBeNull();
    expect(requests.length).toBe(2);

    requests.length = 0;
    answers = [() => error(429, "slow down", { "retry-after": "30" })];
    await expect(new FishTts(options()).synthesize("Oi!", "neutral")).rejects.toMatchObject({ reason: "busy" });
    expect(requests.length).toBe(1);
  });

  it("doesn't retry what retrying can't fix, and says whose problem it is", async () => {
    const cases: Array<[number, string]> = [
      [400, "rejected"],
      [401, "account"],
      [402, "account"],
      [403, "account"],
    ];
    for (const [status, reason] of cases) {
      requests.length = 0;
      answers = [() => error(status, `status ${status}`)];
      await expect(new FishTts(options()).synthesize("Oi!", "neutral")).rejects.toMatchObject({ reason, message: `Fish TTS ${status}: status ${status}` });
      expect(requests.length).toBe(1);
    }
  });

  it("treats a slow or empty answer as a failure", async () => {
    answers = [() => Bun.sleep(200).then(audio), () => Bun.sleep(200).then(audio)];
    await expect(new FishTts({ ...options(), timeoutMs: 30 }).synthesize("Oi!", "neutral")).rejects.toMatchObject({
      reason: "unavailable",
      message: "Fish TTS timed out",
    });
    expect(requests.length).toBe(2);

    answers = [() => Response.json({ ok: true }), () => new Response(new Uint8Array(0), { headers: { "content-type": "audio/mpeg" } })];
    await expect(new FishTts(options()).synthesize("Oi!", "neutral")).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("stops at once when the line is dropped", async () => {
    answers = [() => Bun.sleep(200).then(audio)];
    const abort = new AbortController();
    const pending = new FishTts(options()).synthesize("Oi!", "neutral", abort.signal);
    await Bun.sleep(20);
    abort.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TtsError);
    expect(requests.length).toBe(1);
  });
});

describe("VoiceCatalog with Fish voices", () => {
  const catalog = () =>
    new VoiceCatalog("eleven-key", createLogger("test"), (async () => new Response("down", { status: 503 })) as unknown as typeof fetch, null, {
      ...options(),
      voices: FISH_VOICES,
    });

  it("lists Fish first, as the default provider, with a sample per voice", async () => {
    const voices = catalog();
    expect(voices.providers).toEqual(["fish", "elevenlabs"]);
    const list = await voices.list();
    expect(list.map((v) => v.name)).toEqual(FISH_VOICES.map((v) => v.name));
    expect(list[0]).toMatchObject({
      id: BIA,
      provider: "fish",
      name: "Bia",
      previewUrl: `/api/voices/fish/${BIA}/sample`,
      tags: ["feminina", "animada", "mineira"],
    });
    expect(voices.hasFishVoice(BIA)).toBe(true);
    expect(voices.hasFishVoice("0".repeat(32))).toBe(false);
  });

  it("synthesizes each sample once, through OpenRouter, and only for listed voices", async () => {
    const voices = new VoiceCatalog(undefined, createLogger("test"), fetch, null, { ...options(), voices: FISH_VOICES });
    expect(await voices.fishSample("0".repeat(32))).toBeNull();
    answers = [() => error(502, "down"), () => error(502, "down")];
    await expect(voices.fishSample(BIA)).rejects.toBeInstanceOf(TtsError);
    const sample = await voices.fishSample(BIA);
    await voices.fishSample(BIA);
    expect(sample?.mime).toBe("audio/mpeg");
    expect(requests.length).toBe(3);
    expect(requests.at(-1)?.body).toMatchObject({ voice: BIA, input: expect.stringMatching(/^\[cheerful\] Oi, pessoal!/) });
  });
});
