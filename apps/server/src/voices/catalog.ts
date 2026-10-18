import type { VoiceSettings } from "@tik-live/shared";
import type { Logger } from "../log";
import { fishInput, fishLimiter, speakFish } from "../runtime/voice/fish";
import { speakPocket, type AudioClip } from "../runtime/voice/tts";
import type { FishVoice } from "./fish-voices";

export type VoiceProvider = Exclude<VoiceSettings["provider"], "none">;

export interface VoiceOption {
  id: string;
  provider: VoiceProvider;
  name: string;
  previewUrl: string | null;
  description: string | null;
  tags: string[];
}

export interface PocketCatalogOptions {
  url: string;
  secret: string;
}

export interface FishCatalogOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  voices: FishVoice[];
}

const CACHE_MS = 60 * 60 * 1000;
const SAMPLE_TEXT = "Oi, pessoal! Bem-vindos à live. Hoje eu comando o show, então manda um oi no chat!";

/**
 * The voices creators can pick from: the server's Fish Audio voices (a list
 * in configuration, ADR-0030), the ElevenLabs voices available to the
 * platform's account and the voices the Pocket TTS sidecar ships, the last
 * two fetched live (so voice ids never go stale) and cached. Fish comes first:
 * it is the default for new hosts.
 */
export class VoiceCatalog {
  private cache: { at: number; voices: VoiceOption[] } | null = null;
  private inflight: Promise<VoiceOption[]> | null = null;
  private pocketCache: { at: number; voices: VoiceOption[] } | null = null;
  private pocketInflight: Promise<VoiceOption[]> | null = null;
  private readonly samples = new Map<string, Promise<AudioClip>>();

  constructor(
    private readonly apiKey: string | undefined,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly pocket: PocketCatalogOptions | null = null,
    private readonly fish: FishCatalogOptions | null = null,
  ) {}

  get enabled(): boolean {
    return this.providers.length > 0;
  }

  get providers(): VoiceProvider[] {
    return [
      ...(this.fish ? (["fish"] as const) : []),
      ...(this.apiKey ? (["elevenlabs"] as const) : []),
      ...(this.pocket ? (["pocket"] as const) : []),
    ];
  }

  async list(): Promise<VoiceOption[]> {
    const [eleven, pocket] = await Promise.all([this.listElevenLabs(), this.listPocket()]);
    return [...this.listFish(), ...eleven, ...pocket];
  }

  /** Whether hosts on this server may use a Fish voice: only the configured ones. */
  hasFishVoice(id: string): boolean {
    return this.fish?.voices.some((voice) => voice.id === id) ?? false;
  }

  /** A short spoken sample of a Fish voice, synthesized once per voice; null for a voice not on the list. */
  async fishSample(voice: string): Promise<AudioClip | null> {
    const fish = this.fish;
    if (!fish || !this.hasFishVoice(voice)) return null;
    return this.sample(`fish:${voice}`, () =>
      fishLimiter.run(() => speakFish({ ...fish, voice, fetch: this.fetchImpl }, fishInput(SAMPLE_TEXT, "happy") as string)),
    );
  }

  /** A short spoken sample of a Pocket voice, synthesized once per voice; null for an unknown voice. */
  async pocketSample(voice: string): Promise<AudioClip | null> {
    const pocket = this.pocket;
    if (!pocket || !(await this.listPocket()).some((v) => v.id === voice)) return null;
    return this.sample(`pocket:${voice}`, () => speakPocket({ ...pocket, voice, fetch: this.fetchImpl }, SAMPLE_TEXT));
  }

  /** Synthesizes a sample once; a failed one is tried again next time. */
  private sample(key: string, speak: () => Promise<AudioClip>): Promise<AudioClip> {
    let sample = this.samples.get(key);
    if (!sample) {
      sample = speak();
      this.samples.set(key, sample);
      sample.catch(() => this.samples.delete(key));
    }
    return sample;
  }

  private listFish(): VoiceOption[] {
    return (this.fish?.voices ?? []).map((voice) => ({
      id: voice.id,
      provider: "fish" as const,
      name: voice.name,
      previewUrl: `/api/voices/fish/${voice.id}/sample`,
      description: voice.description,
      tags: voice.tags,
    }));
  }

  private listElevenLabs(): Promise<VoiceOption[]> {
    if (!this.apiKey) return Promise.resolve([]);
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return Promise.resolve(this.cache.voices);
    this.inflight ??= this.fetchElevenLabs().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private listPocket(): Promise<VoiceOption[]> {
    if (!this.pocket) return Promise.resolve([]);
    if (this.pocketCache && Date.now() - this.pocketCache.at < CACHE_MS) return Promise.resolve(this.pocketCache.voices);
    this.pocketInflight ??= this.fetchPocket().finally(() => {
      this.pocketInflight = null;
    });
    return this.pocketInflight;
  }

  private async fetchElevenLabs(): Promise<VoiceOption[]> {
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
          provider: "elevenlabs" as const,
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

  private async fetchPocket(): Promise<VoiceOption[]> {
    const pocket = this.pocket as PocketCatalogOptions;
    try {
      const response = await this.fetchImpl(`${pocket.url.replace(/\/+$/, "")}/healthz`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`Pocket TTS ${response.status}`);
      const body = (await response.json()) as { voices?: unknown };
      const ids = Array.isArray(body.voices) ? body.voices.filter((v): v is string => typeof v === "string" && /^[a-z0-9_-]{1,64}$/i.test(v)) : [];
      const voices = ids
        .map((id) => ({
          id,
          provider: "pocket" as const,
          name: id.charAt(0).toUpperCase() + id.slice(1),
          previewUrl: `/api/voices/pocket/${encodeURIComponent(id)}/sample`,
          // Kyutai's Portuguese release: rafael is the one native speaker (services/tts/README.md).
          description: id === "rafael" ? "Falante nativo de português do Brasil" : "Fala português do Brasil com sotaque estrangeiro",
          tags: id === "rafael" ? ["Portuguese", "native"] : ["Portuguese"],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      // A warming sidecar answers 503: don't cache an empty list for an hour.
      if (voices.length > 0) this.pocketCache = { at: Date.now(), voices };
      return voices;
    } catch (err) {
      this.log.warn("could not load voices from Pocket TTS", err);
      return this.pocketCache?.voices ?? [];
    }
  }
}
