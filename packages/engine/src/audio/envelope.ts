/**
 * A speaking envelope derived from the text itself (ADR-0009), used when a
 * line has no audio (captions-only mode): the mouth opens once per syllable
 * with short pauses between words, instead of flapping randomly. Each
 * syllable also carries a rough mouth shape from its vowel.
 */
const VOWELS = /[aeiouyáéíóúàèìòùâêîôûãõäëïöü]+/g;

export function syllableCount(word: string): number {
  const groups = word.toLowerCase().match(VOWELS);
  return Math.max(1, groups?.length ?? 1);
}

/** Mouth shape weights: `round` for o/u sounds, `wide` for i/e sounds. */
export interface MouthShape {
  round: number;
  wide: number;
}

export interface Envelope {
  (tMs: number): number;
  durationMs: number;
  /** Mouth shape of the syllable under `tMs` (written into `out`, no allocation). */
  shape(tMs: number, out: MouthShape): MouthShape;
}

interface Unit {
  start: number;
  end: number;
  round: number;
  wide: number;
}

function vowelShape(group: string | undefined): { round: number; wide: number } {
  const v = (group ?? "a").normalize("NFD").replace(/[̀-ͯ]/g, "")[0] ?? "a";
  if (v === "o" || v === "u") return { round: 1, wide: 0 };
  if (v === "i" || v === "e" || v === "y") return { round: 0, wide: 1 };
  return { round: 0, wide: 0 };
}

export function syllableEnvelope(text: string, durationMs: number): Envelope {
  const words = text.split(/\s+/).filter(Boolean);
  const units: Unit[] = [];
  const total = words.reduce((sum, w) => sum + syllableCount(w) + 0.6, 0) || 1;
  const perUnit = durationMs / total;
  let t = 0;
  for (const word of words) {
    const groups = word.toLowerCase().match(VOWELS) ?? [];
    const syllables = Math.max(1, groups.length);
    for (let i = 0; i < syllables; i++) {
      units.push({ start: t, end: t + perUnit, ...vowelShape(groups[i]) });
      t += perUnit;
    }
    t += perUnit * 0.6; // the pause between words
  }

  const find = (tMs: number): Unit | null => {
    if (tMs < 0 || tMs > durationMs) return null;
    let lo = 0;
    let hi = units.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const unit = units[mid] as Unit;
      if (tMs < unit.start) hi = mid - 1;
      else if (tMs > unit.end) lo = mid + 1;
      else return unit;
    }
    return null;
  };

  const envelope = ((tMs: number) => {
    if (tMs < 0 || tMs > durationMs) return 0;
    const unit = find(tMs);
    if (!unit) return 0.08;
    const p = (tMs - unit.start) / (unit.end - unit.start);
    return 0.35 + 0.6 * Math.sin(Math.PI * p);
  }) as Envelope;
  envelope.durationMs = durationMs;
  envelope.shape = (tMs, out) => {
    const unit = find(tMs);
    out.round = unit?.round ?? 0;
    out.wide = unit?.wide ?? 0;
    return out;
  };
  return envelope;
}
