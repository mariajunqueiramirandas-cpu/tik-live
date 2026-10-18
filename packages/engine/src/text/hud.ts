import type { GoalKind, GoalView, LeaderBoard, LeaderRow, SupportCard, SupportWay, UpNextItem } from "@tik-live/shared";
import { Spring, SPRINGS } from "../anim/spring";
import type { Gl } from "../gl/gl";
import { FONT_FAMILY, GOLD, HAZE, INK, measureWith, roundRect, TextSprite, truncate, withAlpha } from "./sprites";

/**
 * The show's heads-up panels (ADR-0028, ADR-0029), a narrow column top left
 * under the disclosure badge: a slim "A seguir" pill with a countdown, and
 * one ranking card that takes turns between the top likers and the top
 * gifters (or shows a vote while one is open, or for a moment how to
 * support the show, ADR-0032). The column stays left of the
 * character (x 375 at rest, 430 during games) and ends above where a game
 * board starts (y 560), clear of TikTok's header, right rail and comments.
 * Painted when content changes; the countdown repaints once a second and
 * the card crossfades when it turns. The stream's goals (ADR-0036) sit top
 * right, across from the title and above the alerts.
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

/** A chat vote shown in the card's place while it's open (ADR-0029). */
export interface HudVote {
  title: string;
  options: string[];
  tally: number[];
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

  private paintVote(vote: HudVote, scale: number, crossfade: boolean, now: number): void {
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

const GOALS = { right: 1080 - 64, top: 200, width: 300, rowH: 52, head: 42 };
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

  /** `game` is how far a game board has come in (0 to 1): the banner gives way to it. */
  update(dt: number, now: number, game: number): void {
    if (this.text) {
      this.sprite.opacity.target = game > 0.05 ? 0 : 1;
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
