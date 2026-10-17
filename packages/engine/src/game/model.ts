import type { GameScene, GameSceneKind } from "@tik-live/shared";
import { layoutCaption, type Measure } from "../text/layout";

/**
 * Pure game-scene logic (ADR-0023), unit-tested without a GPU: palettes,
 * transitions, the countdown, vote shares, text fitting and tile grids.
 */

export interface Palette {
  /** Atmosphere colors the stage blends toward. */
  primary: string;
  secondary: string;
  background: string;
  /** Board accent: labels, timer, glows. */
  accent: string;
}

export const PALETTES: Record<GameSceneKind, Palette> = {
  trivia: { primary: "#6C8CFF", secondary: "#B66CFF", background: "#070A2A", accent: "#9DB4FF" },
  poll: { primary: "#FF5FA2", secondary: "#FF9F45", background: "#1F0518", accent: "#FF8CC0" },
  scramble: { primary: "#7CFF6B", secondary: "#2FD9C0", background: "#03140F", accent: "#A6FF8A" },
  number: { primary: "#FFB53D", secondary: "#FF5E57", background: "#1C0A04", accent: "#FFC65C" },
  truefalse: { primary: "#36E0B0", secondary: "#FF5C7A", background: "#04161A", accent: "#6CF2CC" },
  math: { primary: "#4DD9A0", secondary: "#E8F07A", background: "#04140E", accent: "#E8F07A" },
  riddle: { primary: "#A46CFF", secondary: "#4FC3FF", background: "#0D0626", accent: "#C7A6FF" },
  fastest: { primary: "#FFE14D", secondary: "#FF4D6A", background: "#190A00", accent: "#FFE14D" },
  scoreboard: { primary: "#FFD15C", secondary: "#B16CFF", background: "#130722", accent: "#FFD15C" },
};

export type RoundScene = Exclude<GameScene, { kind: "scoreboard" }>;

export function isRound(scene: GameScene): scene is RoundScene {
  return scene.kind !== "scoreboard";
}

/** What a scene is "about": a new identity is a new round, not an update. */
export function sceneIdentity(scene: GameScene): string {
  switch (scene.kind) {
    case "trivia":
    case "poll":
      return `${scene.kind}|${scene.round}|${scene.question}`;
    case "scramble":
      return `scramble|${scene.round}|${scene.letters}`;
    case "number":
      return `number|${scene.round}|${scene.min}|${scene.max}`;
    case "truefalse":
      return `truefalse|${scene.round}|${scene.statement}`;
    case "math":
      return `math|${scene.round}|${scene.expression}`;
    case "riddle":
      return `riddle|${scene.round}|${scene.riddle}`;
    case "fastest":
      return `fastest|${scene.round}|${scene.word}`;
    case "scoreboard":
      return `scoreboard|${scene.title}`;
  }
}

export type SceneChange = "none" | "enter" | "update" | "swap" | "exit";

/**
 * How to get from one scene to the next: the server re-sends the whole
 * scene on every change, so the same round updates in place (bars move,
 * counts tick) and only a new round or game transitions.
 */
export function sceneChange(previous: GameScene | null, next: GameScene | null): SceneChange {
  if (!previous) return next ? "enter" : "none";
  if (!next) return "exit";
  return sceneIdentity(previous) === sceneIdentity(next) ? "update" : "swap";
}

/**
 * Everything on the board that isn't live: when this changes, the board
 * repaints its text; live values (counts, tallies, the range) change labels
 * and springs only.
 */
export function staticKey(scene: GameScene): string {
  switch (scene.kind) {
    case "trivia":
      return JSON.stringify([scene.kind, scene.round, scene.rounds, scene.phase, scene.question, scene.options, scene.correct, scene.tally]);
    case "poll":
      return JSON.stringify([scene.kind, scene.round, scene.rounds, scene.phase, scene.question, scene.options]);
    case "scramble":
      return JSON.stringify([scene.kind, scene.round, scene.rounds, scene.phase, scene.letters, scene.hint, scene.word, scene.winner]);
    case "number":
      return JSON.stringify([scene.kind, scene.round, scene.rounds, scene.phase, scene.min, scene.max, scene.answer]);
    case "truefalse":
      return JSON.stringify([scene.kind, scene.round, scene.rounds, scene.phase, scene.statement, scene.correct, scene.tally]);
    case "math":
      return JSON.stringify([scene.kind, scene.round, scene.rounds, scene.phase, scene.expression, scene.answer, scene.winner]);
    case "riddle":
      return JSON.stringify([scene.kind, scene.round, scene.rounds, scene.phase, scene.riddle, scene.hint, scene.answer, scene.winner]);
    case "fastest":
      return JSON.stringify([scene.kind, scene.round, scene.rounds, scene.phase, scene.word, scene.winner, scene.winnerMs]);
    case "scoreboard":
      return JSON.stringify([scene.kind, scene.title, scene.rows]);
  }
}

