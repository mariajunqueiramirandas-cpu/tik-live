import type { AlertKind } from "@tik-live/shared";
import { Spring, SPRINGS } from "../anim/spring";
import type { Gl, Texture } from "../gl/gl";
import { layoutCaption, wordAtProgress, type CaptionLayout } from "./layout";

/**
 * Text drawn once with Canvas2D into a texture, then moved and faded on the
 * GPU (ADR-0009). Re-rasterized only when its content or scale changes.
 */

export const FONT_FAMILY = '"Bricolage Grotesque", "Segoe UI", system-ui, sans-serif';
export const INK = "#F4F0FF";
export const HAZE = "#A397D6";
export const GOLD = "#FFD15C";

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(width: number, height: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Canvas2D } {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext("2d") as OffscreenCanvasRenderingContext2D };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext("2d") as CanvasRenderingContext2D };
}

/** Shared measuring context (sizes don't matter for measureText). */
let measurer: Canvas2D | null = null;
export function measureWith(font: string): (text: string) => number {
  measurer ??= makeCanvas(4, 4).ctx;
  return (text) => {
    measurer!.font = font;
    return measurer!.measureText(text).width;
  };
}

export class TextSprite {
  readonly textures: [Texture, Texture];
  /** Logical rect (stage pixels). */
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  readonly opacity = new Spring(0, SPRINGS.snappy);
  readonly offsetY = new Spring(0, SPRINGS.snappy);
  /** Crossfade between textures[0] (0) and textures[1] (1). */
  mix = 0;
  private active = 0;
  private fadeFrom = 0;
  private fadeStart = -1;

  constructor(gl: Gl) {
    this.textures = [gl.texture(), gl.texture()];
  }

  /**
   * Draws new content. With `crossfade`, the new raster goes into the idle
   * texture and fades in over 120 ms (smooth karaoke highlight).
   */
  draw(width: number, height: number, scale: number, paint: (ctx: Canvas2D) => void, crossfade = false, now = 0): void {
    const { canvas, ctx } = makeCanvas(width * scale, height * scale);
    ctx.scale(scale, scale);
    paint(ctx);
    this.width = width;
    this.height = height;
    if (crossfade) {
      this.active = 1 - this.active;
      (this.textures[this.active] as Texture).upload(canvas, canvas.width, canvas.height);
      this.fadeFrom = this.mix;
      this.fadeStart = now;
    } else {
      (this.textures[this.active] as Texture).upload(canvas, canvas.width, canvas.height);
      this.mix = this.active;
      this.fadeStart = -1;
    }
  }

  update(dt: number, now: number): void {
    this.opacity.step(dt);
    this.offsetY.step(dt);
    if (this.fadeStart >= 0) {
      const p = Math.min(1, (now - this.fadeStart) / 0.12);
      this.mix = this.fadeFrom + (this.active - this.fadeFrom) * p;
      if (p >= 1) this.fadeStart = -1;
    }
  }

  visible(): boolean {
    return this.opacity.value > 0.003 && this.width > 0;
  }
}

// ---------------------------------------------------------------------------

const CAPTION = { centerX: 540, top: 1060, maxWidth: 900, maxLines: 3, sizes: [64, 56, 48], lineHeight: 1.12, pad: 40 };
/** During games the caption sits under the board, above TikTok's bottom UI. */
const GAME_CAPTION = { top: 1512, maxLines: 2, sizes: [52, 46, 40] };

