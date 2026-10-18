import { describe, expect, it } from "bun:test";
import { PLANS, type VoiceSettings } from "@tik-live/shared";
import { ConfigError, testConfig } from "../../src/config";
import { chooseTts, effectiveProvider } from "../../src/runtime/voice/choose";
import { FishTts } from "../../src/runtime/voice/fish";
import { ElevenLabsTts, NoTts, PocketTts } from "../../src/runtime/voice/tts";
import { FISH_VOICES, parseFishVoices } from "../../src/voices/fish-voices";

const BIA = "4b0adc6775774eb48b92c7e99ac92a89";
const THEO = "b5e67744e9ae4c0784fac789ad7c580d";
const fish = { OPENROUTER_API_KEY: "sk-or-test" };
const pocket = { POCKET_TTS_URL: "http://lantern-tts:8793", POCKET_TTS_SECRET: "x".repeat(16) };
const voice = (provider: VoiceSettings["provider"], voiceId: string | null = null): VoiceSettings => ({ provider, voiceId });

describe("chooseTts", () => {
  it("speaks with the chosen Fish voice on plans with voice choice", () => {
    const tts = chooseTts(voice("fish", THEO), PLANS.creator, testConfig(fish));
    expect(tts).toBeInstanceOf(FishTts);
    expect((tts as FishTts).voice).toBe(THEO);
  });

  it("uses the default Fish voice without a choice, on plans without choice, and for ids not on the list", () => {
    const config = testConfig(fish);
    expect((chooseTts(voice("fish"), PLANS.creator, config) as FishTts).voice).toBe(BIA);
    expect((chooseTts(voice("fish", THEO), PLANS.free, config) as FishTts).voice).toBe(BIA);
    expect((chooseTts(voice("fish", "0".repeat(32)), PLANS.pro, config) as FishTts).voice).toBe(BIA);
  });

  it("falls back to the server's default provider when the host's is gone, as the dashboard shows it", () => {
    const config = testConfig({ ...fish, ...pocket });
    expect(effectiveProvider(voice("elevenlabs", "some-eleven-voice"), config)).toBe("fish");
    // The ElevenLabs voice id means nothing to Fish: the default voice it is.
    expect((chooseTts(voice("elevenlabs", "some-eleven-voice"), PLANS.pro, config) as FishTts).voice).toBe(BIA);
    expect(chooseTts(voice("pocket"), PLANS.pro, config)).toBeInstanceOf(PocketTts);
    expect(effectiveProvider(voice("fish"), testConfig(pocket))).toBe("pocket");
    expect(chooseTts(voice("fish"), PLANS.pro, testConfig())).toBeInstanceOf(NoTts);
  });

  it("keeps captions-only hosts silent and ElevenLabs as before", () => {
    expect(chooseTts(voice("none"), PLANS.pro, testConfig(fish))).toBeInstanceOf(NoTts);
    expect(chooseTts(voice("elevenlabs"), PLANS.pro, testConfig({ ELEVENLABS_API_KEY: "k" }))).toBeInstanceOf(NoTts);
    expect(chooseTts(voice("elevenlabs", "v1"), PLANS.pro, testConfig({ ELEVENLABS_API_KEY: "k" }))).toBeInstanceOf(ElevenLabsTts);
  });
});

describe("Fish voice config", () => {
  it("is on with an OpenRouter key, and first among the providers", () => {
    expect(testConfig()).toMatchObject({ fishEnabled: false, ttsEnabled: false, voiceProviders: [] });
    expect(testConfig({ ...fish, ...pocket, ELEVENLABS_API_KEY: "k" })).toMatchObject({
      fishEnabled: true,
      ttsEnabled: true,
      voiceProviders: ["fish", "elevenlabs", "pocket"],
      FISH_TTS_MODEL: "fish-audio/drama-3",
      FISH_TTS_VOICE: BIA,
      fishVoices: FISH_VOICES,
    });
  });

  it("takes a voice list of the operator's own, and its default must be on it", () => {
    const own = `${THEO}=Theo, ${"a".repeat(32)} = Voz da Casa`;
    expect(testConfig({ ...fish, FISH_TTS_VOICES: own, FISH_TTS_VOICE: "a".repeat(32) }).fishVoices).toEqual([
      { id: THEO, name: "Theo", description: null, tags: [] },
      { id: "a".repeat(32), name: "Voz da Casa", description: null, tags: [] },
    ]);
    expect(() => testConfig({ ...fish, FISH_TTS_VOICES: own })).toThrow(/FISH_TTS_VOICE 4b0adc.* isn't one of the voices/);
    expect(() => testConfig({ FISH_TTS_VOICE: "bia" })).toThrow(ConfigError);
  });

  it("explains a malformed voice list", () => {
    expect(parseFishVoices("bia=Bia")).toMatch(/isn't id=Name/);
    expect(parseFishVoices(`${THEO}=Theo,${THEO}=Theo again`)).toMatch(/listed twice/);
    expect(parseFishVoices(" , ")).toBe("lists no voices");
    expect(() => testConfig({ FISH_TTS_VOICES: "bia=Bia" })).toThrow(ConfigError);
  });

  it("ships voices with ids, names and descriptions, the default first", () => {
    expect(FISH_VOICES[0]?.id).toBe(BIA);
    expect(new Set(FISH_VOICES.map((v) => v.id)).size).toBe(FISH_VOICES.length);
    for (const v of FISH_VOICES) {
      expect(v.id).toMatch(/^[0-9a-f]{32}$/);
      expect(v.description?.length).toBeGreaterThan(10);
      expect(v.tags.length).toBe(3);
    }
  });
});
