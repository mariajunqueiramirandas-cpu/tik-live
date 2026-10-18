import type { UpNextItem } from "@tik-live/shared";
import { Spring, SPRINGS } from "../anim/spring";
import type { Gl } from "../gl/gl";
import { FONT_FAMILY, GOLD, HAZE, INK, measureWith, roundRect, TextSprite, truncate, withAlpha } from "./sprites";

/**
 * The show's heads-up panels (ADR-0028), top left under the disclosure
 * badge: what's up next with a countdown, and who sent the most likes in the
 * last few minutes. Both stay left of the character (x 375 at rest, 430
 * during games); the likers panel steps aside while a game board is up, as
 * it would cover the board's title. Painted when their content changes; only
 * the countdown repaints, once a second.
 */

const X = 64;
const TOP = 330;
const GAP = 16;
const PAD = 18;
const CARD_MIN_W = 280;
const CARD_MAX_W = 340;
const LIKERS_W = 340;
const LIKERS_ROWS = 3;
const PANEL_FILL = "rgba(12,6,34,0.64)";
const HEART = "#FF6FB5";
const MEDALS = [GOLD, "#CFD8F5", "#E8A06A"] as const;

/** "2:05", "1h05", or "já já" once it's due. */
export function formatCountdown(seconds: number): string {
  const s = Math.ceil(seconds);
  if (s <= 0) return "já já";
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 1234 → "1.234" (pt-BR). */
export function formatLikes(n: number): string {
  return n.toLocaleString("pt-BR");
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function panel(ctx: Canvas2D, width: number, height: number, border: string): void {
  ctx.fillStyle = PANEL_FILL;
  roundRect(ctx, 1, 1, width - 2, height - 2, 22);
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function heart(ctx: Canvas2D, x: number, y: number, size: number, color: string): void {
  const s = size / 2;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.9);
  ctx.bezierCurveTo(x - s * 1.3, y, x - s * 0.7, y - s * 1.05, x, y - s * 0.35);
  ctx.bezierCurveTo(x + s * 0.7, y - s * 1.05, x + s * 1.3, y, x, y + s * 0.9);
  ctx.fill();
  ctx.restore();
}

/** "A SEGUIR · 2:05" over the next thing on the show, and what comes after it. */
export class UpNext {
  readonly card: TextSprite;
  readonly timer: TextSprite;
  private items: UpNextItem[] = [];
  /** When the first item is due, on the stage clock (seconds). */
  private deadline = 0;
  private second = Number.NaN;
  private glow = "#7CF5FF";

  constructor(gl: Gl) {
    this.card = new TextSprite(gl);
    this.timer = new TextSprite(gl);
  }

  /** The panel's height on screen, for stacking the next one below it (0 when hidden). */
  get height(): number {
    return this.items.length ? this.card.height : 0;
  }

  setGlow(color: string, scale: number): void {
    this.glow = color;
    if (this.items.length) this.repaint(scale);
  }

  set(items: readonly UpNextItem[], now: number, scale: number): void {
    const wasEmpty = this.items.length === 0;
    this.items = items.slice(0, 2);
    const first = this.items[0];
    if (!first) {
      this.card.opacity.target = 0;
      this.timer.opacity.target = 0;
      return;
    }
    this.deadline = now + first.inMs / 1000;
    this.second = Number.NaN;
    this.paintCard(scale);
    this.paintTimer(now, scale);
    if (wasEmpty) {
      for (const sprite of [this.card, this.timer]) {
        sprite.opacity.snap(0);
        sprite.offsetY.snap(-20);
      }
    }
    this.card.opacity.target = 1;
    this.timer.opacity.target = 1;
    this.card.offsetY.target = 0;
    this.timer.offsetY.target = 0;
  }

  update(dt: number, now: number, scale: number): void {
    this.card.update(dt, now);
    this.timer.update(dt, now);
    if (this.items.length) this.paintTimer(now, scale);
  }

  repaint(scale: number): void {
    if (!this.items.length) return;
    this.paintCard(scale);
    this.second = Number.NaN;
  }

  private accentFor(item: UpNextItem): string {
    return item.kind === "podium" ? GOLD : item.kind === "game" ? this.glow : INK;
  }

  private paintCard(scale: number): void {
    const first = this.items[0] as UpNextItem;
    const after = this.items[1];
    const label = `760 22px ${FONT_FAMILY}`;
    const titleFont = `780 32px ${FONT_FAMILY}`;
    const afterFont = `600 23px ${FONT_FAMILY}`;
    const room = CARD_MAX_W - PAD * 2;
    const title = fit(first.title, titleFont, room);
    const later = after ? fit(`Depois: ${after.title}`, afterFont, room) : "";
    const width = Math.min(
      CARD_MAX_W,
      Math.max(CARD_MIN_W, measureWith(titleFont)(title) + PAD * 2, later ? measureWith(afterFont)(later) + PAD * 2 : 0, measureWith(label)("A SEGUIR") + 140),
    );
    const height = PAD + 24 + 8 + 40 + (later ? 32 : 0) + PAD - 4;
    const accent = this.accentFor(first);
    const glow = this.glow;
    this.card.x = X;
    this.card.y = TOP;
    this.card.draw(width, height, scale, (ctx) => {
      panel(ctx, width, height, withAlpha(first.kind === "podium" ? GOLD : glow, 0.4));
      ctx.textBaseline = "alphabetic";
      ctx.font = label;
      ctx.fillStyle = HAZE;
      ctx.fillText("A SEGUIR", PAD, PAD + 20);
      ctx.font = titleFont;
      ctx.fillStyle = accent;
      ctx.shadowColor = "rgba(5,2,18,0.6)";
      ctx.shadowBlur = 8;
      ctx.fillText(title, PAD, PAD + 24 + 8 + 30);
      if (later) {
        ctx.shadowBlur = 0;
        ctx.font = afterFont;
        ctx.fillStyle = HAZE;
        ctx.fillText(later, PAD, PAD + 24 + 8 + 40 + 24);
      }
    });
  }

  /** Repaints the countdown when the second it shows changes. */
  private paintTimer(now: number, scale: number): void {
    const left = Math.max(0, Math.ceil(this.deadline - now));
    if (left === this.second) return;
    this.second = left;
    const text = formatCountdown(left);
    const font = `800 24px ${FONT_FAMILY}`;
    const textWidth = measureWith(font)(text);
    const pad = 6;
    const color = left <= 10 ? GOLD : this.glow;
    this.timer.x = X + this.card.width - PAD - textWidth - pad;
    this.timer.y = TOP + PAD - 2 - pad;
    this.timer.draw(textWidth + pad * 2, 28 + pad * 2, scale, (ctx) => {
      ctx.font = font;
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = color;
      ctx.fillText(text, pad, pad + 22);
    });
  }
}

/** "TOP CURTIDAS · 15 MIN": the three viewers who sent the most likes lately. */
export class TopLikers {
  readonly sprite: TextSprite;
  private rows: Array<{ name: string; likes: number }> = [];
  private windowMin = 15;
  /** Where the panel sits: under "up next" when that's showing. */
  private readonly top = new Spring(TOP, SPRINGS.snappy);

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
  }

  set(rows: ReadonlyArray<{ name: string; likes: number }>, windowMin: number, scale: number): void {
    const wasEmpty = this.rows.length === 0;
    this.rows = rows.slice(0, LIKERS_ROWS);
    this.windowMin = windowMin;
    // Shown and hidden in `update`, which also knows whether a game is on.
    if (!this.rows.length) return;
    this.paint(scale);
    if (wasEmpty) {
      this.sprite.opacity.snap(0);
      this.sprite.offsetY.snap(-20);
    }
    this.sprite.offsetY.target = 0;
  }

  /** `above` is the height of the panel over this one (0 when there's none); `game` is how far into game layout the stage is. */
  update(dt: number, now: number, above: number, game: number): void {
    this.sprite.opacity.target = this.rows.length > 0 && game < 0.5 ? 1 : 0;
    this.top.target = above > 0 ? TOP + above + GAP : TOP;
    this.top.step(dt);
    this.sprite.y = this.top.value;
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.rows.length) this.paint(scale);
  }

  private paint(scale: number): void {
    const rows = this.rows;
    const header = `TOP CURTIDAS · ${this.windowMin} MIN`;
    const headFont = `760 22px ${FONT_FAMILY}`;
    const nameFont = `720 26px ${FONT_FAMILY}`;
    const countFont = `800 24px ${FONT_FAMILY}`;
    const rowH = 38;
    const width = LIKERS_W;
    const height = PAD + 24 + 10 + rows.length * rowH + PAD - 6;
    const counts = rows.map((row) => formatLikes(row.likes));
    const countW = Math.max(...counts.map((text) => measureWith(countFont)(text)));
    const nameRoom = width - PAD * 2 - 30 - countW - 30 - 8;
    this.sprite.x = X;
    this.sprite.draw(width, height, scale, (ctx) => {
      panel(ctx, width, height, withAlpha(HEART, 0.38));
      ctx.textBaseline = "alphabetic";
      ctx.font = headFont;
      ctx.fillStyle = HAZE;
      ctx.fillText(header, PAD, PAD + 20);
      rows.forEach((row, i) => {
        const y = PAD + 24 + 10 + i * rowH + 28;
        ctx.font = countFont;
        ctx.fillStyle = MEDALS[i] as string;
        ctx.fillText(`${i + 1}`, PAD, y);
        ctx.font = nameFont;
        ctx.fillStyle = INK;
        ctx.fillText(fit(row.name, nameFont, nameRoom), PAD + 30, y);
        ctx.font = countFont;
        ctx.textAlign = "right";
        ctx.fillStyle = INK;
        ctx.fillText(counts[i] as string, width - PAD, y);
        ctx.textAlign = "left";
        heart(ctx, width - PAD - countW - 17, y - 9, 20, HEART);
      });
    });
  }
}

/** Cuts `text` with an ellipsis until it fits `maxWidth` in `font`. */
function fit(text: string, font: string, maxWidth: number): string {
  const measure = measureWith(font);
  if (measure(text) <= maxWidth) return text;
  let max = text.length;
  while (max > 2 && measure(truncate(text, max)) > maxWidth) max -= 1;
  return truncate(text, max);
}