/** The spoken line, revealed word by word in time with the voice. */
export class Caption {
  readonly sprite: TextSprite;
  private layout: CaptionLayout | null = null;
  private text = "";
  private startedAt = -1;
  private durationS = 1;
  private shownWord = -2;
  private glow = "#7CF5FF";
  private fadeAt = -1;
  private game = false;

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
  }

  setGlow(color: string): void {
    this.glow = color;
    this.shownWord = -2;
  }

  /** New line: lay it out now; the reveal starts with `start()`. */
  show(text: string): void {
    this.text = text;
    const fit = this.game ? GAME_CAPTION : CAPTION;
    this.layout = layoutCaption(text, {
      maxWidth: CAPTION.maxWidth,
      maxLines: fit.maxLines,
      fontSizes: fit.sizes,
      measure: (size) => measureWith(`720 ${size}px ${FONT_FAMILY}`),
    });
    this.startedAt = -1;
    this.shownWord = -2;
    this.fadeAt = -1;
    this.sprite.opacity.target = 1;
    this.sprite.offsetY.snap(this.sprite.opacity.value < 0.05 ? 18 : 0);
    this.sprite.offsetY.target = 0;
  }

  start(now: number, durationS: number): void {
    this.startedAt = now;
    this.durationS = Math.max(0.4, durationS);
  }

  /** Called when speech ends: hold the full line briefly, then fade. */
  finish(now: number): void {
    this.startedAt = -1;
    this.shownWord = (this.layout?.words.length ?? 0) - 1;
    this.fadeAt = now + 1.6;
  }

  hide(): void {
    this.sprite.opacity.target = 0;
    this.fadeAt = -1;
  }

  /** Invalidates the raster (fonts loaded, scale changed). */
  invalidate(): void {
    if (this.text) this.show(this.text);
  }

  /** `game` 0..1: how far the stage is into game layout (the caption moves down). */
  update(dt: number, now: number, scale: number, game = 0): void {
    if (this.fadeAt >= 0 && now > this.fadeAt) this.hide();
    if (game > 0.5 !== this.game) {
      // Re-fit at the size for where it's going; keep the reveal where it was.
      this.game = !this.game;
      if (this.layout) {
        this.layout = layoutCaption(this.text, {
          maxWidth: CAPTION.maxWidth,
          maxLines: this.game ? GAME_CAPTION.maxLines : CAPTION.maxLines,
          fontSizes: this.game ? GAME_CAPTION.sizes : CAPTION.sizes,
          measure: (size) => measureWith(`720 ${size}px ${FONT_FAMILY}`),
        });
        this.sprite.width = 0;
      }
    }
    this.sprite.y = CAPTION.top + (GAME_CAPTION.top - CAPTION.top) * game - CAPTION.pad;
    if (this.layout) {
      let word = this.shownWord;
      if (this.startedAt >= 0) {
        word = wordAtProgress(this.layout.words, (now - this.startedAt) / this.durationS);
      } else if (this.shownWord === -2) {
        word = -1;
      }
      if (word !== this.shownWord || this.sprite.width === 0) {
        const crossfade = this.shownWord >= -1 && this.sprite.width > 0;
        this.shownWord = word;
        this.paint(scale, crossfade, now);
      }
    }
    this.sprite.update(dt, now);
  }

  private paint(scale: number, crossfade: boolean, now: number): void {
    const layout = this.layout!;
    const lineHeight = layout.fontSize * CAPTION.lineHeight;
    const height = layout.lines * lineHeight + CAPTION.pad * 2;
    const width = CAPTION.maxWidth + CAPTION.pad * 2;
    this.sprite.x = CAPTION.centerX - width / 2;
    const current = this.shownWord;
    const glow = this.glow;
    this.sprite.draw(
      width,
      height,
      scale,
      (ctx) => {
        ctx.font = `720 ${layout.fontSize}px ${FONT_FAMILY}`;
        ctx.textBaseline = "alphabetic";
        layout.words.forEach((w, i) => {
          const lineWidth = layout.lineWidths[w.line] as number;
          const x = CAPTION.pad + (CAPTION.maxWidth - lineWidth) / 2 + w.x;
          const y = CAPTION.pad + w.line * lineHeight + layout.fontSize * 0.92;
          const said = i < current;
          const speaking = i === current;
          ctx.shadowColor = speaking ? withAlpha(glow, 0.8) : "transparent";
          ctx.shadowBlur = speaking ? 28 : 0;
          ctx.fillStyle = said || speaking ? INK : "rgba(244,240,255,0.3)";
          // A soft dark edge keeps captions readable over bright frames.
          if (said || speaking) {
            ctx.save();
            ctx.shadowColor = "rgba(5,2,18,0.55)";
            ctx.shadowBlur = 10;
            ctx.fillText(w.text, x, y);
            ctx.restore();
          }
          ctx.fillText(w.text, x, y);
        });
      },
      crossfade,
      now,
    );
  }
}

