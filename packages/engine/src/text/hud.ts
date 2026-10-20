import type { Challenge, GoalKind, GoalView, LeaderBoard, LeaderRow, PerksCard, SupportCard, SupportWay, Ticker, UpNextItem } from "@tik-live/shared";
import { Spring, SPRINGS } from "../anim/spring";
import type { Gl } from "../gl/gl";
import { FONT_FAMILY, GOLD, HAZE, INK, measureWith, roundRect, TextSprite, truncate, withAlpha } from "./sprites";

/**
 * The show's heads-up panels (ADR-0028, ADR-0029), a narrow column top left
 * under the disclosure badge: a slim "A seguir" pill with a countdown, and
 * one ranking card that takes turns between the top likers and the top
 * gifters (or shows a vote while one is open, or for a moment how to
 * support the show, ADR-0032). The "dono da live" badge (ADR-0039) sits
 * just under the column, and a challenge or raffle (ADR-0040) or the gift
 * showcase (ADR-0041) takes the hook banner's place under the character.
 * The column stays left of the
 * character (x 375 at rest, 430 during games) and ends above where a game
 * board starts (y 560), clear of TikTok's header, right rail and comments.
 * Painted when content changes; the countdown repaints once a second and
 * the card crossfades when it turns. The stream's goals (ADR-0036) sit top
 * right, across from the title, with the always-on support ticker
 * (ADR-0041) under them and the alerts under that.
 */