/**
 * The round's deadline on the local clock. `remainingMs` is relative to
 * receipt (no clock sync); re-sends within a third of a second of the
 * current deadline keep it, so network jitter doesn't twitch the timer.
 */
export function deadlineFor(previous: number | null, now: number, remainingMs: number): number {
  const next = now + remainingMs / 1000;
  return previous !== null && Math.abs(previous - next) < 0.35 ? previous : next;
}

/** 1 when the round just opened, 0 when time is up. */
export function timerFraction(now: number, deadline: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.max(0, Math.min(1, (deadline - now) / (durationMs / 1000)));
}

/** Whole seconds left, rounded up (shows 1 until it's really over). */
export function secondsLeft(now: number, deadline: number): number {
  return Math.max(0, Math.ceil(deadline - now - 1e-6));
}

/** Vote shares that add up to exactly 100 (largest remainder). All zero without votes. */
export function percentages(tally: readonly number[]): number[] {
  const total = tally.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return tally.map(() => 0);
  const raw = tally.map((n) => (n / total) * 100);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((sum, n) => sum + n, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i] = (out[i] as number) + 1;
    left -= 1;
  }
  return out;
}

/** Fractions 0..1 of the total (bar lengths). */
export function shares(tally: readonly number[]): number[] {
  const total = tally.reduce((sum, n) => sum + n, 0);
  return tally.map((n) => (total > 0 ? n / total : 0));
}

/** Index of the option with the most votes, or -1 with none (ties go to the first). */
export function leader(tally: readonly number[]): number {
  let best = -1;
  let most = 0;
  tally.forEach((n, i) => {
    if (n > most) {
      most = n;
      best = i;
    }
  });
  return best;
}

/** Where `value` sits on a min..max track, 0..1. */
export function trackPosition(value: number, min: number, max: number): number {
  if (max <= min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export interface TileGrid {
  perRow: number;
  rows: number;
  size: number;
  gap: number;
}

/** Letter tiles: one row up to 9, then balanced rows, as big as fits (up to `maxSize`). */
export function tileGrid(count: number, maxWidth: number, maxSize = 128, gap = 14): TileGrid {
  const n = Math.max(1, count);
  const rows = Math.ceil(n / 9);
  const perRow = Math.ceil(n / rows);
  const size = Math.min(maxSize, Math.floor((maxWidth - (perRow - 1) * gap) / perRow));
  return { perRow, rows, size, gap };
}

export interface FittedText {
  lines: string[];
  size: number;
  widths: number[];
}

/**
 * Wraps text into at most `maxLines` balanced lines, shrinking through
 * `sizes`; past the smallest size, ellipsizes the last line (and any single
 * word wider than the box). Never returns a line wider than `maxWidth`.
 */
export function fitText(text: string, maxWidth: number, maxLines: number, sizes: readonly number[], measure: (size: number) => Measure): FittedText {
  // The first size whose lines all fit (a long word alone on a line may not).
  let layout = layoutCaption(text, { maxWidth, maxLines, fontSizes: [sizes[0] ?? 16], measure });
  for (const size of sizes) {
    layout = layoutCaption(text, { maxWidth, maxLines, fontSizes: [size], measure });
    if (layout.lines <= maxLines && layout.lineWidths.every((w) => w <= maxWidth + 0.5)) break;
  }
  const m = measure(layout.fontSize);
  const lines: string[] = [];
  for (const word of layout.words) lines[word.line] = lines[word.line] === undefined ? word.text : `${lines[word.line]} ${word.text}`;
  const cut = lines.length > maxLines;
  lines.length = Math.min(lines.length, maxLines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const last = i === lines.length - 1;
    if (m(line) > maxWidth || (cut && last)) lines[i] = ellipsize(line, maxWidth, m, cut && last);
  }
  return { lines, size: layout.fontSize, widths: lines.map((line) => m(line)) };
}

/** Trims `text` until it (plus "…") fits; `force` always adds the ellipsis. */
export function ellipsize(text: string, maxWidth: number, measure: Measure, force = false): string {
  if (!force && measure(text) <= maxWidth) return text;
  let s = text;
  while (s.length > 0 && measure(`${s.trimEnd()}…`) > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** Overshooting ease-out for entrances (0..1, peaks a little over 1). */
export function easeOutBack(p: number): number {
  const x = Math.max(0, Math.min(1, p));
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
}

/** "1.4 s" from milliseconds, one decimal under a minute. */
export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}