// ---------------------------------------------------------------------------

export type { AlertKind };

/** Alerts end at the right margin and stay clear of the HUD column on the left (it ends at x 404). */
const ALERT_RIGHT = 1080 - 64;
const ALERT_MAX_WIDTH = 600;
const ALERT_SIZE = 32;
const ALERT_MIN_SIZE = 24;
const PERK_PINK = "#FF4FD8";
const RAFFLE_GREEN = "#4DFF9A";

/** What goes between the name and the highlighted end: "duda enviou Rose", "duda desbloqueou Fura-fila!". */
export function alertVerb(kind: AlertKind): string {
  return kind === "gift" ? " enviou " : kind === "perk" ? " desbloqueou " : " ";
}

/**
 * The font size an alert fits `maxWidth` at, and the name cut to fit once
 * the font is as small as it goes. `measure(text, size)` measures at a size.
 */
export function fitAlert(parts: readonly [string, string, string], maxWidth: number, measure: (text: string, size: number, strong: boolean) => number, pad = 16, extra = 0): { size: number; name: string } {
  const width = (name: string, size: number) => measure(name, size, false) + measure(parts[1], size, false) + measure(parts[2], size, true) + pad * 2 + extra * (size / ALERT_SIZE);
  let size = ALERT_SIZE;
  while (size > ALERT_MIN_SIZE && width(parts[0], size) > maxWidth) size -= 2;
  let name = parts[0];
  while (name.length > 3 && width(name, size) > maxWidth) name = truncate(name, name.length - 1);
  return { size, name };
}

export class Alerts {
  private readonly items: Array<{ sprite: TextSprite; bornAt: number; slot: Spring; kind: AlertKind; parts: [string, string, string] }> = [];
  private readonly pool: TextSprite[] = [];
  private glow = "#7CF5FF";

  constructor(private readonly gl: Gl) {}

  setGlow(color: string): void {
    this.glow = color;
  }

  push(kind: AlertKind, name: string, detail: string, now: number, scale: number): void {
    const sprite = this.pool.pop() ?? new TextSprite(this.gl);
    const parts: [string, string, string] = [truncate(name, 24), alertVerb(kind), detail];
    this.paint(sprite, kind, parts, scale);
    sprite.opacity.snap(0);
    sprite.opacity.target = 1;
    sprite.offsetY.snap(28);
    sprite.offsetY.target = 0;
    for (const item of this.items) item.slot.target += 1;
    this.items.unshift({ sprite, bornAt: now, slot: new Spring(0, SPRINGS.snappy), kind, parts });
    while (this.items.length > 4) this.retire(this.items.length - 1, now);
  }

