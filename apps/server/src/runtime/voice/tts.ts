import { speechWords, type Emotion } from "@tik-live/shared";

export interface AudioClip {
  mime: string;
  data: Buffer;
  /** Best-effort duration estimate, used as a fallback when no stage reports playback. */
  durationMs: number;
  /** When each word of `speechWords(text)` starts, in ms, if the voice reports timing (captions follow it). */
  words?: number[];
}

/** What else the voice may use to sound natural. */
export interface SpeechContext {
  /** The sentence said just before this one in the same turn, for continuous intonation. */
  previousText?: string;
}

export interface TtsProvider {
  readonly name: string;
  /** Set when the voice speaks only one language (BCP 47); the host is told to speak it. */
  readonly language?: string;
  /** Returns audio for the text, or null for caption-only mode. */
  synthesize(text: string, emotion: Emotion, signal?: AbortSignal, context?: SpeechContext): Promise<AudioClip | null>;
}

/** Roughly how long it takes to say (or read) a line: ~15 characters per second. */
export function estimateSpeechMs(text: string): number {
  return Math.max(1_200, Math.round((text.length / 15) * 1000));
}

/** Caption-only mode: the stage shows text and the character "talks" without audio. */
export class NoTts implements TtsProvider {
  readonly name = "none";
  async synthesize(): Promise<AudioClip | null> {
    return null;
  }
}

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  model: string;
  fetch?: typeof fetch;
}

/** Per-emotion delivery tweaks. Lower stability = more expressive. */
const STYLE: Partial<Record<Emotion, { stability: number; style: number }>> = {
  excited: { stability: 0.3, style: 0.6 },
  laugh: { stability: 0.3, style: 0.7 },
  surprised: { stability: 0.35, style: 0.5 },
  sad: { stability: 0.6, style: 0.3 },
  thinking: { stability: 0.6, style: 0.2 },
};

const MP3_BITRATE_BPS = 128_000;

/** A counting semaphore: at most `limit` tasks run at once, the rest wait in order. */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(public limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  get pending(): number {
    return this.waiting.length;
  }
}

/** One limiter for every host in the process: ElevenLabs rate limits are per account (ADR-0012). */
export const elevenLabsLimiter = new Limiter(4);

export class ElevenLabsTts implements TtsProvider {
  readonly name = "elevenlabs";

  constructor(private readonly options: ElevenLabsOptions) {}

  synthesize(text: string, emotion: Emotion, signal?: AbortSignal, context?: SpeechContext): Promise<AudioClip> {
    return elevenLabsLimiter.run(() => this.request(text, emotion, signal, context));
  }

  /**
   * The `with-timestamps` endpoint returns the audio and when each character
   * is spoken, so captions highlight the word actually being said.
   */
  private async request(text: string, emotion: Emotion, signal?: AbortSignal, context?: SpeechContext): Promise<AudioClip> {
    signal?.throwIfAborted();
    const { apiKey, voiceId, model } = this.options;
    const style = STYLE[emotion] ?? { stability: 0.45, style: 0.35 };
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`;
    const response = await (this.options.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: style.stability, similarity_boost: 0.75, style: style.style },
        ...(context?.previousText ? { previous_text: context.previousText } : {}),
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`ElevenLabs ${response.status}: ${detail.slice(0, 200)}`);
    }
    const body = (await response.json()) as { audio_base64?: unknown; alignment?: Alignment | null };
    if (typeof body.audio_base64 !== "string") throw new Error("ElevenLabs returned no audio");
    const data = Buffer.from(body.audio_base64, "base64");
    const words = body.alignment ? wordStartsFromAlignment(text, body.alignment) : undefined;
    const spokenUntil = body.alignment?.character_end_times_seconds?.at(-1);
    const durationMs =
      typeof spokenUntil === "number" && spokenUntil > 0 ? Math.round(spokenUntil * 1000) : Math.round((data.length * 8 * 1000) / MP3_BITRATE_BPS);
    return { mime: "audio/mpeg", data, durationMs, ...(words ? { words } : {}) };
  }
}

/** ElevenLabs' per-character timing for the text it was given. */
export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/**
 * Start time (ms) of each word of `speechWords(text)` from character timing.
 * Returns undefined when the alignment doesn't line up with the text, and
 * the stage estimates timing from the text instead.
 */
export function wordStartsFromAlignment(text: string, alignment: Alignment): number[] | undefined {
  const { characters, character_start_times_seconds: starts } = alignment;
  if (!Array.isArray(characters) || !Array.isArray(starts) || characters.length !== starts.length) return undefined;
  if (characters.join("") !== text) return undefined;
  const words: number[] = [];
  let inWord = false;
  for (let i = 0; i < characters.length; i++) {
    const space = /\s/.test(characters[i] as string);
    if (!space && !inWord) {
      const at = starts[i];
      if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
      words.push(Math.round(at * 1000));
    }
    inWord = !space;
  }
  return words.length === speechWords(text).length ? words : undefined;
}

export interface PocketTtsOptions {
  /** The tts sidecar (services/tts), e.g. http://lantern-tts:8793. */
  url: string;
  secret: string;
  voice: string;
  fetch?: typeof fetch;
}

/** The sidecar batches requests itself; this only keeps one process from queueing past its 503. */
export const pocketLimiter = new Limiter(8);

const POCKET_TIMEOUT_MS = 20_000;

/**
 * Self-hosted Pocket TTS (services/tts, ADR-0021): Brazilian Portuguese on our
 * own CPUs, no per-character bill. WAV, not Ogg/Opus: every browser decodes it
 * and the stream re-encodes the audio anyway, so one lossy pass is enough.
 */
export class PocketTts implements TtsProvider {
  readonly name = "pocket";
  readonly language = "pt-BR";

  constructor(private readonly options: PocketTtsOptions) {}

  synthesize(text: string, _emotion: Emotion, signal?: AbortSignal): Promise<AudioClip> {
    return pocketLimiter.run(() => speakPocket(this.options, text, signal));
  }
}

/** One request to the sidecar. Also used for voice samples in the dashboard. */
export async function speakPocket(options: PocketTtsOptions, text: string, signal?: AbortSignal): Promise<AudioClip> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(POCKET_TIMEOUT_MS);
  const response = await (options.fetch ?? fetch)(`${options.url.replace(/\/+$/, "")}/v1/speak`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.secret}`, "content-type": "application/json", accept: "audio/wav" },
    body: JSON.stringify({ text, voice: options.voice, format: "wav" }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const code = await response
      .json()
      .then((body) => (body as { error?: unknown }).error)
      .catch(() => undefined);
    throw new Error(`Pocket TTS ${response.status}${typeof code === "string" ? ` ${code}` : ""}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  const seconds = Number(response.headers.get("x-tts-seconds"));
  // 24 kHz, 16-bit mono after a 44-byte header, if the header is ever missing.
  const durationMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : Math.round(((data.length - 44) / 48_000) * 1000);
  return { mime: "audio/wav", data, durationMs };
}
