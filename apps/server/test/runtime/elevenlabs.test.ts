import { describe, expect, it } from "bun:test";
import { ElevenLabsTts, wordStartsFromAlignment } from "../../src/runtime/voice/tts";

describe("ElevenLabs word timings", () => {
  const align = (text: string, step = 0.1) => ({
    characters: [...text],
    character_start_times_seconds: [...text].map((_, i) => i * step),
    character_end_times_seconds: [...text].map((_, i) => (i + 1) * step),
  });

  it("turns character timing into word start times", () => {
    expect(wordStartsFromAlignment("Hi  there, Joe!", align("Hi  there, Joe!"))).toEqual([0, 400, 1100]);
    // Alignment that doesn't match the text falls back to the stage's estimate.
    expect(wordStartsFromAlignment("Hi there", align("Hi there!"))).toBeUndefined();
  });

  it("asks for timestamps, passes the previous sentence, and reads the real duration", async () => {
    let body: Record<string, unknown> = {};
    let url = "";
    const fakeFetch = (async (input: string, init: RequestInit) => {
      url = input;
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ audio_base64: Buffer.from("mp3!").toString("base64"), alignment: align("Thanks, Maria!", 0.05) });
    }) as unknown as typeof fetch;
    const tts = new ElevenLabsTts({ apiKey: "k", voiceId: "v1", model: "m", fetch: fakeFetch });
    const clip = await tts.synthesize("Thanks, Maria!", "happy", undefined, { previousText: "Oh wow." });
    expect(url).toContain("/v1/text-to-speech/v1/with-timestamps");
    expect(body).toMatchObject({ text: "Thanks, Maria!", previous_text: "Oh wow." });
    expect(clip.data.toString()).toBe("mp3!");
    expect(clip.words).toEqual([0, 400]);
    expect(clip.durationMs).toBe(700);
  });
});
