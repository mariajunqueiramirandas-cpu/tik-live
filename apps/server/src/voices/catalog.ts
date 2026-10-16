import type { Logger } from "../log";

export interface VoiceOption {
  id: string;
  name: string;
  previewUrl: string | null;
  description: string | null;
  tags: string[];
}

const CACHE_MS = 60 * 60 * 1000;

/**
 * The voices creators can pick from: the ElevenLabs voices available to the
 * platform's account, fetched live (so voice ids never go stale) and cached.
 */
export class VoiceCatalog {
  private cache: { at: number; voices: VoiceOption[] } | null = null;
  private inflight: Promise<VoiceOption[]> | null = null;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  async list(): Promise<VoiceOption[]> {
    if (!this.apiKey) return [];
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.voices;
    this.inflight ??= this.fetchVoices().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchVoices(): Promise<VoiceOption[]> {
    try {
      const response = await this.fetchImpl("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": this.apiKey as string },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`ElevenLabs ${response.status}`);
      const body = (await response.json()) as {
        voices?: Array<{ voice_id: string; name: string; preview_url?: string | null; description?: string | null; labels?: Record<string, string> }>;
      };
      const voices = (body.voices ?? [])
        .map((v) => ({
          id: v.voice_id,
          name: v.name,
          previewUrl: v.preview_url ?? null,
          description: v.description ?? v.labels?.description ?? null,
          tags: Object.values(v.labels ?? {}).filter((tag) => typeof tag === "string" && tag.length < 30),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      this.cache = { at: Date.now(), voices };
      return voices;
    } catch (err) {
      this.log.warn("could not load voices from ElevenLabs", err);
      return this.cache?.voices ?? [];
    }
  }
}