  update(dt: number, now: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!;
      // The loud ones (a new top gifter, a gift power) stay up a little longer.
      const life = item.kind === "crown" || item.kind === "perk" ? 7.5 : 6;
      if (now - item.bornAt > life) {
        item.sprite.opacity.target = 0;
        item.sprite.offsetY.target = -24;
      }
      item.slot.step(dt);
      item.sprite.update(dt, now);
      item.sprite.x = ALERT_RIGHT - item.sprite.width;
      item.sprite.y = 360 + item.slot.value * 56;
      if (now - item.bornAt > life + 1) this.retire(i, now);
    }
  }

  repaint(scale: number): void {
    for (const item of this.items) this.paint(item.sprite, item.kind, item.parts, scale);
  }

  sprites(): TextSprite[] {
    return this.items.map((item) => item.sprite);
  }

  /** Visits each live alert sprite without allocating (frame loop). */
  forEachSprite(visit: (sprite: TextSprite) => void): void {
    for (let i = 0; i < this.items.length; i++) visit((this.items[i] as { sprite: TextSprite }).sprite);
  }

  private retire(index: number, _now: number): void {
    const [item] = this.items.splice(index, 1);
    if (item) this.pool.push(item.sprite);
  }

  private accent(kind: AlertKind): string {
    switch (kind) {
      case "gift":
      case "crown":
        return GOLD;
      case "level":
        return "#FFB84D";
      case "perk":
        return PERK_PINK;
      case "raffle":
        return RAFFLE_GREEN;
      default:
        return this.glow;
    }
  }

  private paint(sprite: TextSprite, kind: AlertKind, parts: [string, string, string], scale: number): void {
    // A new top gifter and a gift power get a pill of their own, with a mark on the left.
    const pill = kind === "crown" || kind === "perk";
    const mark = pill ? 40 : 0;
    const pad = pill ? 22 : 16;
    const fitted = fitAlert(parts, ALERT_MAX_WIDTH, (text, size, strong) => measureWith(`${strong ? 800 : 640} ${size}px ${FONT_FAMILY}`)(text), pad, mark);
    const size = fitted.size;
    const font = `640 ${size}px ${FONT_FAMILY}`;
    const strong = `800 ${size}px ${FONT_FAMILY}`;
    const name = fitted.name;
    const measure = measureWith(font);
    const w0 = measure(name);
    const w1 = measure(parts[1]);
    const w2 = measureWith(strong)(parts[2]);
    const markW = mark * (size / ALERT_SIZE);
    const width = w0 + w1 + w2 + pad * 2 + markW;
    const height = size * 1.2 + 32;
    const accent = this.accent(kind);
    sprite.draw(width, height, scale, (ctx) => {
      ctx.textBaseline = "alphabetic";
      const y = 16 + size;
      let x = pad;
      if (pill) {
        // Gold (a new top gifter) or pink (a gift power) glass, with a crown or a diamond.
        ctx.save();
        ctx.shadowColor = withAlpha(accent, 0.7);
        ctx.shadowBlur = 14;
        const fill = ctx.createLinearGradient(0, 0, width, 0);
        fill.addColorStop(0, kind === "crown" ? "rgba(92,58,8,0.92)" : "rgba(78,10,66,0.92)");
        fill.addColorStop(1, "rgba(20,8,40,0.9)");
        ctx.fillStyle = fill;
        roundRect(ctx, 4, 6, width - 8, height - 12, (height - 12) / 2);
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = withAlpha(accent, 0.95);
        ctx.lineWidth = 2.5;
        roundRect(ctx, 4, 6, width - 8, height - 12, (height - 12) / 2);
        ctx.stroke();
        const cx = pad + markW / 2 - 4;
        const cy = height / 2;
        const s = size * 0.8;
        ctx.fillStyle = accent;
        ctx.beginPath();
        if (kind === "crown") {
          // A crown.
          ctx.moveTo(cx - s / 2, cy + s * 0.35);
          ctx.lineTo(cx - s / 2, cy - s * 0.3);
          ctx.lineTo(cx - s / 4, cy);
          ctx.lineTo(cx, cy - s * 0.45);
          ctx.lineTo(cx + s / 4, cy);
          ctx.lineTo(cx + s / 2, cy - s * 0.3);
          ctx.lineTo(cx + s / 2, cy + s * 0.35);
        } else {
          // A diamond.
          ctx.moveTo(cx - s / 2, cy - s * 0.15);
          ctx.lineTo(cx - s / 4, cy - s * 0.4);
          ctx.lineTo(cx + s / 4, cy - s * 0.4);
          ctx.lineTo(cx + s / 2, cy - s * 0.15);
          ctx.lineTo(cx, cy + s / 2);
        }
        ctx.closePath();
        ctx.fill();
        x += markW;
      }
      ctx.shadowColor = "rgba(5,2,18,0.6)";
      ctx.shadowBlur = 10;
      ctx.font = font;
      ctx.fillStyle = INK;
      ctx.fillText(name, x, y);
      ctx.fillText(parts[1], x + w0, y);
      ctx.font = strong;
      ctx.fillStyle = kind === "crown" ? "#FFF1B8" : accent;
      if (pill) {
        ctx.shadowColor = withAlpha(accent, 0.8);
        ctx.shadowBlur = 12;
      }
      ctx.fillText(parts[2], x + w0 + w1, y);
    });
  }
}

