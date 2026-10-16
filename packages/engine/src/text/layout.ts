/**
 * Caption layout: wraps words into at most `maxLines` lines and balances
 * line lengths (like CSS `text-wrap: balance`) so captions never end with a
 * lonely word. Pure, so it's unit-testable without a canvas.
 */

export type Measure = (text: string) => number;

export interface LaidOutWord {
  text: string;
  line: number;
  x: number;
  width: number;
}

export interface CaptionLayout {
  words: LaidOutWord[];
  lines: number;
  lineWidths: number[];
  fontSize: number;
}

function wrap(words: string[], widths: number[], space: number, maxWidth: number): number[][] {
  const lines: number[][] = [];
  let current: number[] = [];
  let width = 0;
  words.forEach((_, i) => {
    const w = widths[i] as number;
    const next = current.length === 0 ? w : width + space + w;
    if (current.length > 0 && next > maxWidth) {
      lines.push(current);
      current = [i];
      width = w;
    } else {
      current.push(i);
      width = next;
    }
  });
  if (current.length) lines.push(current);
  return lines;
}

export function layoutCaption(
  text: string,
  options: { maxWidth: number; maxLines: number; fontSizes: number[]; measure: (fontSize: number) => Measure },
): CaptionLayout {
  const words = text.split(/\s+/).filter(Boolean);
  let chosen: { lines: number[][]; widths: number[]; space: number; fontSize: number } | null = null;
  for (const fontSize of options.fontSizes) {
    const measure = options.measure(fontSize);
    const widths = words.map((w) => measure(w));
    const space = measure(" ");
    const lines = wrap(words, widths, space, options.maxWidth);
    chosen = { lines, widths, space, fontSize };
    if (lines.length <= options.maxLines) break;
  }
  if (!chosen) return { words: [], lines: 0, lineWidths: [], fontSize: options.fontSizes[0] ?? 16 };

  // Balance: shrink the wrap width while the line count stays the same.
  const target = chosen.lines.length;
  if (target > 1) {
    let lo = 0;
    let hi = options.maxWidth;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const attempt = wrap(words, chosen.widths, chosen.space, mid);
      if (attempt.length <= target && attempt.every((line) => line.length > 0)) hi = mid;
      else lo = mid;
    }
    const balanced = wrap(words, chosen.widths, chosen.space, hi);
    if (balanced.length === target) chosen.lines = balanced;
  }

  const laidOut: LaidOutWord[] = [];
  const lineWidths: number[] = [];
  chosen.lines.forEach((line, lineIndex) => {
    let x = 0;
    for (const i of line) {
      const width = chosen.widths[i] as number;
      laidOut.push({ text: words[i] as string, line: lineIndex, x, width });
      x += width + chosen.space;
    }
    lineWidths.push(Math.max(0, x - chosen.space));
  });
  return { words: laidOut, lines: chosen.lines.length, lineWidths, fontSize: chosen.fontSize };
}

/**
 * Which word is being spoken at `progress` (0..1), weighting words by
 * length so long words take longer, like speech does.
 */
export function wordAtProgress(words: readonly { text: string }[], progress: number): number {
  if (words.length === 0) return -1;
  const total = words.reduce((sum, w) => sum + w.text.length + 1, 0);
  let acc = 0;
  for (let i = 0; i < words.length; i++) {
    acc += (words[i] as { text: string }).text.length + 1;
    if (progress * total < acc) return i;
  }
  return words.length;
}
