import type { Plan, VoiceSettings } from "@tik-live/shared";
import type { AppConfig } from "../../config";
import { FishTts } from "./fish";
import { ElevenLabsTts, NoTts, PocketTts, type TtsProvider } from "./tts";

/**
 * The provider a host's voice settings use on this server. A provider the
 * server doesn't have (a key removed since the host was set up) falls back to
 * the server's default, the way the dashboard shows it.
 */
export function effectiveProvider(voice: VoiceSettings, config: AppConfig): VoiceSettings["provider"] {
  if (voice.provider === "none" || config.voiceProviders.includes(voice.provider)) return voice.provider;
  return config.voiceProviders[0] ?? "none";
}

/** The voice a host speaks with. Plans without voice choice get each provider's default voice. */
export function chooseTts(voice: VoiceSettings, plan: Plan, config: AppConfig): TtsProvider {
  const provider = effectiveProvider(voice, config);
  // A voice chosen for another provider means nothing here.
  const chosen = plan.limits.voices === "curated" && provider === voice.provider ? voice.voiceId : null;
  switch (provider) {
    case "fish": {
      // Only voices on this server's list: a stale or hand-made id gets the default voice.
      const id = chosen && config.fishVoices.some((v) => v.id === chosen) ? chosen : config.FISH_TTS_VOICE;
      return new FishTts({ apiKey: config.OPENROUTER_API_KEY!, baseUrl: config.OPENROUTER_BASE_URL, model: config.FISH_TTS_MODEL, voice: id });
    }
    case "pocket":
      return new PocketTts({ url: config.POCKET_TTS_URL!, secret: config.POCKET_TTS_SECRET!, voice: chosen ?? config.POCKET_TTS_VOICE });
    case "elevenlabs": {
      const voiceId = chosen ?? config.DEFAULT_VOICE_ID;
      if (!voiceId) return new NoTts();
      return new ElevenLabsTts({ apiKey: config.ELEVENLABS_API_KEY!, voiceId, model: config.ELEVENLABS_MODEL });
    }
    case "none":
      return new NoTts();
  }
}
