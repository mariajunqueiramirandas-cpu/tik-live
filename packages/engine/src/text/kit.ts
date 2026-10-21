import type { GoalView, SupportWay } from "@tik-live/shared";
import { FONT_FAMILY, GOLD, measureWith, roundRect, type TextSprite, truncate, withAlpha } from "./sprites";

/**
 * The stage HUD's look (ADR-0048): one kit every panel draws with, so the
 * whole overlay reads as one broadcast package instead of a row of
 * look-alike boxes.
 *
 * - Cards are deep, nearly opaque surfaces with a soft glow in their color
 *   and a colored tab on top that says what they are at a glance.
 * - Nothing a viewer needs is smaller than 22 px on the 1080 px stage
 *   (about 8 pt on a phone); names and numbers are 26 px and up.
 * - Color keeps its meaning (ADR-0011): gold is money, pink is likes, cyan
 *   is "do it now", green is the raffle.
 */

export type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export const HEART = "#FF6FB5";
export const DIAMOND = "#7CDBFF";
export const CYAN = "#7CF5FF";
export const VIOLET = "#B16CFF";
export const PERK_PINK = "#FF4FD8";
export const RAFFLE_GREEN = "#4DFF9A";
export const EMBER = "#FF8A3D";
export const HOT = "#FF5C6C";
export const CREAM = "#FFF1B8";
/** Dark letters on a bright tab or chip. */
export const DEEP = "#14082E";
export const SURFACE = "rgba(13,7,34,0.86)";
export const MEDALS = [GOLD, "#D9E1F7", "#E8A06A"] as const;

/**
 * Where things sit on the 1080 × 1920 stage. The side columns flank the
 * character (its body spans x 375 to 705 at rest, 435 to 645 in a game)
 * below TikTok's header; in a game they end above the board (y 556).
 */
export const HUD = {
  /** The side margin, about TikTok's own. */
  margin: 44,
  /** Both side columns are this wide. */
  column: 330,
  /** The right column's right edge. */
  right: 1080 - 44,
  /** The show bar: the segment title, then the AI badge under it. */
  titleTop: 196,
  badgeTop: 262,
  /** Where the left column starts, under the badge, and where the right one starts. */
  leftTop: 316,
  rightTop: 202,
  gap: 12,
  /** In a game, where the board starts: side panels end above it. */
  boardTop: 556,
} as const;

/** Room around a panel's body in its texture, so its glow never clips into a hard edge. */
export const BLEED = 14;

export function font(weight: number, size: number): string {
  return `${weight} ${size}px ${FONT_FAMILY}`;
}

// ---- panels ------------------------------------------------------------------

/** Paints a panel `width` × `height` with room for its glow; `paint` draws from the body's top-left corner. */
export function paintPanel(sprite: TextSprite, width: number, height: number, scale: number, paint: (ctx: Canvas2D) => void, crossfade = false, now = 0): void {
  sprite.draw(
    width + BLEED * 2,
    height + BLEED * 2,
    scale,
    (ctx) => {
      ctx.translate(BLEED, BLEED);
      paint(ctx);
    },
    crossfade,
    now,
  );
}

/** Puts a panel's body (not its glow) at x, y. */
export function place(sprite: TextSprite, x: number, y: number): void {
  sprite.x = x - BLEED;
  sprite.y = y - BLEED;
}

/** A panel's body height (without the glow around it). */
export function bodyHeight(sprite: TextSprite): number {
  return Math.max(0, sprite.height - BLEED * 2);
}