// ---------------------------------------------------------------------------

/** Segment title and the AI-disclosure badge, top left below TikTok's header. */
export class Chrome {
  readonly title: TextSprite;
  readonly badge: TextSprite;
  private titleText = "";
  private badgeText = "";
  private glow = "#7CF5FF";

  constructor(gl: Gl) {
    this.title = new TextSprite(gl);
    this.badge = new TextSprite(gl);
    this.badge.opacity.snap(1);
  }

  setGlow(color: string, scale: number): void {
    this.glow = color;
    if (this.titleText) this.paintTitle(scale);
  }

  setTitle(text: string, scale: number): void {
    if (text === this.titleText) return;
    this.titleText = text;
    this.paintTitle(scale);
    this.title.opacity.snap(0);
    this.title.opacity.target = 1;
    this.title.offsetY.snap(28);
    this.title.offsetY.target = 0;
  }

  setBadge(text: string, scale: number): void {
    this.badgeText = text;
    this.paintBadge(scale);
  }

  repaint(scale: number): void {
    if (this.titleText) this.paintTitle(scale);
    if (this.badgeText) this.paintBadge(scale);
  }

  update(dt: number, now: number): void {
    this.title.update(dt, now);
    this.badge.update(dt, now);
  }

  private paintTitle(scale: number): void {
    // Long titles shrink a little first, then squeeze into 640 px.
    const natural = measureWith(`760 44px ${FONT_FAMILY}`)(this.titleText);
    const font = `760 ${natural > 640 ? Math.max(36, Math.floor((44 * 640) / natural)) : 44}px ${FONT_FAMILY}`;
    // Room for the glow, so it never clips into a visible box.
    const pad = 48;
    const width = Math.min(640, measureWith(font)(this.titleText)) + pad * 2;
    this.title.x = 64 - pad;
    this.title.y = 200 - pad;
    const glow = this.glow;
    const text = this.titleText;
    this.title.draw(width, 44 * 1.1 + pad * 2, scale, (ctx) => {
      ctx.font = font;
      ctx.textBaseline = "alphabetic";
      ctx.shadowColor = withAlpha(glow, 0.55);
      ctx.shadowBlur = 22;
      ctx.fillStyle = INK;
      ctx.fillText(text, pad, pad + 40, 640);
    });
  }

  private paintBadge(scale: number): void {
    const font = `560 26px ${FONT_FAMILY}`;
    const textWidth = measureWith(font)(this.badgeText);
    const padX = 16;
    const width = textWidth + padX * 2 + 4;
    const height = 42;
    this.badge.x = 64;
    this.badge.y = 266;
    const text = this.badgeText;
    this.badge.draw(width, height, scale, (ctx) => {
      ctx.strokeStyle = "rgba(163,151,214,0.6)";
      ctx.lineWidth = 2;
      roundRect(ctx, 1, 1, width - 2, height - 2, (height - 2) / 2);
      ctx.stroke();
      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.fillStyle = HAZE;
      ctx.fillText(text, padX + 2, height / 2 + 1);
    });
  }
}

export function roundRect(ctx: Canvas2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** "#7CF5FF" + 0.5 → "rgba(124,245,255,0.5)". */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
