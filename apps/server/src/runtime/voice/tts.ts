import type { Emotion } from "@tik-live/shared";

export interface AudioClip {
  mime: string;
  data: Buffer;
  /** Best-effort duration estimate, used as a fallback when no stage reports playback. */
  durationMs: number;
}

export interface TtsProvider {
  readonly name: string;
  /** Returns audio for the text, or null for caption-only mode. */
  synthesize(text: string, emotion: Emotion, signal?: AbortSignal): Promise<AudioClip | null>;
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

  synthesize(text: string, emotion: Emotion, signal?: AbortSignal): Promise<AudioClip> {
    return elevenLabsLimiter.run(() => this.request(text, emotion, signal));
  }

  private async request(text: string, emotion: Emotion, signal?: AbortSignal): Promise<AudioClip> {
    signal?.throwIfAborted();
    const { apiKey, voiceId, model } = this.options;
    const style = STYLE[emotion] ?? { stability: 0.45, style: 0.35 };
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: style.stability, similarity_boost: 0.75, style: style.style },
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`ElevenLabs ${response.status}: ${detail.slice(0, 200)}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    return { mime: "audio/mpeg", data, durationMs: Math.round((data.length * 8 * 1000) / MP3_BITRATE_BPS) };
  }
}
