import { estimateTtsCostUsd, PRODUCT_NAME, type Emotion } from "@tik-live/shared";
import { speakable } from "./speakable";
import { Limiter, TtsError, type AudioClip, type TtsProvider } from "./tts";

export interface FishTtsOptions {
  apiKey: string;
  /** OpenRouter's API root, e.g. https://openrouter.ai/api/v1. */
  baseUrl: string;
  /** e.g. fish-audio/drama-3. */
  model: string;
  /** A Fish Audio voice id. Always sent: without one, Drama 3 picks a different speaker for every line. */
  voice: string;
  fetch?: typeof fetch;
  /** Wait before the one retry; tests pass 0. */
  retryDelayMs?: number;
  /** Per attempt; tests shorten it. */
  timeoutMs?: number;
}

/** One limiter for every host in the process (ADR-0012); FISH_TTS_MAX_CONCURRENCY sets it. */
export const fishLimiter = new Limiter(8);

/** A line usually takes about a second, a voice's first line up to 3 s; past this, the line airs as captions. */
const ATTEMPT_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 400;
/** Waiting longer than this for a rate limit means the line would air too late: caption it instead. */
const MAX_RETRY_AFTER_MS = 2_000;
/** Drama 3 answers 44.1 kHz mono MP3 at a constant 128 kbps with no ID3 header, so the size gives the length exactly. */
const MP3_BITRATE_BPS = 128_000;

/**
 * How each emotion is acted. Drama 3 reads a direction in brackets before
 * the line; English directions were followed a little more often than
 * Portuguese ones (ADR-0028). Neutral lines get none.
 */
export const FISH_DIRECTIONS: Record<Emotion, string | null> = {
  neutral: null,
  happy: "cheerful",
  excited: "excited",
  laugh: "laughing",
  surprised: "surprised",
  thinking: "thoughtful",
  sad: "sad",
  love: "warm, affectionate",
  mischief: "playful, teasing",
  confused: "confused",
  shy: "shy, soft",
  sleepy: "sleepy",
  proud: "proud",
  pout: "sulking",
};

/** What Drama 3 reads for a line: its direction, then the line in words. Null when nothing is left to say. */
export function fishInput(text: string, emotion: Emotion): string | null {
  const words = speakable(text);
  if (!/\p{L}/u.test(words)) return null;
  const direction = FISH_DIRECTIONS[emotion];
  return direction ? `[${direction}] ${words}` : words;
}

/**
 * Fish Audio's Drama 3 through OpenRouter (ADR-0028): Brazilian voices that
 * act each line's emotion, billed per byte of text.
 */
export class FishTts implements TtsProvider {
  readonly name = "fish";

  constructor(private readonly options: FishTtsOptions) {}

  /** The Fish voice id this host speaks with. */
  get voice(): string {
    return this.options.voice;
  }

  async synthesize(text: string, emotion: Emotion, signal?: AbortSignal): Promise<AudioClip | null> {
    const input = fishInput(text, emotion);
    // Only emoji or symbols: the line airs as a caption.
    if (!input) return null;
    return fishLimiter.run(() => speakFish(this.options, input, signal));
  }
}

/** One line, retried once when OpenRouter is busy or unreachable. Also used for voice samples in the dashboard. */
export async function speakFish(options: FishTtsOptions, input: string, signal?: AbortSignal): Promise<AudioClip> {
  try {
    return await attempt(options, input, signal);
  } catch (err) {
    if (!(err instanceof TtsError) || !err.retryable || signal?.aborted) throw err;
    const wait = err.retryAfterMs ?? options.retryDelayMs ?? RETRY_DELAY_MS;
    if (wait > MAX_RETRY_AFTER_MS) throw err;
    await delay(wait, signal);
    return attempt(options, input, signal);
  }
}

async function attempt(options: FishTtsOptions, input: string, signal?: AbortSignal): Promise<AudioClip> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? ATTEMPT_TIMEOUT_MS);
  let response: Response;
  let data: Buffer;
  try {
    response = await (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/+$/, "")}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", "x-title": PRODUCT_NAME },
      body: JSON.stringify({ model: options.model, input, voice: options.voice, response_format: "mp3" }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw await failure(response);
    data = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (err instanceof TtsError || signal?.aborted) throw err;
    const why = timeout.aborted ? "timed out" : `unreachable (${err instanceof Error ? err.message : String(err)})`;
    throw new TtsError(`Fish TTS ${why}`, "unavailable", { retryable: true });
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("audio/") || data.length === 0) {
    throw new TtsError(`Fish TTS answered ${data.length} bytes of ${type || "unknown content"}`, "unavailable", { retryable: true });
  }
  return {
    mime: "audio/mpeg",
    data,
    durationMs: Math.round((data.length * 8 * 1000) / MP3_BITRATE_BPS),
    costUsd: estimateTtsCostUsd(options.model, Buffer.byteLength(input)),
  };
}

/** OpenRouter's error shape is `{ error: { code, message } }`; failed generations aren't billed. */
async function failure(response: Response): Promise<TtsError> {
  const message = await response
    .json()
    .then((body) => (body as { error?: { message?: unknown } }).error?.message)
    .catch(() => undefined);
  const detail = `Fish TTS ${response.status}${typeof message === "string" ? `: ${message.slice(0, 200)}` : ""}`;
  switch (response.status) {
    // A wrong or disabled key, no credits, a spend limit reached.
    case 401:
    case 402:
    case 403:
      return new TtsError(detail, "account");
    case 429:
      return new TtsError(detail, "busy", { retryable: true, ...retryAfter(response) });
    case 408:
    case 500:
    case 502:
    case 503:
    case 504:
      return new TtsError(detail, "unavailable", { retryable: true, ...retryAfter(response) });
    // 400: an unknown voice or text the provider won't read. Retrying won't change it.
    default:
      return new TtsError(detail, "rejected");
  }
}

function retryAfter(response: Response): { retryAfterMs?: number } {
  const seconds = Number(response.headers.get("retry-after"));
  return response.headers.has("retry-after") && Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: seconds * 1000 } : {};
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