/** A card: a deep surface glowing softly in `accent`, a two-tone edge, and light along the top. */
export function card(ctx: Canvas2D, width: number, height: number, accent: string, accent2: string = accent, radius = 26, body: string | CanvasGradient = SURFACE): void {
  ctx.save();
  ctx.shadowColor = withAlpha(accent, 0.4);
  ctx.shadowBlur = BLEED;
  ctx.fillStyle = body;
  roundRect(ctx, 0, 0, width, height, radius);
  ctx.fill();
  ctx.restore();
  const edge = ctx.createLinearGradient(0, 0, width, height);
  edge.addColorStop(0, withAlpha(accent, 0.95));
  edge.addColorStop(1, withAlpha(accent2, 0.5));
  ctx.strokeStyle = edge;
  ctx.lineWidth = 2.5;
  roundRect(ctx, 1.25, 1.25, width - 2.5, height - 2.5, radius - 1);
  ctx.stroke();
  const top = Math.min(height, 90) * 0.55;
  const shine = ctx.createLinearGradient(0, 0, 0, top);
  shine.addColorStop(0, "rgba(255,255,255,0.10)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  roundRect(ctx, 3, 3, width - 6, top, Math.min(radius - 2, top / 2));
  ctx.fill();
}

export type Mark = (ctx: Canvas2D, x: number, y: number, size: number, color: string) => void;

export const TAB_H = 36;
const TAB_FONT = font(900, 22);

/** How wide a tab is. */
export function tabWidth(text: string, mark?: Mark): number {
  return measureWith(TAB_FONT)(text) + 30 + (mark ? 28 : 0);
}

/**
 * The card's label: a pill filled with its color, dark capitals, and a mark
 * on the left. It's what tells a card apart at a glance. Returns its width.
 */
export function tab(ctx: Canvas2D, x: number, y: number, text: string, color: string | CanvasGradient, mark?: Mark): number {
  const width = tabWidth(text, mark);
  ctx.fillStyle = color;
  roundRect(ctx, x, y, width, TAB_H, TAB_H / 2);
  ctx.fill();
  let left = x + 15;
  if (mark) {
    mark(ctx, left + 10, y + TAB_H / 2, 20, DEEP);
    left += 28;
  }
  ctx.font = TAB_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = DEEP;
  ctx.fillText(text, left, y + TAB_H / 2 + 1);
  ctx.textBaseline = "alphabetic";
  return width;
}

/** A quiet outlined chip ending at `right` ("15 MIN", "1 H"). Returns its width. */
export function chip(ctx: Canvas2D, right: number, y: number, text: string, color: string, height = TAB_H): number {
  const f = font(850, 20);
  const width = measureWith(f)(text) + 24;
  ctx.fillStyle = withAlpha(color, 0.14);
  roundRect(ctx, right - width, y, width, height, height / 2);
  ctx.fill();
  ctx.strokeStyle = withAlpha(color, 0.6);
  ctx.lineWidth = 1.5;
  roundRect(ctx, right - width + 0.75, y + 0.75, width - 1.5, height - 1.5, (height - 1.5) / 2);
  ctx.stroke();
  ctx.font = f;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, right - width / 2, y + height / 2 + 1);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  return width;
}

/** A medal: a disc in the place's color with the number in it. */
export function medal(ctx: Canvas2D, x: number, y: number, r: number, place: number): void {
  ctx.fillStyle = MEDALS[place - 1] ?? MEDALS[2];
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = font(900, Math.round(r * 1.15));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = DEEP;
  ctx.fillText(String(place), x, y + 1);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/** A rounded bar's track and its fill to `fraction`, in `color` fading toward `color2`. */
export function bar(ctx: Canvas2D, x: number, y: number, width: number, height: number, fraction: number, color: string, color2: string = color, alpha = 1): void {
  ctx.fillStyle = "rgba(255,255,255,0.09)";
  roundRect(ctx, x, y, width, height, height / 2);
  ctx.fill();
  const f = Math.max(0, Math.min(1, fraction));
  if (f <= 0) return;
  const fill = ctx.createLinearGradient(x, 0, x + width, 0);
  fill.addColorStop(0, withAlpha(color, 0.8 * alpha));
  fill.addColorStop(1, withAlpha(color2, alpha));
  ctx.fillStyle = fill;
  const w = Math.max(height, width * f);
  roundRect(ctx, x, y, w, height, height / 2);
  ctx.fill();
  // Light along the top of the fill.
  ctx.fillStyle = `rgba(255,255,255,${0.24 * alpha})`;
  roundRect(ctx, x + 5, y + 3, Math.max(height - 10, w - 10), height * 0.38, height * 0.19);
  ctx.fill();
}

/** A slanted band of light crossing `width` × `height` at `progress` (0 to 1), clipped to a rounded rect. */
export function sweep(ctx: Canvas2D, x: number, y: number, width: number, height: number, radius: number, progress: number, alpha = 0.3): void {
  ctx.save();
  roundRect(ctx, x, y, width, height, radius);
  ctx.clip();
  const cx = x - 120 + (width + 240) * progress;
  const band = ctx.createLinearGradient(cx - 70, y, cx + 70, y + height);
  band.addColorStop(0, "rgba(255,255,255,0)");
  band.addColorStop(0.5, `rgba(255,250,228,${alpha})`);
  band.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = band;
  ctx.fillRect(x, y, width, height);
  ctx.restore();
}

/** Text with a dark edge, so it reads on any fill under it. */
export function outlined(ctx: Canvas2D, text: string, x: number, y: number, color = "#FFFFFF", edge = "rgba(10,4,26,0.72)", width = 6): void {
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.strokeStyle = edge;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// ---- marks -------------------------------------------------------------------

export const heart: Mark = (ctx, x, y, size, color) => {
  const s = size / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.9);
  ctx.bezierCurveTo(x - s * 1.3, y, x - s * 0.7, y - s * 1.05, x, y - s * 0.35);
  ctx.bezierCurveTo(x + s * 0.7, y - s * 1.05, x + s * 1.3, y, x, y + s * 0.9);
  ctx.fill();
};

export const diamond: Mark = (ctx, x, y, size, color) => {
  const s = size / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - s, y - s * 0.3);
  ctx.lineTo(x - s * 0.5, y - s * 0.8);
  ctx.lineTo(x + s * 0.5, y - s * 0.8);
  ctx.lineTo(x + s, y - s * 0.3);
  ctx.lineTo(x, y + s);
  ctx.closePath();
  ctx.fill();
};

