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
  readonly offsetX = new Spring(0, SPRINGS.snappy);
  /** Drawn this much bigger or smaller, around its center (1: as painted). */
  readonly zoom = new Spring(1, SPRINGS.pop);
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

  /** A quick pop: drawn at `from` times its size, springing back to 1. */
  pop(from = 1.08): void {
    this.zoom.snap(from);
    this.zoom.target = 1;
  }

  update(dt: number, now: number): void {
    this.opacity.step(dt);
    this.offsetY.step(dt);
    this.offsetX.step(dt);
    this.zoom.step(dt);
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

/** Under the moment stage, ending above TikTok's comment feed (y 1180) even at three lines (ADR-0049). */
const CAPTION = { centerX: 540, top: 910, maxWidth: 860, maxLines: 3, sizes: [60, 52, 46], lineHeight: 1.12, pad: 40 };
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
