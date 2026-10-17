import { EFFECTS, EMOTIONS, type Effect, type Emotion } from "@tik-live/shared";

export { EMOTIONS, type Emotion };

export interface Utterance {
  text: string;
  emotion: Emotion;
  /** Reactions cued in the line with tags like [confetti]; played when it starts. */
  fx?: Effect[];
}

const MAX_FX_PER_LINE = 2;

const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "approx"]);
const MIN_CHUNK_CHARS = 10;

/**
 * Splits a token stream into speakable sentences as early as possible, so
 * text-to-speech can start on sentence one while the model is still writing
 * sentence two. Very short fragments are merged with the next sentence to
 * avoid choppy audio.
 */
export class SentenceSplitter {
  private buffer = "";
  private carry = "";

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    let boundary = this.findBoundary();
    while (boundary !== -1) {
      const sentence = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary);
      this.emit(sentence, out);
      boundary = this.findBoundary();
    }
    return out;
  }

  flush(): string[] {
    const rest = `${this.carry} ${this.buffer}`.trim();
    this.buffer = "";
    this.carry = "";
    return rest ? [rest] : [];
  }

  private emit(sentence: string, out: string[]): void {
    if (!sentence) return;
    const combined = this.carry ? `${this.carry} ${sentence}` : sentence;
    if (stripTags(combined).length < MIN_CHUNK_CHARS) {
      this.carry = combined;
      return;
    }
    this.carry = "";
    out.push(combined);
  }

  /**
   * Effect tags right after a sentence ("What a gift! [confetti]") belong to
   * it. Emotion tags there start the next sentence, so only effects are kept.
   * Returns -1 while a tag is still arriving.
   */
  private withTrailingEffects(end: number): number {
    const text = this.buffer;
    let at = end;
    for (;;) {
      const rest = text.slice(at);
      const tag = rest.match(/^\s*\[([a-z]*)(\])?/i);
      if (!tag) return at;
      if (!tag[2]) return tag[0].length === rest.length ? -1 : at; // "[conf" mid-stream: wait
      if (!(EFFECTS as readonly string[]).includes((tag[1] ?? "").toLowerCase())) return at;
      at += tag[0].length;
      if (at >= text.length) return -1; // more tags (or the next sentence) may follow
    }
  }

  /** Index just past the end of the first complete sentence in the buffer, or -1. */
  private findBoundary(): number {
    const text = this.buffer;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n") return i + 1;
      if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") continue;
      let end = i + 1;
      while (end < text.length && /[.!?…"'”’)\]]/.test(text[end] as string)) end++;
      if (end >= text.length) return -1; // might still be "..." or "?!" mid-stream
      if (!/\s/.test(text[end] as string)) continue; // "3.5", "example.com"
      if (ch === ".") {
        const word = text.slice(0, i).split(/\s+/).pop()?.toLowerCase() ?? "";
        if (ABBREVIATIONS.has(word)) continue;
      }
      return this.withTrailingEffects(end);
    }
    return -1;
  }
}

function stripTags(text: string): string {
  return text.replace(/\[[^\]]*\]/g, "").trim();
}

/** The effect tags in a piece of model text, at most two, in order. */
export function effectTags(raw: string): Effect[] {
  const fx: Effect[] = [];
  for (const match of raw.matchAll(/\[([a-z]+)\]/gi)) {
    const candidate = match[1]?.toLowerCase() as Effect;
    if ((EFFECTS as readonly string[]).includes(candidate) && !fx.includes(candidate) && fx.length < MAX_FX_PER_LINE) fx.push(candidate);
  }
  return fx;
}

/**
 * Turns a raw model sentence into something safe to feed a TTS engine:
 * reads an optional leading [emotion] tag and any [effect] tags, drops stage
 * directions, markdown and emoji (TTS engines read those literally).
 */
export function toUtterance(raw: string, fallback: Emotion = "neutral"): Utterance | undefined {
  let emotion = fallback;
  const tag = raw.match(/^\s*\[([a-z]+)\]/i);
  if (tag) {
    const candidate = tag[1]?.toLowerCase() as Emotion;
    if ((EMOTIONS as readonly string[]).includes(candidate)) emotion = candidate;
  }
  const fx = effectTags(raw);
  const text = raw
    .replace(/\[[^\]]*\]/g, " ") // emotion tags and any other bracketed directions
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // **bold** keeps its words
    .replace(/\*[^*]+\*/g, " ") // *laughs*
    .replace(/[*_#`>|~]/g, " ")
    .replace(/\p{Extended_Pictographic}|‍|️/gu, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1") // "Joe 🎮, hi" -> "Joe, hi"
    .trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return undefined;
  return fx.length ? { text, emotion, fx } : { text, emotion };
}