export const crown: Mark = (ctx, x, y, size, color) => {
  const s = size / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - s, y + s * 0.7);
  ctx.lineTo(x - s, y - s * 0.6);
  ctx.lineTo(x - s * 0.5, y);
  ctx.lineTo(x, y - s * 0.9);
  ctx.lineTo(x + s * 0.5, y);
  ctx.lineTo(x + s, y - s * 0.6);
  ctx.lineTo(x + s, y + s * 0.7);
  ctx.closePath();
  ctx.fill();
};

/** A four-point twinkle. */
export const sparkle: Mark = (ctx, x, y, size, color) => {
  const s = size / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.quadraticCurveTo(x, y, x + s, y);
  ctx.quadraticCurveTo(x, y, x, y + s);
  ctx.quadraticCurveTo(x, y, x - s, y);
  ctx.quadraticCurveTo(x, y, x, y - s);
  ctx.fill();
};

/** A five-point star. */
export const star: Mark = (ctx, x, y, size, color) => {
  const r = size / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? r : r * 0.45;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    ctx.lineTo(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
  }
  ctx.closePath();
  ctx.fill();
};

export const plus: Mark = (ctx, x, y, size, color) => {
  const s = size * 0.42;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2.5, size * 0.18);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - s, y);
  ctx.lineTo(x + s, y);
  ctx.moveTo(x, y - s);
  ctx.lineTo(x, y + s);
  ctx.stroke();
};

/** An arrow out of the corner. */
export const share: Mark = (ctx, x, y, size, color) => {
  const s = size * 0.38;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2.5, size * 0.18);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x - s, y + s);
  ctx.lineTo(x + s, y - s);
  ctx.moveTo(x - s * 0.2, y - s);
  ctx.lineTo(x + s, y - s);
  ctx.lineTo(x + s, y + s * 0.2);
  ctx.stroke();
};

export const play: Mark = (ctx, x, y, size, color) => {
  const s = size / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - s * 0.7, y - s);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x - s * 0.7, y + s);
  ctx.closePath();
  ctx.fill();
};

/** A speech bubble. */
export const bubble: Mark = (ctx, x, y, size, color) => {
  const w = size;
  const h = size * 0.72;
  ctx.fillStyle = color;
  roundRect(ctx, x - w / 2, y - h / 2 - size * 0.08, w, h, h * 0.35);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - w * 0.22, y + h * 0.3);
  ctx.lineTo(x - w * 0.36, y + h * 0.72);
  ctx.lineTo(x + w * 0.04, y + h * 0.3);
  ctx.closePath();
  ctx.fill();
};

export const WAY_MARKS: Record<SupportWay, Mark> = { like: heart, follow: plus, share, gift: diamond };
export const WAY_COLORS: Record<SupportWay, string> = { like: HEART, follow: VIOLET, share: CYAN, gift: GOLD };

// ---- text --------------------------------------------------------------------

/** Cuts `text` with an ellipsis until it fits `maxWidth` in `font`. */
export function fit(text: string, f: string, maxWidth: number): string {
  const measure = measureWith(f);
  if (measure(text) <= maxWidth) return text;
  let max = text.length;
  while (max > 2 && measure(truncate(text, max)) > maxWidth) max -= 1;
  return truncate(text, max);
}

/** The font a line fits `maxWidth` in, shrinking from `size` down to `minSize`, and the text (cut only once it's as small as it goes). */
export function shrinkToFit(text: string, weight: number, size: number, minSize: number, maxWidth: number): { font: string; text: string; size: number } {
  let s = size;
  while (s > minSize && measureWith(font(weight, s))(text) > maxWidth) s -= 1;
  const f = font(weight, s);
  return { font: f, text: fit(text, f, maxWidth), size: s };
}