const X = 64;
const TOP = 322;
const WIDTH = 340;
const GAP = 12;
const PILL_H = 66;
const PAD = 16;
const GLASS = "rgba(10,5,30,0.7)";
const HEART = "#FF6FB5";
const DIAMOND = "#7CDBFF";
const MEDALS = [GOLD, "#D9E1F7", "#E8A06A"] as const;
/** How long each ranking stays up before the card turns to the other one. Gifters get longer. */
const TURN_S = 8;
const TURN_GIFTS_S = 12;
/** The top gifters' card: a light sweep this often, lasting this long, repainted at most this often. */
const SHINE_EVERY_S = 4.5;
const SHINE_S = 0.9;
const SHINE_FRAME_S = 1 / 30;
/** How far the glow around the top gifters' card reaches past it. */
const AURA = 36;

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** "2:05", "1h05", or "já já" once it's due. */
export function formatCountdown(seconds: number): string {
  const s = Math.ceil(seconds);
  if (s <= 0) return "já já";
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 1234 → "1.234", 25300 → "25,3 mil" (pt-BR). */
export function formatCount(n: number): string {
  if (n >= 10_000) return `${(Math.round(n / 100) / 10).toLocaleString("pt-BR")} mil`;
  return n.toLocaleString("pt-BR");
}

/** How full a goal's bar is, 0 to 1. */
export function goalFraction(goal: Pick<GoalView, "value" | "target">): number {
  return goal.target > 0 ? Math.max(0, Math.min(1, goal.value / goal.target)) : 0;
}

/** "3.240 / 5.000", "25,3 mil / 50 mil". */
export function goalProgress(goal: Pick<GoalView, "value" | "target">): string {
  return `${formatCount(goal.value)} / ${formatCount(goal.target)}`;
}

/** "15 MIN", "1 H". */
export function windowLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} H` : `${minutes} MIN`;
}

/** Which ranking the card shows next: the other one when it has rows, else whichever does. */
export function nextBoard(current: LeaderBoard | null, hasRows: (board: LeaderBoard) => boolean): LeaderBoard | null {
  const other: LeaderBoard = current === "likes" ? "gifts" : "likes";
  if (current && hasRows(other)) return other;
  if (current && hasRows(current)) return current;
  if (hasRows("likes")) return "likes";
  return hasRows("gifts") ? "gifts" : null;
}

// ---- drawing helpers ---------------------------------------------------------

/** Dark glass with a two-color edge, a soft outer glow and light along the top. */
function glass(ctx: Canvas2D, width: number, height: number, a: string, b: string, radius: number): void {
  ctx.save();
  ctx.shadowColor = withAlpha(a, 0.35);
  ctx.shadowBlur = 18;
  ctx.fillStyle = GLASS;
  roundRect(ctx, 4, 4, width - 8, height - 8, radius);
  ctx.fill();
  ctx.restore();
  const edge = ctx.createLinearGradient(0, 0, width, height);
  edge.addColorStop(0, withAlpha(a, 0.95));
  edge.addColorStop(1, withAlpha(b, 0.55));
  ctx.strokeStyle = edge;
  ctx.lineWidth = 2;
  roundRect(ctx, 4, 4, width - 8, height - 8, radius);
  ctx.stroke();
  const shine = ctx.createLinearGradient(0, 4, 0, 4 + height * 0.5);
  shine.addColorStop(0, "rgba(255,255,255,0.10)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  roundRect(ctx, 5, 5, width - 10, height * 0.5, Math.min(radius, height * 0.25));
  ctx.fill();
}

function heart(ctx: Canvas2D, x: number, y: number, size: number, color: string): void {
  const s = size / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.9);
  ctx.bezierCurveTo(x - s * 1.3, y, x - s * 0.7, y - s * 1.05, x, y - s * 0.35);
  ctx.bezierCurveTo(x + s * 0.7, y - s * 1.05, x + s * 1.3, y, x, y + s * 0.9);
  ctx.fill();
}

function diamond(ctx: Canvas2D, x: number, y: number, size: number, color: string): void {
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
}

function crown(ctx: Canvas2D, x: number, y: number, size: number, color: string): void {
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
}

/** A four-point twinkle. */
function sparkle(ctx: Canvas2D, x: number, y: number, size: number, color: string): void {
  const s = size / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.quadraticCurveTo(x, y, x + s, y);
  ctx.quadraticCurveTo(x, y, x, y + s);
  ctx.quadraticCurveTo(x, y, x - s, y);
  ctx.quadraticCurveTo(x, y, x, y - s);
  ctx.fill();
}

/** Where the top gifters' card twinkles (fractions of its size), and each twinkle's phase in the sweep. */
const TWINKLES = [
  { x: 0.86, y: 0.1, size: 14, phase: 0.15 },
  { x: 0.62, y: 0.06, size: 9, phase: 0.45 },
  { x: 0.95, y: 0.42, size: 10, phase: 0.7 },
  { x: 0.04, y: 0.55, size: 9, phase: 0.3 },
  { x: 0.5, y: 0.97, size: 11, phase: 0.85 },
] as const;

/** How bright a twinkle is, 0.35 at rest up to 1 as the light sweep passes it. */
export function twinkle(shine: number | null, phase: number): number {
  if (shine === null) return 0.35;
  return 0.35 + 0.65 * Math.max(0, 1 - Math.abs(shine - phase) * 4);
}

/** The kind of thing that's up next: a play mark, a sparkle for a game, a crown for the podium. */
function kindMark(ctx: Canvas2D, kind: UpNextItem["kind"], x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (kind === "segment") {
    ctx.moveTo(x - 6, y - 8);
    ctx.lineTo(x + 8, y);
    ctx.lineTo(x - 6, y + 8);
  } else if (kind === "game") {
    for (let i = 0; i < 8; i++) {
      const r = i % 2 === 0 ? 10 : 3.5;
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
  } else {
    ctx.moveTo(x - 10, y + 7);
    ctx.lineTo(x - 10, y - 6);
    ctx.lineTo(x - 5, y);
    ctx.lineTo(x, y - 9);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x + 10, y - 6);
    ctx.lineTo(x + 10, y + 7);
  }
  ctx.closePath();
  ctx.fill();
}

/** Cuts `text` with an ellipsis until it fits `maxWidth` in `font`. */
function fit(text: string, font: string, maxWidth: number): string {
  const measure = measureWith(font);
  if (measure(text) <= maxWidth) return text;
  let max = text.length;
  while (max > 2 && measure(truncate(text, max)) > maxWidth) max -= 1;
  return truncate(text, max);
}

/** The font a line fits `maxWidth` in, shrinking from `size` down to `minSize`, and the text (cut only once it's as small as it goes). */
export function shrinkToFit(text: string, weight: number, size: number, minSize: number, maxWidth: number): { font: string; text: string } {
  let s = size;
  while (s > minSize && measureWith(`${weight} ${s}px ${FONT_FAMILY}`)(text) > maxWidth) s -= 1;
  const font = `${weight} ${s}px ${FONT_FAMILY}`;
  return { font, text: fit(text, font, maxWidth) };
}

function enter(sprite: TextSprite, wasHidden: boolean): void {
  if (wasHidden) {
    sprite.opacity.snap(0);
    sprite.offsetY.snap(-16);
  }
  sprite.opacity.target = 1;
  sprite.offsetY.target = 0;
}

// ---- up next ---------------------------------------------------------------------

/** A slim pill: "A SEGUIR" over the next thing on the show, and a countdown chip. */
export class UpNext {
  readonly pill: TextSprite;
  readonly timer: TextSprite;
  private item: UpNextItem | null = null;
  /** When it's due, on the stage clock (seconds). */
  private deadline = 0;
  private second = Number.NaN;
  private primary = "#7CF5FF";
  private secondary = "#FF5FD2";

  constructor(gl: Gl) {
    this.pill = new TextSprite(gl);
    this.timer = new TextSprite(gl);
  }

  /** The room it takes in the column (0 when hidden). */
  get height(): number {
    return this.item ? PILL_H + GAP : 0;
  }

  setColors(primary: string, secondary: string, scale: number): void {
    this.primary = primary;
    this.secondary = secondary;
    this.repaint(scale);
  }

  set(items: readonly UpNextItem[], now: number, scale: number): void {
    const wasHidden = this.item === null;
    this.item = items[0] ?? null;
    if (!this.item) {
      this.pill.opacity.target = 0;
      this.timer.opacity.target = 0;
      return;
    }
    this.deadline = now + this.item.inMs / 1000;
    this.second = Number.NaN;
    this.paintPill(scale);
    this.paintTimer(now, scale);
    enter(this.pill, wasHidden);
    enter(this.timer, wasHidden);
  }

  update(dt: number, now: number, scale: number): void {
    this.pill.update(dt, now);
    this.timer.update(dt, now);
    if (this.item) this.paintTimer(now, scale);
  }

  repaint(scale: number): void {
    if (!this.item) return;
    this.paintPill(scale);
    this.second = Number.NaN;
  }

  private paintPill(scale: number): void {
    const item = this.item as UpNextItem;
    const label = `800 17px ${FONT_FAMILY}`;
    const titleFont = `780 27px ${FONT_FAMILY}`;
    // Room on the right for the countdown chip ("1h05" is the widest).
    const title = fit(item.title, titleFont, WIDTH - 64 - 100);
    const podium = item.kind === "podium";
    const edge = podium ? GOLD : this.primary;
    const accent = podium ? GOLD : item.kind === "game" ? this.primary : INK;
    const secondary = podium ? "#FF8A3D" : this.secondary;
    this.pill.x = X;
    this.pill.y = TOP;
    this.pill.draw(WIDTH, PILL_H, scale, (ctx) => {
      glass(ctx, WIDTH, PILL_H, edge, secondary, (PILL_H - 8) / 2);
      // The kind mark in a small disc on the left.
      ctx.fillStyle = withAlpha(edge, 0.18);
      ctx.beginPath();
      ctx.arc(36, PILL_H / 2, 19, 0, Math.PI * 2);
      ctx.fill();
      kindMark(ctx, item.kind, 36, PILL_H / 2, edge);
      ctx.textBaseline = "alphabetic";
      ctx.font = label;
      ctx.fillStyle = HAZE;
      ctx.fillText("A SEGUIR", 64, 28);
      ctx.font = titleFont;
      ctx.fillStyle = accent;
      ctx.fillText(title, 64, 54);
    });
  }

  /** Repaints the countdown chip when the second it shows changes. */
  private paintTimer(now: number, scale: number): void {
    const left = Math.max(0, Math.ceil(this.deadline - now));
    if (left === this.second) return;
    this.second = left;
    const text = formatCountdown(left);
    const font = `800 24px ${FONT_FAMILY}`;
    const width = Math.max(64, measureWith(font)(text) + 26);
    const height = 38;
    const soon = left <= 10;
    const color = soon ? GOLD : this.primary;
    this.timer.x = X + WIDTH - 14 - width;
    this.timer.y = TOP + (PILL_H - height) / 2;
    this.timer.draw(width, height, scale, (ctx) => {
      ctx.fillStyle = withAlpha(color, soon ? 0.28 : 0.16);
      roundRect(ctx, 0, 0, width, height, height / 2);
      ctx.fill();
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      ctx.fillText(text, width / 2, height / 2 + 1);
    });
  }
}

// ---- the ranking card -----------------------------------------------------------

interface Board {
  rows: LeaderRow[];
  windowMin: number;
}

/** A chat vote shown in the card's place while it's open (ADR-0029), or one viewer's pick (`by`, ADR-0039). */
export interface HudVote {
  title: string;
  options: string[];
  tally: number[];
  by?: string;
}

/** A small glyph for each way to support the show. */
function wayMark(ctx: Canvas2D, way: SupportWay, x: number, y: number, color: string): void {
  switch (way) {
    case "like":
      heart(ctx, x, y, 17, color);
      return;
    case "gift":
      diamond(ctx, x, y + 1, 16, color);
      return;
    case "follow":
    case "share":
      ctx.strokeStyle = color;
      ctx.lineWidth = 3.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      if (way === "follow") {
        ctx.moveTo(x - 8, y);
        ctx.lineTo(x + 8, y);
        ctx.moveTo(x, y - 8);
        ctx.lineTo(x, y + 8);
      } else {
        // An arrow out of the corner.
        ctx.moveTo(x - 7, y + 7);
        ctx.lineTo(x + 7, y - 7);
        ctx.moveTo(x - 2, y - 7);
        ctx.lineTo(x + 7, y - 7);
        ctx.lineTo(x + 7, y + 2);
      }
      ctx.stroke();
      return;
  }
}

const WAY_COLORS: Record<SupportWay, string> = { like: HEART, follow: "#B16CFF", share: "#7CF5FF", gift: GOLD };
const PERK_PINK = "#FF4FD8";

/** "ESCOLHA DE DUDA": the header of a card where one viewer chooses. */
export function pickHeader(by: string): string {
  return `ESCOLHA DE ${by.toUpperCase()}`;
}

/**
 * One card that takes turns between the top likers and the top gifters, or
 * shows an open vote, or how to support the show. The top gifters get the
 * loud version: gold, a crown and a banner for first place, a glow that
 * breathes around the card, a light sweep now and then, and they cut in
 * whenever a gift comes in.
 */
export class LeaderCard {
  readonly sprite: TextSprite;
  /** The glow behind the top gifters' card. */
  readonly aura: TextSprite;
  private readonly boards: Record<LeaderBoard, Board> = { likes: { rows: [], windowMin: 15 }, gifts: { rows: [], windowMin: 60 } };
  private showing: LeaderBoard | null = null;
  private vote: HudVote | null = null;
  private support: SupportCard | null = null;
  private turnedAt = 0;
  private visible = false;
  private readonly top = new Spring(TOP, SPRINGS.snappy);
  /** When the last light sweep started, the progress last painted, and when a gift last cut in (for the glow's flash). */
  private shineAt = 0;
  private shinePainted = -1;
  private shinePaintedAt = 0;
  private flashAt = -Infinity;
  private auraHeight = 0;

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
    this.aura = new TextSprite(gl);
  }

  set(board: LeaderBoard, rows: readonly LeaderRow[], windowMin: number, now: number, scale: number): void {
    const before = this.boards[board].rows;
    this.boards[board] = { rows: rows.slice(0, 3), windowMin };
    if (this.vote || this.support) return;
    // A new gift cuts in, whatever was up: gifters are the show's VIPs.
    if (board === "gifts" && giftCameIn(before, this.boards.gifts.rows)) {
      const crossfade = this.visible && this.showing !== "gifts";
      this.showing = "gifts";
      this.turnedAt = now;
      this.flashAt = now;
      this.paint(scale, crossfade, now);
      this.sprite.offsetY.snap(-12);
      this.sprite.offsetY.target = 0;
      return;
    }
    const current = this.showing && this.has(this.showing) ? this.showing : null;
    // The other ranking waits its turn.
    if (current && current !== board) return;
    const next = current ?? nextBoard(null, (b) => this.has(b));
    if (next !== this.showing) this.turnedAt = now;
    this.showing = next;
    this.paint(scale, false, now);
  }

  /** Shows a vote instead of the rankings (null: back to the rankings). */
  setVote(vote: HudVote | null, now: number, scale: number): void {
    const crossfade = this.visible;
    this.vote = vote;
    if (!vote) this.showing = nextBoard(null, (b) => this.has(b));
    this.turnedAt = now;
    this.paint(scale, crossfade, now);
  }

  /** Shows how to support the show in the rankings' place (null: back to the rankings). An open vote stays on top. */
  setSupport(card: SupportCard | null, now: number, scale: number): void {
    const crossfade = this.visible;
    this.support = card;
    if (!card && !this.vote) this.showing = nextBoard(null, (b) => this.has(b));
    this.turnedAt = now;
    this.paint(scale, crossfade, now);
  }

  /** Where the column ends (stage px): the bottom of this card, or of whatever is above it when it's hidden. */
  bottom(above: number): number {
    return this.visible ? this.top.target + this.sprite.height : TOP + above - (above ? GAP : 0);
  }

  /** `above` is the room the pill takes over this card. */
  update(dt: number, now: number, above: number, scale: number): void {
    const gifts = this.showsGifts();
    if (!this.vote && !this.support && this.showing && now - this.turnedAt >= (gifts ? TURN_GIFTS_S : TURN_S)) {
      const next = nextBoard(this.showing, (b) => this.has(b));
      this.turnedAt = now;
      if (next !== this.showing) {
        this.showing = next;
        this.paint(scale, true, now);
      }
    }
    // The light sweep: not while the card is still fading in from the other ranking.
    if (this.showsGifts() && now - this.turnedAt > 1) {
      if (now - this.shineAt > SHINE_EVERY_S) this.shineAt = now;
      const p = (now - this.shineAt) / SHINE_S;
      if (p <= 1 && now - this.shinePaintedAt >= SHINE_FRAME_S) {
        this.shinePainted = p;
        this.shinePaintedAt = now;
        this.paintBoard("gifts", scale, false, now, p);
      } else if (p > 1 && this.shinePainted >= 0) {
        this.shinePainted = -1;
        this.paintBoard("gifts", scale, false, now, null);
      }
    }
    this.top.target = TOP + above;
    this.top.step(dt);
    this.sprite.y = this.top.value;
    this.sprite.update(dt, now);
    // The glow breathes, and flares when a gift cuts in.
    const flare = Math.max(0, 1 - (now - this.flashAt) / 1.5);
    const glow = this.showsGifts() && this.visible ? Math.min(1, 0.75 + 0.25 * Math.sin(now * 2.6) + flare) : 0;
    this.aura.x = this.sprite.x - AURA;
    this.aura.y = this.sprite.y + this.sprite.offsetY.value - AURA;
    this.aura.opacity.target = glow * Math.min(1, Math.max(0, this.sprite.opacity.value));
    this.aura.opacity.snap(this.aura.opacity.target);
    this.aura.update(dt, now);
  }

  repaint(scale: number): void {
    this.auraHeight = 0;
    this.paint(scale, false, 0);
  }

  private has(board: LeaderBoard): boolean {
    return this.boards[board].rows.length > 0;
  }

  private showsGifts(): boolean {
    return !this.vote && !this.support && this.showing === "gifts" && this.has("gifts");
  }

  private paint(scale: number, crossfade: boolean, now: number): void {
    const wasHidden = !this.visible;
    const vote = this.vote;
    const support = this.support;
    const board = this.showing && this.has(this.showing) ? this.showing : null;
    if (!vote && !support && !board) {
      this.visible = false;
      this.sprite.opacity.target = 0;
      return;
    }
    this.visible = true;
    this.sprite.x = X;
    if (vote) this.paintVote(vote, scale, crossfade && !wasHidden, now);
    else if (support) this.paintSupport(support, scale, crossfade && !wasHidden, now);
    else this.paintBoard(board as LeaderBoard, scale, crossfade && !wasHidden, now);
    enter(this.sprite, wasHidden);
  }

  private paintBoard(board: LeaderBoard, scale: number, crossfade: boolean, now: number, shine: number | null = null): void {
    if (board === "gifts") {
      this.paintGifts(scale, crossfade, now, shine);
      return;
    }
    const { rows, windowMin } = this.boards.likes;
    const color = HEART;
    const header = `TOP CURTIDAS · ${windowLabel(windowMin)}`;
    const headFont = `800 17px ${FONT_FAMILY}`;
    const nameFont = `720 25px ${FONT_FAMILY}`;
    const countFont = `800 23px ${FONT_FAMILY}`;
    const rowH = 36;
    const height = 50 + rows.length * rowH + 12;
    const counts = rows.map((row) => formatCount(row.value));
    const countW = Math.max(...counts.map((text) => measureWith(countFont)(text)));
    const nameRoom = WIDTH - PAD * 2 - 38 - countW - 28;
    this.sprite.draw(
      WIDTH,
      height,
      scale,
      (ctx) => {
        glass(ctx, WIDTH, height, color, "#B16CFF", 20);
        heart(ctx, PAD + 10, 28, 17, color);
        ctx.textBaseline = "alphabetic";
        ctx.font = headFont;
        ctx.fillStyle = HAZE;
        ctx.fillText(header, PAD + 26, 34);
        rows.forEach((row, i) => {
          const cy = 50 + i * rowH + rowH / 2;
          // A medal chip with the place in it.
          ctx.fillStyle = MEDALS[i] as string;
          ctx.beginPath();
          ctx.arc(PAD + 13, cy, 13, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = `800 17px ${FONT_FAMILY}`;
          ctx.textAlign = "center";
          ctx.fillStyle = "#1A0F33";
          ctx.fillText(String(i + 1), PAD + 13, cy + 6);
          ctx.textAlign = "left";
          ctx.font = nameFont;
          ctx.fillStyle = INK;
          ctx.fillText(fit(row.name, nameFont, nameRoom), PAD + 38, cy + 9);
          ctx.font = countFont;
          ctx.textAlign = "right";
          ctx.fillStyle = i === 0 ? color : INK;
          ctx.fillText(counts[i] as string, WIDTH - PAD, cy + 8);
          ctx.textAlign = "left";
          heart(ctx, WIDTH - PAD - countW - 14, cy, 15, color);
        });
      },
      crossfade,
      now,
    );
  }

  /** The top gifters, loud: gold edges, a crowned first place on a banner, twinkles and a light sweep (`shine` 0 to 1). */
  private paintGifts(scale: number, crossfade: boolean, now: number, shine: number | null): void {
    const { rows, windowMin } = this.boards.gifts;
    const headH = 52;
    const champH = 56;
    const rowH = 36;
    const height = headH + champH + Math.max(0, rows.length - 1) * rowH + 10;
    const headFont = `850 19px ${FONT_FAMILY}`;
    const champFont = `800 28px ${FONT_FAMILY}`;
    const champCountFont = `850 26px ${FONT_FAMILY}`;
    const nameFont = `720 24px ${FONT_FAMILY}`;
    const countFont = `800 22px ${FONT_FAMILY}`;
    const counts = rows.map((row) => formatCount(row.value));
    const champCountW = measureWith(champCountFont)(counts[0] ?? "");
    const countW = Math.max(0, ...counts.slice(1).map((text) => measureWith(countFont)(text)));
    this.paintAura(height, scale);
    this.sprite.draw(
      WIDTH,
      height,
      scale,
      (ctx) => {
        // A richer glass: deep purple warming to gold at the bottom (the glow around it is the aura's).
        ctx.save();
        const body = ctx.createLinearGradient(0, 0, 0, height);
        body.addColorStop(0, "rgba(34,12,62,0.9)");
        body.addColorStop(1, "rgba(58,30,20,0.88)");
        ctx.fillStyle = body;
        roundRect(ctx, 4, 4, WIDTH - 8, height - 8, 22);
        ctx.fill();
        ctx.restore();
        const edge = ctx.createLinearGradient(0, 0, WIDTH, height);
        edge.addColorStop(0, GOLD);
        edge.addColorStop(0.5, "#FF7AC8");
        edge.addColorStop(1, DIAMOND);
        ctx.strokeStyle = edge;
        ctx.lineWidth = 3;
        roundRect(ctx, 4, 4, WIDTH - 8, height - 8, 22);
        ctx.stroke();

        // Header: a crown, TOP DOADORES in gold, and the window in a chip.
        crown(ctx, PAD + 13, 28, 24, GOLD);
        ctx.textBaseline = "alphabetic";
        ctx.font = headFont;
        const title = ctx.createLinearGradient(PAD + 32, 14, PAD + 32, 36);
        title.addColorStop(0, "#FFF1B8");
        title.addColorStop(1, GOLD);
        ctx.fillStyle = title;
        ctx.fillText("TOP DOADORES", PAD + 32, 35);
        const chip = windowLabel(windowMin);
        ctx.font = `800 15px ${FONT_FAMILY}`;
        const chipW = measureWith(ctx.font)(chip) + 18;
        ctx.fillStyle = withAlpha(DIAMOND, 0.18);
        roundRect(ctx, WIDTH - PAD - chipW, 15, chipW, 26, 13);
        ctx.fill();
        ctx.fillStyle = DIAMOND;
        ctx.textAlign = "center";
        ctx.fillText(chip, WIDTH - PAD - chipW / 2, 33);
        ctx.textAlign = "left";

        rows.forEach((row, i) => {
          if (i === 0) {
            // First place: a golden banner, a crowned medal, and the biggest letters on the card.
            const y = headH;
            const banner = ctx.createLinearGradient(PAD, 0, WIDTH - PAD, 0);
            banner.addColorStop(0, withAlpha(GOLD, 0.42));
            banner.addColorStop(1, withAlpha("#FF8A3D", 0.14));
            ctx.fillStyle = banner;
            roundRect(ctx, PAD - 6, y, WIDTH - PAD * 2 + 12, champH - 8, 14);
            ctx.fill();
            ctx.strokeStyle = withAlpha(GOLD, 0.75);
            ctx.lineWidth = 1.5;
            roundRect(ctx, PAD - 6, y, WIDTH - PAD * 2 + 12, champH - 8, 14);
            ctx.stroke();
            const cy = y + (champH - 8) / 2;
            ctx.fillStyle = GOLD;
            ctx.beginPath();
            ctx.arc(PAD + 15, cy + 3, 15, 0, Math.PI * 2);
            ctx.fill();
            crown(ctx, PAD + 15, cy - 15, 16, "#FFF1B8");
            ctx.font = `850 18px ${FONT_FAMILY}`;
            ctx.textAlign = "center";
            ctx.fillStyle = "#1A0F33";
            ctx.fillText("1", PAD + 15, cy + 9);
            ctx.textAlign = "left";
            ctx.save();
            ctx.shadowColor = withAlpha(GOLD, 0.8);
            ctx.shadowBlur = 12;
            ctx.font = champFont;
            ctx.fillStyle = "#FFF1B8";
            ctx.fillText(fit(row.name, champFont, WIDTH - PAD * 2 - 42 - champCountW - 34), PAD + 40, cy + 10);
            ctx.restore();
            ctx.font = champCountFont;
            ctx.textAlign = "right";
            ctx.fillStyle = GOLD;
            ctx.fillText(counts[0] as string, WIDTH - PAD - 6, cy + 10);
            ctx.textAlign = "left";
            diamond(ctx, WIDTH - PAD - 6 - champCountW - 15, cy + 2, 17, DIAMOND);
            return;
          }
          const cy = headH + champH + (i - 1) * rowH + rowH / 2 - 2;
          ctx.fillStyle = MEDALS[i] as string;
          ctx.beginPath();
          ctx.arc(PAD + 15, cy, 13, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = `800 17px ${FONT_FAMILY}`;
          ctx.textAlign = "center";
          ctx.fillStyle = "#1A0F33";
          ctx.fillText(String(i + 1), PAD + 15, cy + 6);
          ctx.textAlign = "left";
          ctx.font = nameFont;
          ctx.fillStyle = INK;
          ctx.fillText(fit(row.name, nameFont, WIDTH - PAD * 2 - 40 - countW - 28), PAD + 40, cy + 9);
          ctx.font = countFont;
          ctx.textAlign = "right";
          ctx.fillStyle = DIAMOND;
          ctx.fillText(counts[i] as string, WIDTH - PAD - 2, cy + 8);
          ctx.textAlign = "left";
          diamond(ctx, WIDTH - PAD - 2 - countW - 14, cy + 1, 14, DIAMOND);
        });

        for (const t of TWINKLES) sparkle(ctx, t.x * WIDTH, t.y * height, t.size, withAlpha("#FFF6D6", twinkle(shine, t.phase)));

        // The light sweep: a slanted band of light crossing the card, kept inside its edge.
        if (shine !== null) {
          ctx.save();
          roundRect(ctx, 4, 4, WIDTH - 8, height - 8, 22);
          ctx.clip();
          const x = -120 + (WIDTH + 240) * shine;
          const band = ctx.createLinearGradient(x - 60, 0, x + 60, height);
          band.addColorStop(0, "rgba(255,255,255,0)");
          band.addColorStop(0.5, "rgba(255,248,220,0.28)");
          band.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = band;
          ctx.fillRect(0, 0, WIDTH, height);
          ctx.restore();
        }
      },
      crossfade,
      now,
    );
  }

  /** The soft gold glow behind the gifters' card, repainted only when the card's height changes. */
  private paintAura(height: number, scale: number): void {
    if (height === this.auraHeight) return;
    this.auraHeight = height;
    const w = WIDTH + AURA * 2;
    const h = height + AURA * 2;
    this.aura.draw(w, h, scale, (ctx) => {
      // Two passes, a wide warm halo and a tighter bright one, kept inside the texture so it never shows an edge.
      for (const [blur, alpha] of [
        [24, 0.75],
        [10, 0.9],
      ] as const) {
        ctx.save();
        ctx.shadowColor = withAlpha(GOLD, alpha);
        ctx.shadowBlur = blur;
        ctx.fillStyle = withAlpha(GOLD, alpha);
        roundRect(ctx, AURA + 4, AURA + 4, WIDTH - 8, height - 8, 22);
        ctx.fill();
        ctx.restore();
      }
    });
  }

  private paintSupport(card: SupportCard, scale: number, crossfade: boolean, now: number): void {
    const headFont = `800 17px ${FONT_FAMILY}`;
    const titleFont = `780 24px ${FONT_FAMILY}`;
    const lineFont = `720 22px ${FONT_FAMILY}`;
    const rowH = 36;
    const lines = card.lines.slice(0, 4);
    const height = 76 + lines.length * rowH + 8;
    this.sprite.draw(
      WIDTH,
      height,
      scale,
      (ctx) => {
        glass(ctx, WIDTH, height, GOLD, HEART, 20);
        ctx.textBaseline = "alphabetic";
        ctx.font = headFont;
        ctx.fillStyle = GOLD;
        ctx.fillText("APOIE A LIVE", PAD, 32);
        ctx.font = titleFont;
        ctx.fillStyle = INK;
        ctx.fillText(fit(card.title, titleFont, WIDTH - PAD * 2), PAD, 61);
        lines.forEach((line, i) => {
          const cy = 76 + i * rowH + rowH / 2;
          const color = WAY_COLORS[line.way];
          ctx.fillStyle = withAlpha(color, 0.16);
          ctx.beginPath();
          ctx.arc(PAD + 14, cy, 15, 0, Math.PI * 2);
          ctx.fill();
          wayMark(ctx, line.way, PAD + 14, cy, color);
          ctx.font = lineFont;
          ctx.fillStyle = line.way === "gift" ? GOLD : INK;
          ctx.fillText(fit(line.text, lineFont, WIDTH - PAD * 2 - 40), PAD + 40, cy + 8);
        });
      },
      crossfade,
      now,
    );
  }

  /** One viewer chooses (a gift power or the raffle's prize): their name on top, the options numbered, no tally. */
  private paintPick(vote: HudVote & { by: string }, scale: number, crossfade: boolean, now: number): void {
    const headFont = `850 18px ${FONT_FAMILY}`;
    const titleFont = `780 23px ${FONT_FAMILY}`;
    const optionFont = `720 21px ${FONT_FAMILY}`;
    const rowH = 34;
    const options = vote.options.slice(0, 3);
    const height = 74 + options.length * rowH + 34;
    this.sprite.draw(
      WIDTH,
      height,
      scale,
      (ctx) => {
        glass(ctx, WIDTH, height, GOLD, "#FF8A3D", 20);
        crown(ctx, PAD + 11, 27, 22, GOLD);
        ctx.textBaseline = "alphabetic";
        ctx.font = headFont;
        ctx.fillStyle = GOLD;
        ctx.fillText(fit(pickHeader(vote.by), headFont, WIDTH - PAD * 2 - 28), PAD + 28, 33);
        ctx.font = titleFont;
        ctx.fillStyle = INK;
        ctx.fillText(fit(vote.title, titleFont, WIDTH - PAD * 2), PAD, 60);
        options.forEach((option, i) => {
          const y = 72 + i * rowH;
          ctx.fillStyle = "rgba(255,255,255,0.07)";
          roundRect(ctx, PAD, y, WIDTH - PAD * 2, rowH - 6, 10);
          ctx.fill();
          // The number in a gold disc: that's what they type.
          ctx.fillStyle = GOLD;
          ctx.beginPath();
          ctx.arc(PAD + 16, y + (rowH - 6) / 2, 11, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = `850 16px ${FONT_FAMILY}`;
          ctx.textAlign = "center";
          ctx.fillStyle = "#1A0F33";
          ctx.fillText(String(i + 1), PAD + 16, y + 20);
          ctx.textAlign = "left";
          ctx.font = optionFont;
          ctx.fillStyle = INK;
          ctx.fillText(fit(option, optionFont, WIDTH - PAD * 2 - 44), PAD + 36, y + 21);
        });
        ctx.font = `700 17px ${FONT_FAMILY}`;
        ctx.fillStyle = HAZE;
        ctx.fillText(fit(`${vote.by}, digite o número no chat`, ctx.font, WIDTH - PAD * 2), PAD, height - 18);
      },
      crossfade,
      now,
    );
  }

  private paintVote(vote: HudVote, scale: number, crossfade: boolean, now: number): void {
    if (vote.by) {
      this.paintPick(vote as HudVote & { by: string }, scale, crossfade, now);
      return;
    }
    const headFont = `800 17px ${FONT_FAMILY}`;
    const titleFont = `780 23px ${FONT_FAMILY}`;
    const optionFont = `720 21px ${FONT_FAMILY}`;
    const rowH = 34;
    const options = vote.options.slice(0, 3);
    const height = 74 + options.length * rowH + 10;
    const total = vote.tally.reduce((sum, n) => sum + n, 0);
    const lead = total ? vote.tally.indexOf(Math.max(...vote.tally)) : -1;
    this.sprite.draw(
      WIDTH,
      height,
      scale,
      (ctx) => {
        glass(ctx, WIDTH, height, GOLD, "#FF5FA2", 20);
        ctx.textBaseline = "alphabetic";
        ctx.font = headFont;
        ctx.fillStyle = GOLD;
        ctx.fillText(`VOTE NO CHAT · DIGITE ${options.map((_, i) => i + 1).join(", ")}`, PAD, 32);
        ctx.font = titleFont;
        ctx.fillStyle = INK;
        ctx.fillText(fit(vote.title, titleFont, WIDTH - PAD * 2), PAD, 60);
        options.forEach((option, i) => {
          const y = 72 + i * rowH;
          const share = total ? (vote.tally[i] ?? 0) / total : 0;
          const barW = WIDTH - PAD * 2;
          ctx.fillStyle = "rgba(255,255,255,0.07)";
          roundRect(ctx, PAD, y, barW, rowH - 6, 10);
          ctx.fill();
          if (share > 0) {
            ctx.fillStyle = withAlpha(i === lead ? GOLD : "#B16CFF", 0.45);
            roundRect(ctx, PAD, y, Math.max(20, barW * share), rowH - 6, 10);
            ctx.fill();
          }
          ctx.font = `800 19px ${FONT_FAMILY}`;
          ctx.fillStyle = i === lead ? GOLD : HAZE;
          ctx.fillText(String(i + 1), PAD + 10, y + 21);
          ctx.font = optionFont;
          ctx.fillStyle = INK;
          ctx.fillText(fit(option, optionFont, barW - 34 - 56), PAD + 32, y + 21);
          ctx.textAlign = "right";
          ctx.fillStyle = HAZE;
          ctx.fillText(total ? `${Math.round(share * 100)}%` : "", WIDTH - PAD - 10, y + 21);
          ctx.textAlign = "left";
        });
      },
      crossfade,
      now,
    );
  }
}

/** Whether a gift just came in for the gifters shown: their diamonds grew. Gifts aging out of the window only shrink them. */
export function giftCameIn(before: readonly LeaderRow[], after: readonly LeaderRow[]): boolean {
  const total = (rows: readonly LeaderRow[]) => rows.reduce((sum, row) => sum + row.value, 0);
  return total(after) > total(before);
}

// ---- the stream's goals ----------------------------------------------------------

const GOALS = { right: 1080 - 64, top: 200, width: 340, rowH: 52, head: 42 };
/** How long a goal just reached shows "META BATIDA!" before the next goal. */
const CELEBRATE_S = 4;
const GOAL_LOOK: Record<GoalKind, { label: string; color: string }> = {
  likes: { label: "CURTIDAS", color: HEART },
  gifts: { label: "DIAMANTES", color: DIAMOND },
};

/** The like and gift goals: a bar each, filling as they come in, and a moment of gold when one is reached. */
export class GoalPanel {
  readonly sprite: TextSprite;
  private goals: GoalView[] = [];
  /** Until when (stage clock, seconds) each goal just reached shows its celebration. */
  private readonly celebrating = new Map<GoalKind, number>();

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
  }

  set(goals: readonly GoalView[], now: number, scale: number): void {
    const wasHidden = this.goals.length === 0;
    for (const goal of goals) {
      const before = this.goals.find((old) => old.kind === goal.kind);
      if (before && goal.level > before.level) this.celebrating.set(goal.kind, now + CELEBRATE_S);
    }
    this.goals = goals.slice(0, 2);
    if (this.goals.length === 0) {
      this.celebrating.clear();
      this.sprite.opacity.target = 0;
      return;
    }
    const reached = this.goals.some((goal) => (this.celebrating.get(goal.kind) ?? 0) > now);
    this.paint(now, scale);
    if (wasHidden) enter(this.sprite, true);
    else if (reached) {
      // A little hop for the goal just reached.
      this.sprite.offsetY.snap(-14);
      this.sprite.offsetY.target = 0;
    }
  }

  update(dt: number, now: number, scale: number): void {
    let ended = false;
    for (const [kind, until] of this.celebrating) {
      if (until > now) continue;
      this.celebrating.delete(kind);
      ended = true;
    }
    if (ended && this.goals.length) this.paint(now, scale, true);
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.goals.length) this.paint(0, scale);
  }

  /** Where the panel ends (stage px), or where it would start when there are no goals. */
  bottom(): number {
    return this.goals.length ? GOALS.top + this.sprite.height : GOALS.top;
  }

  private paint(now: number, scale: number, crossfade = false): void {
    const { width, rowH, head } = GOALS;
    const goals = this.goals;
    const height = head + goals.length * rowH + 6;
    const labelFont = `800 15px ${FONT_FAMILY}`;
    const valueFont = `800 21px ${FONT_FAMILY}`;
    this.sprite.x = GOALS.right - width;
    this.sprite.y = GOALS.top;
    const party = goals.some((goal) => this.celebrating.has(goal.kind));
    this.sprite.draw(
      width,
      height,
      scale,
      (ctx) => {
        glass(ctx, width, height, party ? GOLD : HEART, party ? "#FF8A3D" : DIAMOND, 20);
        ctx.textBaseline = "alphabetic";
        ctx.font = `800 17px ${FONT_FAMILY}`;
        ctx.fillStyle = party ? GOLD : HAZE;
        ctx.fillText("METAS DA LIVE", PAD, 32);
        goals.forEach((goal, i) => {
          const top = head + i * rowH;
          const look = GOAL_LOOK[goal.kind];
          const done = this.celebrating.has(goal.kind);
          const color = done ? GOLD : look.color;
          if (goal.kind === "gifts") diamond(ctx, PAD + 9, top + 13, 15, color);
          else heart(ctx, PAD + 9, top + 12, 16, color);
          const value = done ? "META BATIDA!" : goalProgress(goal);
          ctx.font = valueFont;
          const valueW = measureWith(valueFont)(value);
          ctx.textAlign = "right";
          ctx.fillStyle = done ? GOLD : INK;
          ctx.fillText(value, width - PAD, top + 21);
          ctx.textAlign = "left";
          ctx.font = labelFont;
          ctx.fillStyle = HAZE;
          // "CURTIDAS · META 2" when there's room next to the numbers, else just "CURTIDAS".
          const room = width - PAD * 2 - 24 - valueW - 10;
          const numbered = `${look.label} · META ${goal.level}`;
          const label = goal.level > 1 && measureWith(labelFont)(numbered) <= room ? numbered : look.label;
          ctx.fillText(fit(label, labelFont, room), PAD + 24, top + 19);
          // The bar: a dim track, then the fill (full and gold while it celebrates).
          const barY = top + 30;
          const barW = width - PAD * 2;
          ctx.fillStyle = "rgba(255,255,255,0.08)";
          roundRect(ctx, PAD, barY, barW, 12, 6);
          ctx.fill();
          const share = done ? 1 : goalFraction(goal);
          if (share > 0) {
            const fill = ctx.createLinearGradient(PAD, 0, PAD + barW, 0);
            fill.addColorStop(0, withAlpha(color, 0.75));
            fill.addColorStop(1, color);
            ctx.fillStyle = fill;
            roundRect(ctx, PAD, barY, Math.max(12, barW * share), 12, 6);
            ctx.fill();
          }
        });
      },
      crossfade,
      now,
    );
  }
}

// ---- the support ticker ---------------------------------------------------------------

/** Right-aligned with the goals, under them (or in their place when there are none). */
const TICKER = { right: GOALS.right, width: GOALS.width, gap: 10, height: 98 };
/** How long each line stays up before the next. */
const TICKER_TURN_S = 4;

/**
 * Always on (ADR-0041): "APOIE A LIVE" and one line at a time, taking
 * turns between what gifts pay for, what each gift gets on the show (a
 * gift power with its price) and the free ways to help. Each new line
 * crossfades in with a little hop.
 */
export class SupportTicker {
  readonly sprite: TextSprite;
  private ticker: Ticker | null = null;
  private index = 0;
  private turnedAt = 0;
  private readonly top = new Spring(GOALS.top, SPRINGS.snappy);

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
  }

  set(ticker: Ticker | null, now: number, scale: number): void {
    const wasHidden = !this.ticker;
    this.ticker = ticker;
    if (!ticker) {
      this.sprite.opacity.target = 0;
      return;
    }
    this.index = 0;
    this.turnedAt = now;
    this.paint(scale, !wasHidden, now);
    if (wasHidden) enter(this.sprite, true);
  }

  /** Where the ticker ends (stage px), or `fallback` when it's off. */
  bottom(fallback: number): number {
    return this.ticker ? this.top.target + TICKER.height : fallback;
  }

  /** `above` is where the goals end. */
  update(dt: number, now: number, above: number, scale: number): void {
    const ticker = this.ticker;
    if (ticker && ticker.lines.length > 1 && now - this.turnedAt >= TICKER_TURN_S) {
      this.index = (this.index + 1) % ticker.lines.length;
      this.turnedAt = now;
      this.paint(scale, true, now);
      this.sprite.offsetY.snap(-6);
      this.sprite.offsetY.target = 0;
    }
    const top = above > GOALS.top ? above + TICKER.gap : GOALS.top;
    if (this.top.target !== top && !this.sprite.visible()) this.top.snap(top);
    this.top.target = top;
    this.top.step(dt);
    this.sprite.y = this.top.value;
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.ticker) this.paint(scale, false, 0);
  }

  private paint(scale: number, crossfade: boolean, now: number): void {
    const ticker = this.ticker as Ticker;
    const line = ticker.lines[this.index % ticker.lines.length] as Ticker["lines"][number];
    const { width, height } = TICKER;
    const gift = line.way === "gift";
    const headFont = `850 18px ${FONT_FAMILY}`;
    const chipFont = `900 24px ${FONT_FAMILY}`;
    const price = line.diamonds ? formatCount(line.diamonds) : "";
    const chipW = price ? measureWith(chipFont)(price) + 44 : 0;
    this.sprite.x = TICKER.right - width;
    this.sprite.draw(
      width,
      height,
      scale,
      (ctx) => {
        glass(ctx, width, height, gift ? GOLD : WAY_COLORS[line.way], PERK_PINK, 20);
        ctx.textBaseline = "alphabetic";
        // The header: a gift and the title in gold, and how far along the lines are.
        wayMark(ctx, "gift", PAD + 9, 27, GOLD);
        ctx.font = headFont;
        ctx.fillStyle = GOLD;
        ctx.fillText(fit(ticker.title.toUpperCase(), headFont, width - PAD * 2 - 100), PAD + 26, 34);
        const dots = Math.min(ticker.lines.length, 12);
        for (let i = 0; i < dots; i++) {
          ctx.fillStyle = i === this.index % dots ? GOLD : "rgba(255,255,255,0.22)";
          ctx.beginPath();
          ctx.arc(width - PAD - 4 - (dots - 1 - i) * 8, 27, 2.8, 0, Math.PI * 2);
          ctx.fill();
        }
        // The line: a gift power's price in a chip, or the way's mark, then the text.
        const cy = 66;
        let x = PAD;
        if (price) {
          ctx.fillStyle = withAlpha(GOLD, 0.24);
          roundRect(ctx, x, cy - 17, chipW, 34, 17);
          ctx.fill();
          diamond(ctx, x + 17, cy + 1, 17, DIAMOND);
          ctx.font = chipFont;
          ctx.fillStyle = GOLD;
          ctx.fillText(price, x + 31, cy + 9);
          x += chipW + 10;
        } else {
          const color = WAY_COLORS[line.way];
          ctx.fillStyle = withAlpha(color, 0.18);
          ctx.beginPath();
          ctx.arc(x + 17, cy, 17, 0, Math.PI * 2);
          ctx.fill();
          wayMark(ctx, line.way, x + 17, cy, color);
          x += 44;
        }
        const text = shrinkToFit(line.text, 820, 26, 19, width - x - PAD);
        ctx.font = text.font;
        ctx.fillStyle = gift ? GOLD : INK;
        ctx.fillText(text.text, x, cy + 9);
      },
      crossfade,
      now,
    );
  }
}

// ---- the call to people scrolling past ----------------------------------------------

const HOOK_BANNER = { centerX: 540, top: 936, height: 80, maxWidth: 920, margin: 12 };

/**
 * A big, bright call to people scrolling past (ADR-0037), under the
 * character and above the caption: it drops in, bobs gently while it's up,
 * and stays out of the way of a game board.
 */
export class HookBanner {
  readonly sprite: TextSprite;
  private text: string | null = null;
  private shownAt = 0;

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
  }

  set(text: string | null, now: number, scale: number): void {
    this.text = text;
    if (!text) {
      this.sprite.opacity.target = 0;
      return;
    }
    this.shownAt = now;
    this.paint(scale);
    this.sprite.opacity.snap(0);
    this.sprite.opacity.target = 1;
    this.sprite.offsetY.snap(46);
    this.sprite.offsetY.target = 0;
  }

  /** A call is up (the gift showcase steps aside). */
  get active(): boolean {
    return this.text !== null;
  }

  /** `away` (0 to 1) is how far a game board has come in, or 1 while a challenge has the spot: the banner gives way to them. */
  update(dt: number, now: number, away: number): void {
    if (this.text) {
      this.sprite.opacity.target = away > 0.05 ? 0 : 1;
      if (now - this.shownAt > 0.6) this.sprite.offsetY.target = Math.sin((now - this.shownAt) * 3.2) * 5;
    }
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.text) this.paint(scale);
  }

  private paint(scale: number): void {
    const text = (this.text as string).toUpperCase();
    const { height, margin, maxWidth } = HOOK_BANNER;
    const natural = measureWith(`900 38px ${FONT_FAMILY}`)(text);
    // Long calls shrink a little before they're cut.
    const size = natural > maxWidth - 150 ? Math.max(30, Math.floor((38 * (maxWidth - 150)) / natural)) : 38;
    const font = `900 ${size}px ${FONT_FAMILY}`;
    const shown = fit(text, font, maxWidth - 150);
    const width = Math.min(maxWidth, measureWith(font)(shown) + 150);
    this.sprite.x = HOOK_BANNER.centerX - width / 2;
    this.sprite.y = HOOK_BANNER.top;
    this.sprite.draw(width, height, scale, (ctx) => {
      const w = width - margin * 2;
      const h = height - margin * 2;
      ctx.save();
      ctx.shadowColor = "rgba(255,61,139,0.7)";
      ctx.shadowBlur = margin;
      const fill = ctx.createLinearGradient(margin, 0, margin + w, 0);
      fill.addColorStop(0, "#FF3D8B");
      fill.addColorStop(1, "#FFB03B");
      ctx.fillStyle = fill;
      roundRect(ctx, margin, margin, w, h, h / 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 3;
      roundRect(ctx, margin, margin, w, h, h / 2);
      ctx.stroke();
      // Light along the top, and a twinkle at each end.
      const shine = ctx.createLinearGradient(0, margin, 0, margin + h / 2);
      shine.addColorStop(0, "rgba(255,255,255,0.35)");
      shine.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = shine;
      roundRect(ctx, margin + 4, margin + 3, w - 8, h / 2, h / 4);
      ctx.fill();
      sparkle(ctx, margin + 36, height / 2, 26, "#FFF6D6");
      sparkle(ctx, width - margin - 36, height / 2, 26, "#FFF6D6");
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 6;
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(90,10,40,0.55)";
      ctx.strokeText(shown, width / 2, height / 2 + 2);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(shown, width / 2, height / 2 + 2);
    });
  }
}

// ---- the gift showcase -------------------------------------------------------------

/** In the challenge's place under the character (visible y 900 to 1052), above the caption. */
const SHOWCASE = { centerX: 540, top: 888, width: 940, height: 176, margin: 12 };
/** Each tile pops in this long after the one before, over this long. */
const TILE_STAGGER_S = 0.12;
const TILE_IN_S = 0.3;

/** How far tile `i` has popped in, 0 to 1, `t` seconds after the showcase went up. */
export function tileReveal(t: number, i: number): number {
  return Math.max(0, Math.min(1, (t - i * TILE_STAGGER_S) / TILE_IN_S));
}

/**
 * What each gift does on the show, big under the character (ADR-0041): a
 * gold title, what every gift gets, and one tile per gift power with its
 * price, the biggest one crowned. The tiles pop in one by one, then the
 * banner bobs while it's up. It gives way to a game, a challenge or a
 * call to people scrolling past.
 */
export class GiftShowcase {
  readonly sprite: TextSprite;
  private card: PerksCard | null = null;
  private shownAt = 0;
  private revealed = true;
  private paintedAt = 0;

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
  }

  set(card: PerksCard | null, now: number, scale: number): void {
    this.card = card;
    if (!card) {
      this.sprite.opacity.target = 0;
      return;
    }
    this.shownAt = now;
    this.revealed = false;
    this.paint(scale, now);
    this.sprite.opacity.snap(0);
    this.sprite.opacity.target = 1;
    this.sprite.offsetY.snap(46);
    this.sprite.offsetY.target = 0;
  }

  /** `away` (0 to 1): a game board coming in, or 1 while a challenge or a call has the spot. */
  update(dt: number, now: number, away: number, scale: number): void {
    if (this.card) {
      this.sprite.opacity.target = away > 0.05 ? 0 : 1;
      if (!this.revealed && now - this.paintedAt >= BAR_FRAME_S) this.paint(scale, now);
      if (now - this.shownAt > 0.6) this.sprite.offsetY.target = Math.sin((now - this.shownAt) * 3.2) * 4;
    }
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.card) this.paint(scale, this.paintedAt);
  }

  private paint(scale: number, now: number): void {
    const card = this.card as PerksCard;
    const { width, height, margin } = SHOWCASE;
    const rows = card.rows.slice(0, 5);
    const t = now - this.shownAt;
    this.paintedAt = now;
    this.revealed = tileReveal(t, rows.length - 1) >= 1;
    this.sprite.x = SHOWCASE.centerX - width / 2;
    this.sprite.y = SHOWCASE.top;
    const titleFont = `900 30px ${FONT_FAMILY}`;
    const priceFont = `900 25px ${FONT_FAMILY}`;
    this.sprite.draw(width, height, scale, (ctx) => {
      const w = width - margin * 2;
      const h = height - margin * 2;
      ctx.save();
      ctx.shadowColor = withAlpha(GOLD, 0.55);
      ctx.shadowBlur = margin;
      ctx.fillStyle = "rgba(14,6,36,0.88)";
      roundRect(ctx, margin, margin, w, h, 26);
      ctx.fill();
      ctx.restore();
      const edge = ctx.createLinearGradient(margin, 0, margin + w, 0);
      edge.addColorStop(0, GOLD);
      edge.addColorStop(0.5, PERK_PINK);
      edge.addColorStop(1, GOLD);
      ctx.strokeStyle = edge;
      ctx.lineWidth = 3;
      roundRect(ctx, margin, margin, w, h, 26);
      ctx.stroke();
      // The header: a gift and the title in gold, what every gift gets on the right.
      const headY = margin + 36;
      const left = margin + 22;
      wayMark(ctx, "gift", left + 12, headY - 9, GOLD);
      ctx.textBaseline = "alphabetic";
      ctx.font = titleFont;
      const title = ctx.createLinearGradient(0, headY - 26, 0, headY);
      title.addColorStop(0, "#FFF1B8");
      title.addColorStop(1, GOLD);
      ctx.fillStyle = title;
      const titleText = fit(card.title.toUpperCase(), titleFont, w * 0.55);
      ctx.fillText(titleText, left + 32, headY);
      if (card.every) {
        const room = width - margin - 22 - (left + 32 + measureWith(titleFont)(titleText) + 24);
        const every = shrinkToFit(card.every, 760, 21, 16, room);
        ctx.font = every.font;
        ctx.textAlign = "right";
        ctx.fillStyle = INK;
        ctx.fillText(every.text, width - margin - 22, headY - 2);
        ctx.textAlign = "left";
      }
      // One tile per power in two rows, cheapest first: the price in a chip, then what it does. The biggest is crowned in gold.
      const gap = 10;
      const cols = Math.ceil(rows.length / 2);
      const tilesX = margin + 14;
      const tileW = (w - 28 - gap * (cols - 1)) / cols;
      const tileTop = headY + 14;
      const tileH = (height - margin - 12 - tileTop - gap) / 2;
      const chipW = Math.max(...rows.map((row) => measureWith(priceFont)(formatCount(row.diamonds)))) + 46;
      rows.forEach((row, i) => {
        const p = tileReveal(t, i);
        if (p <= 0) return;
        const best = i === rows.length - 1 && rows.length > 1;
        const color = best ? GOLD : DIAMOND;
        const x = tilesX + (i % cols) * (tileW + gap);
        const y = tileTop + Math.floor(i / cols) * (tileH + gap) + (1 - p) * 12;
        const cy = y + tileH / 2;
        ctx.save();
        ctx.globalAlpha = p;
        if (best) {
          ctx.shadowColor = withAlpha(GOLD, 0.7);
          ctx.shadowBlur = 14;
        }
        ctx.fillStyle = withAlpha(color, best ? 0.22 : 0.1);
        roundRect(ctx, x, y, tileW, tileH, tileH / 2);
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = p;
        ctx.strokeStyle = withAlpha(color, best ? 0.9 : 0.4);
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, tileW, tileH, tileH / 2);
        ctx.stroke();
        // The price: a diamond and the number in a chip.
        ctx.fillStyle = withAlpha(color, best ? 0.3 : 0.18);
        roundRect(ctx, x + 5, y + 5, chipW, tileH - 10, (tileH - 10) / 2);
        ctx.fill();
        diamond(ctx, x + 25, cy + 1, 19, color);
        ctx.font = priceFont;
        ctx.fillStyle = best ? GOLD : INK;
        ctx.fillText(formatCount(row.diamonds), x + 41, cy + 9);
        // What it does, shrunk to fit before it's cut, and a crown on the biggest.
        const crowned = best ? 34 : 0;
        const label = shrinkToFit(row.text, 800, 25, 18, tileW - chipW - 26 - crowned);
        ctx.font = label.font;
        ctx.fillStyle = best ? GOLD : INK;
        ctx.fillText(label.text, x + chipW + 16, cy + 9);
        if (best) crown(ctx, x + tileW - 30, cy, 24, GOLD);
        ctx.restore();
      });
    });
  }
}

// ---- the "dono da live" ------------------------------------------------------------

/**
 * Where the "dono da live" badge sits (ADR-0039): left, under the HUD
 * column (it follows the column's bottom, never above `minTop`), left of
 * the character (its body starts at x 375) and above the hook banner
 * (y 936). A game board covers that spot, so the badge gives way to it.
 */
const BOSS = { x: X, minTop: 600, gap: 16, width: 300, height: 104, glow: 24 };

/** "4:32", "0:07": a short countdown that never says "já já". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A loud gold badge: a crown, "DONO DA LIVE", the name, and how long the reign has left. */
export class BossBadge {
  readonly sprite: TextSprite;
  private name: string | null = null;
  /** When the reign ends, on the stage clock (seconds). */
  private endsAt = 0;
  private second = Number.NaN;
  private shownAt = 0;
  private now = 0;
  private below = BOSS.minTop;
  private readonly top = new Spring(BOSS.minTop, SPRINGS.snappy);

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
  }

  set(boss: { name: string; leftMs: number } | null, now: number, scale: number): void {
    if (!boss || boss.leftMs <= 0) {
      this.name = null;
      this.sprite.opacity.target = 0;
      return;
    }
    const wasHidden = this.name === null;
    const changed = boss.name !== this.name;
    this.now = now;
    this.name = boss.name;
    this.endsAt = now + boss.leftMs / 1000;
    this.second = Number.NaN;
    this.paint(now, scale);
    if (wasHidden) this.top.snap(this.topFor(this.below));
    if (wasHidden || changed) {
      // A new reign (or the crown changing hands) drops in.
      this.shownAt = now;
      this.sprite.opacity.snap(0);
      this.sprite.offsetY.snap(-22);
      this.sprite.offsetY.target = 0;
    }
  }

  /** `below` is where the HUD column ends; `away` (0 to 1) how far a game board has come in. */
  update(dt: number, now: number, below: number, away: number, scale: number): void {
    this.below = below;
    this.now = now;
    if (this.name) {
      if (now >= this.endsAt) {
        this.name = null;
        this.sprite.opacity.target = 0;
      } else {
        this.paint(now, scale);
        this.sprite.opacity.target = away > 0.05 ? 0 : 1;
        if (now - this.shownAt > 0.6) this.sprite.offsetY.target = Math.sin((now - this.shownAt) * 2.4) * 3;
      }
    }
    this.top.target = this.topFor(below);
    this.top.step(dt);
    this.sprite.x = BOSS.x - BOSS.glow;
    this.sprite.y = this.top.value - BOSS.glow;
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    this.second = Number.NaN;
    if (this.name) this.paint(this.now, scale);
  }

  private topFor(below: number): number {
    return Math.max(BOSS.minTop, below + BOSS.gap);
  }

  /** Repaints when the second on the countdown changes. */
  private paint(now: number, scale: number): void {
    const left = Math.max(0, Math.ceil(this.endsAt - now - 1e-6));
    if (left === this.second || !this.name) return;
    this.second = left;
    const name = this.name;
    const { width, height, glow } = BOSS;
    const clock = formatClock(left);
    const headFont = `850 18px ${FONT_FAMILY}`;
    const shown = shrinkToFit(name, 850, 31, 21, width - 90 - 16);
    const clockFont = `800 18px ${FONT_FAMILY}`;
    const clockW = measureWith(clockFont)(clock) + 22;
    this.sprite.draw(width + glow * 2, height + glow * 2, scale, (ctx) => {
      ctx.translate(glow, glow);
      // A warm gold glow around a deep glass body that turns gold at the bottom.
      ctx.save();
      ctx.shadowColor = withAlpha(GOLD, 0.75);
      ctx.shadowBlur = 16;
      const body = ctx.createLinearGradient(0, 0, 0, height);
      body.addColorStop(0, "rgba(40,14,66,0.94)");
      body.addColorStop(1, "rgba(92,56,10,0.92)");
      ctx.fillStyle = body;
      roundRect(ctx, 0, 0, width, height, 24);
      ctx.fill();
      ctx.restore();
      const edge = ctx.createLinearGradient(0, 0, width, height);
      edge.addColorStop(0, "#FFF1B8");
      edge.addColorStop(0.5, GOLD);
      edge.addColorStop(1, "#FF8A3D");
      ctx.strokeStyle = edge;
      ctx.lineWidth = 3;
      roundRect(ctx, 1.5, 1.5, width - 3, height - 3, 23);
      ctx.stroke();
      // The crown, big, in a soft gold disc.
      ctx.fillStyle = withAlpha(GOLD, 0.2);
      ctx.beginPath();
      ctx.arc(46, height / 2, 32, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.shadowColor = withAlpha(GOLD, 0.9);
      ctx.shadowBlur = 12;
      crown(ctx, 46, height / 2 + 2, 40, GOLD);
      ctx.restore();
      sparkle(ctx, 66, height / 2 - 22, 12, "#FFF6D6");
      ctx.textBaseline = "alphabetic";
      ctx.font = headFont;
      ctx.fillStyle = GOLD;
      ctx.fillText("DONO DA LIVE", 90, 36);
      // The countdown in a chip, top right.
      ctx.fillStyle = withAlpha(GOLD, left <= 30 ? 0.34 : 0.18);
      roundRect(ctx, width - 14 - clockW, 16, clockW, 28, 14);
      ctx.fill();
      ctx.font = clockFont;
      ctx.textAlign = "center";
      ctx.fillStyle = left <= 30 ? "#FFF1B8" : GOLD;
      ctx.fillText(clock, width - 14 - clockW / 2, 36);
      ctx.textAlign = "left";
      ctx.save();
      ctx.shadowColor = withAlpha(GOLD, 0.85);
      ctx.shadowBlur = 14;
      ctx.font = shown.font;
      ctx.fillStyle = "#FFF1B8";
      ctx.fillText(shown.text, 90, 77);
      ctx.restore();
    });
  }
}

// ---- challenges and the raffle -------------------------------------------------------

/**
 * A challenge for the room or a raffle (ADR-0040), in the hook banner's
 * place under the character: it sits a little higher and is taller than
 * the hook (visible y 916 to 1040), above where the caption's first line
 * starts (y ~1070), and the hook steps aside while it's up.
 */
const CHALLENGE = { centerX: 540, top: 904, width: 920, height: 148, margin: 12 };
const CHALLENGE_COLORS: Record<Challenge["kind"], readonly [string, string]> = {
  likes: [HEART, GOLD],
  chat: ["#7CF5FF", "#B16CFF"],
  raffle: ["#4DFF9A", "#7CF5FF"],
};
/** The bar repaints at most this often while it moves. */
const BAR_FRAME_S = 1 / 30;

/** How full a challenge's bar is, 0 to 1: full once it's won; a raffle has no bar. */
export function challengeFraction(challenge: Pick<Challenge, "kind" | "value" | "target" | "result">): number {
  if (challenge.kind === "raffle") return 0;
  if (challenge.result === "won") return 1;
  return challenge.target > 0 ? Math.max(0, Math.min(1, challenge.value / challenge.target)) : 0;
}

/** The banner's big line and its second line, for each state: running, won, lost. */
export function challengeHeadline(challenge: Pick<Challenge, "kind" | "title" | "value" | "target" | "result" | "winner">): { title: string; line: string } {
  const count = `${formatCount(challenge.value)} / ${formatCount(challenge.target)}`;
  if (challenge.kind === "raffle") {
    const entries = `${formatCount(challenge.value)} ${challenge.value === 1 ? "participante" : "participantes"}`;
    if (challenge.result === "won") return { title: `GANHOU: ${challenge.winner ?? "alguém"}`, line: entries };
    if (challenge.result === "lost") return { title: "NINGUÉM PARTICIPOU", line: challenge.title };
    return { title: challenge.title, line: entries };
  }
  if (challenge.result === "won") return { title: "CONSEGUIMOS!", line: count };
  if (challenge.result === "lost") return { title: "QUASE!", line: count };
  return { title: challenge.title, line: count };
}

/** The challenge banner: a title, how to take part, a bar to the target (or the raffle's entries) and a countdown. */
export class ChallengeBanner {
  readonly sprite: TextSprite;
  readonly timer: TextSprite;
  private challenge: Challenge | null = null;
  private deadline = 0;
  private second = Number.NaN;
  private shownAt = 0;
  private readonly bar = new Spring(0, SPRINGS.gentle);
  private barPainted = -1;
  private barPaintedAt = 0;

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
    this.timer = new TextSprite(gl);
  }

  /** A challenge is up (the hook banner steps aside). */
  get active(): boolean {
    return this.challenge !== null;
  }

  set(challenge: Challenge | null, now: number, scale: number): void {
    const before = this.challenge;
    this.challenge = challenge;
    if (!challenge) {
      this.sprite.opacity.target = 0;
      this.timer.opacity.target = 0;
      return;
    }
    const fresh = !before || before.kind !== challenge.kind || before.title !== challenge.title || (before.result !== null && challenge.result === null);
    this.deadline = now + challenge.remainingMs / 1000;
    this.second = Number.NaN;
    this.bar.target = challengeFraction(challenge);
    if (fresh) {
      this.bar.snap(0);
      this.bar.target = challengeFraction(challenge);
      this.shownAt = now;
      this.sprite.opacity.snap(0);
      this.sprite.offsetY.snap(46);
      this.sprite.offsetY.target = 0;
      this.timer.opacity.snap(0);
      this.timer.offsetY.snap(46);
      this.timer.offsetY.target = 0;
    } else if (challenge.result !== null && before?.result === null) {
      // It just ended: a hop for the result.
      this.shownAt = now;
      this.sprite.offsetY.snap(-18);
      this.sprite.offsetY.target = 0;
    }
    this.paint(scale, now);
    this.paintTimer(now, scale);
  }

  /** `game` (0 to 1) is how far a game board has come in: the banner gives way to it. */
  update(dt: number, now: number, game: number, scale: number): void {
    const challenge = this.challenge;
    if (challenge) {
      const show = game > 0.05 ? 0 : 1;
      this.sprite.opacity.target = show;
      this.timer.opacity.target = challenge.result === null ? show : 0;
      if (now - this.shownAt > 0.6) {
        const bob = Math.sin((now - this.shownAt) * 3.2) * 4;
        this.sprite.offsetY.target = bob;
        this.timer.offsetY.target = bob;
      }
      this.bar.step(dt);
      const moved = Math.abs(this.bar.value - this.barPainted) > 0.004;
      if (moved && now - this.barPaintedAt >= BAR_FRAME_S) this.paint(scale, now);
      this.paintTimer(now, scale);
    }
    this.sprite.update(dt, now);
    this.timer.update(dt, now);
  }

  repaint(scale: number): void {
    if (!this.challenge) return;
    this.paint(scale, this.barPaintedAt);
    this.second = Number.NaN;
  }

  private paint(scale: number, now: number): void {
    const challenge = this.challenge as Challenge;
    const { width, height, margin } = CHALLENGE;
    const [a, b] = challenge.result === "won" ? ([GOLD, "#FF8A3D"] as const) : challenge.result === "lost" ? (["#FF7A8A", "#B16CFF"] as const) : CHALLENGE_COLORS[challenge.kind];
    const { title, line } = challengeHeadline(challenge);
    const fraction = Math.max(0, Math.min(1, this.bar.value));
    this.barPainted = this.bar.value;
    this.barPaintedAt = now;
    const running = challenge.result === null;
    const raffle = challenge.kind === "raffle";
    const titleFont = `900 36px ${FONT_FAMILY}`;
    const detailFont = `700 24px ${FONT_FAMILY}`;
    const lineFont = `850 25px ${FONT_FAMILY}`;
    // Room on the right of the title row for the countdown chip.
    const timerRoom = running ? 120 : 0;
    this.sprite.x = CHALLENGE.centerX - width / 2;
    this.sprite.y = CHALLENGE.top;
    this.sprite.draw(width, height, scale, (ctx) => {
      const w = width - margin * 2;
      const h = height - margin * 2;
      ctx.translate(margin, margin);
      ctx.save();
      ctx.shadowColor = withAlpha(a, 0.6);
      ctx.shadowBlur = margin;
      const body = ctx.createLinearGradient(0, 0, w, h);
      body.addColorStop(0, "rgba(22,8,46,0.92)");
      body.addColorStop(1, challenge.result === "won" ? "rgba(84,52,10,0.92)" : "rgba(12,6,30,0.9)");
      ctx.fillStyle = body;
      roundRect(ctx, 0, 0, w, h, 30);
      ctx.fill();
      ctx.restore();
      const edge = ctx.createLinearGradient(0, 0, w, 0);
      edge.addColorStop(0, a);
      edge.addColorStop(1, b);
      ctx.strokeStyle = edge;
      ctx.lineWidth = 3;
      roundRect(ctx, 1.5, 1.5, w - 3, h - 3, 29);
      ctx.stroke();

      // Title row: the kind's mark, the title, and (while it runs) how to take part.
      const markX = 40;
      const rowY = 38;
      ctx.fillStyle = withAlpha(a, 0.2);
      ctx.beginPath();
      ctx.arc(markX, rowY, 22, 0, Math.PI * 2);
      ctx.fill();
      challengeMark(ctx, challenge, markX, rowY, a);
      ctx.textBaseline = "middle";
      const titleRoom = w - 76 - 24 - timerRoom;
      const shownTitle = fit(title, titleFont, titleRoom);
      ctx.font = titleFont;
      ctx.save();
      ctx.shadowColor = withAlpha(a, 0.7);
      ctx.shadowBlur = 14;
      const fill = ctx.createLinearGradient(0, rowY - 18, 0, rowY + 18);
      fill.addColorStop(0, "#FFFFFF");
      fill.addColorStop(1, challenge.result === "won" ? GOLD : withAlpha(a, 1));
      ctx.fillStyle = fill;
      ctx.fillText(shownTitle, 76, rowY + 2);
      ctx.restore();
      const titleW = measureWith(titleFont)(shownTitle);
      if (running && !raffle && challenge.detail) {
        ctx.font = detailFont;
        ctx.fillStyle = HAZE;
        const room = titleRoom - titleW - 18;
        if (room > 60) ctx.fillText(fit(`· ${challenge.detail}`, detailFont, room), 76 + titleW + 14, rowY + 3);
      }

      // Second row: the bar to the target, or the raffle's entry word and count.
      const barX = 24;
      const barY = 74;
      const barW = w - 48;
      const barH = 38;
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      roundRect(ctx, barX, barY, barW, barH, barH / 2);
      ctx.fill();
      if (raffle) {
        if (running && challenge.detail) {
          // The word to type, big and bright, then the entries on the right.
          ctx.font = `900 24px ${FONT_FAMILY}`;
          const word = fit(challenge.detail.toUpperCase(), ctx.font, barW * 0.55);
          const pillW = measureWith(ctx.font)(word) + 36;
          ctx.fillStyle = withAlpha(a, 0.9);
          roundRect(ctx, barX + 4, barY + 4, pillW, barH - 8, (barH - 8) / 2);
          ctx.fill();
          ctx.fillStyle = "#06240F";
          ctx.fillText(word, barX + 22, barY + barH / 2 + 1);
          ctx.font = lineFont;
          ctx.textAlign = "right";
          ctx.fillStyle = INK;
          ctx.fillText(fit(line, lineFont, barW - pillW - 40), barX + barW - 18, barY + barH / 2 + 1);
          ctx.textAlign = "left";
        } else {
          ctx.font = lineFont;
          ctx.textAlign = "center";
          ctx.fillStyle = challenge.result === "won" ? GOLD : INK;
          ctx.fillText(fit(line, lineFont, barW - 40), barX + barW / 2, barY + barH / 2 + 1);
          ctx.textAlign = "left";
        }
      } else {
        if (fraction > 0) {
          const bar = ctx.createLinearGradient(barX, 0, barX + barW, 0);
          bar.addColorStop(0, withAlpha(a, challenge.result === "lost" ? 0.45 : 0.85));
          bar.addColorStop(1, withAlpha(b, challenge.result === "lost" ? 0.45 : 1));
          ctx.fillStyle = bar;
          roundRect(ctx, barX, barY, Math.max(barH, barW * fraction), barH, barH / 2);
          ctx.fill();
          // Light along the top of the fill.
          ctx.fillStyle = "rgba(255,255,255,0.22)";
          roundRect(ctx, barX + 6, barY + 4, Math.max(barH - 12, barW * fraction - 12), barH / 2 - 4, (barH / 2 - 4) / 2);
          ctx.fill();
        }
        ctx.font = lineFont;
        ctx.textAlign = "center";
        ctx.lineWidth = 5;
        ctx.lineJoin = "round";
        ctx.strokeStyle = "rgba(10,4,26,0.7)";
        ctx.strokeText(line, barX + barW / 2, barY + barH / 2 + 1);
        ctx.fillStyle = "#FFFFFF";
        ctx.fillText(line, barX + barW / 2, barY + barH / 2 + 1);
        ctx.textAlign = "left";
      }
      if (challenge.result === "won") {
        sparkle(ctx, w - 30, 22, 22, "#FFF6D6");
        sparkle(ctx, w - 62, 48, 13, "#FFF6D6");
        sparkle(ctx, 24, 18, 14, "#FFF6D6");
      }
    });
  }

  /** The countdown chip at the right end of the title row, repainted when its second changes. */
  private paintTimer(now: number, scale: number): void {
    const challenge = this.challenge;
    if (!challenge) return;
    const left = Math.max(0, Math.ceil(this.deadline - now - 1e-6));
    if (left === this.second) return;
    this.second = left;
    const text = formatClock(left);
    const font = `850 26px ${FONT_FAMILY}`;
    const width = Math.max(84, measureWith(font)(text) + 30);
    const height = 44;
    const soon = left <= 5;
    const color = soon ? "#FF5C6C" : CHALLENGE_COLORS[challenge.kind][0];
    const { margin } = CHALLENGE;
    this.timer.x = CHALLENGE.centerX + CHALLENGE.width / 2 - margin - 22 - width;
    this.timer.y = CHALLENGE.top + margin + 38 - height / 2;
    this.timer.draw(width, height, scale, (ctx) => {
      ctx.fillStyle = withAlpha(color, soon ? 0.32 : 0.2);
      roundRect(ctx, 0, 0, width, height, height / 2);
      ctx.fill();
      ctx.strokeStyle = withAlpha(color, 0.8);
      ctx.lineWidth = 2;
      roundRect(ctx, 1, 1, width - 2, height - 2, (height - 2) / 2);
      ctx.stroke();
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = soon ? "#FFD6DA" : INK;
      ctx.fillText(text, width / 2, height / 2 + 1);
    });
  }
}

/** The challenge's mark: a heart for likes, a speech bubble for chat, a ticket star for the raffle, a crown once it's won. */
function challengeMark(ctx: Canvas2D, challenge: Challenge, x: number, y: number, color: string): void {
  if (challenge.result === "won") {
    crown(ctx, x, y + 1, 26, color);
    return;
  }
  switch (challenge.kind) {
    case "likes":
      heart(ctx, x, y + 1, 24, color);
      return;
    case "chat":
      ctx.fillStyle = color;
      roundRect(ctx, x - 12, y - 10, 24, 17, 6);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 6, y + 6);
      ctx.lineTo(x - 9, y + 13);
      ctx.lineTo(x + 1, y + 6);
      ctx.closePath();
      ctx.fill();
      return;
    case "raffle":
      sparkle(ctx, x, y, 28, color);
      return;
  }
}