/**
 * Breaks `text` into at most `maxLines` lines no wider than `maxWidth`, with
 * `measure`; the last line is cut with an ellipsis if the rest doesn't fit.
 */
export function wrapLines(text: string, maxWidth: number, maxLines: number, measure: (text: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    const next = line ? `${line} ${word}` : word;
    if (measure(next) <= maxWidth || !line) {
      line = next;
      continue;
    }
    if (lines.length === maxLines - 1) {
      line = `${line} ${words.slice(i).join(" ")}`;
      break;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  const last = lines.length - 1;
  if (last >= 0 && measure(lines[last] as string) > maxWidth) {
    let cut = lines[last] as string;
    let max = cut.length;
    while (max > 2 && measure(truncate(cut, max)) > maxWidth) max -= 1;
    cut = truncate(cut, max);
    lines[last] = cut;
  }
  return lines;
}

/** Wraps at the biggest size from `size` down to `minSize` where it fits in `maxLines` without cutting. */
export function wrapToFit(text: string, weight: number, size: number, minSize: number, maxWidth: number, maxLines: number): { font: string; size: number; lines: string[] } {
  for (let s = size; ; s -= 1) {
    const f = font(weight, s);
    const measure = measureWith(f);
    const lines = wrapLines(text, maxWidth, maxLines, measure);
    const whole = lines.join(" ") === text.split(/\s+/).filter(Boolean).join(" ");
    if (whole || s <= minSize) return { font: f, size: s, lines };
  }
}

/** One line, shrinking from `size` to `minOne`, if the whole text fits; else two lines from `twoSize` down to `minTwo`. */
export function lineOrTwo(text: string, weight: number, size: number, minOne: number, twoSize: number, minTwo: number, maxWidth: number): { font: string; size: number; lines: string[] } {
  const one = shrinkToFit(text, weight, size, minOne, maxWidth);
  if (one.text === text) return { font: one.font, size: one.size, lines: [text] };
  return wrapToFit(text, weight, twoSize, minTwo, maxWidth, 2);
}

// ---- words and numbers ----------------------------------------------------------

/** "2:05", "1h05", or "já já" once it's due. */
export function formatCountdown(seconds: number): string {
  const s = Math.ceil(seconds);
  if (s <= 0) return "já já";
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "4:32", "0:07": a short countdown that never says "já já". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 1234 → "1.234", 25300 → "25,3 mil" (pt-BR). */
export function formatCount(n: number): string {
  if (n >= 10_000) return `${(Math.round(n / 100) / 10).toLocaleString("pt-BR")} mil`;
  return n.toLocaleString("pt-BR");
}

/** "15 MIN", "1 H". */
export function windowLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} H` : `${minutes} MIN`;
}

/** How full a goal's bar is, 0 to 1. */
export function goalFraction(goal: Pick<GoalView, "value" | "target">): number {
  return goal.target > 0 ? Math.max(0, Math.min(1, goal.value / goal.target)) : 0;
}

/** "3.240 / 5.000", "25,3 mil / 50 mil". */
export function goalProgress(goal: Pick<GoalView, "value" | "target">): string {
  return `${formatCount(goal.value)} / ${formatCount(goal.target)}`;
}

/** What's left to reach a goal, the way a viewer counts it: "FALTAM 1.760", "FALTA 1". */
export function goalLeft(goal: Pick<GoalView, "value" | "target">): string {
  const left = Math.max(0, goal.target - goal.value);
  return left === 1 ? "FALTA 1" : `FALTAM ${formatCount(left)}`;
}

/** Close enough to the goal that the panel says so (80% and up, not yet reached). */
export function goalNear(goal: Pick<GoalView, "value" | "target">): boolean {
  const f = goalFraction(goal);
  return f >= 0.8 && f < 1;
}

/** "65%": how far along a goal is, rounded down so it never says 100% before it's reached. */
export function goalPercent(goal: Pick<GoalView, "value" | "target">): string {
  return `${Math.floor(goalFraction(goal) * 100)}%`;
}

/** The top gifters' last line: what takes first place, past the leader's diamonds. */
export const CROWN_LABEL = "Roube a coroa";

/** "25,3 mil+": the diamonds that take the crown. */
export function crownTarget(top: number): string {
  return `${formatCount(top)}+`;
}

/** How much of the countdown ring is left, 1 (just set) to 0 (due). */
export function ringFraction(left: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
}

/** "ESCOLHA DE DUDA": the header of a card where one viewer chooses. */
export function pickHeader(by: string): string {
  return `ESCOLHA DE ${by.toUpperCase()}`;
}

