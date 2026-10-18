import type { LeaderBoard, LeaderRow, SupportCard, SupportWay, UpNextItem } from "@tik-live/shared";
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
 * the card crossfades when it turns.
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
/** How long each ranking stays up before the card turns to the other one. */
const TURN_S = 8;

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

/** One card that takes turns between the top likers and the top gifters, or shows an open vote, or how to support the show. */
export class LeaderCard {
  readonly sprite: TextSprite;
  private readonly boards: Record<LeaderBoard, Board> = { likes: { rows: [], windowMin: 15 }, gifts: { rows: [], windowMin: 60 } };
  private showing: LeaderBoard | null = null;
  private vote: HudVote | null = null;
  private support: SupportCard | null = null;
  private turnedAt = 0;
  private visible = false;
  private readonly top = new Spring(TOP, SPRINGS.snappy);

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
  }

  set(board: LeaderBoard, rows: readonly LeaderRow[], windowMin: number, now: number, scale: number): void {
    this.boards[board] = { rows: rows.slice(0, 3), windowMin };
    if (this.vote || this.support) return;
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
    if (!this.vote && !this.support && this.showing && now - this.turnedAt >= TURN_S) {
      const next = nextBoard(this.showing, (b) => this.has(b));
      this.turnedAt = now;
      if (next !== this.showing) {
        this.showing = next;
        this.paint(scale, true, now);
      }
    }
    this.top.target = TOP + above;
    this.top.step(dt);
    this.sprite.y = this.top.value;
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    this.paint(scale, false, 0);
  }

  private has(board: LeaderBoard): boolean {
    return this.boards[board].rows.length > 0;
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

  private paintBoard(board: LeaderBoard, scale: number, crossfade: boolean, now: number): void {
    const { rows, windowMin } = this.boards[board];
    const gifts = board === "gifts";
    const color = gifts ? DIAMOND : HEART;
    const header = `${gifts ? "TOP PRESENTES" : "TOP CURTIDAS"} · ${windowLabel(windowMin)}`;
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
        glass(ctx, WIDTH, height, color, gifts ? GOLD : "#B16CFF", 20);
        if (gifts) diamond(ctx, PAD + 10, 29, 16, color);
        else heart(ctx, PAD + 10, 28, 17, color);
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
          if (gifts) diamond(ctx, WIDTH - PAD - countW - 14, cy + 1, 14, color);
          else heart(ctx, WIDTH - PAD - countW - 14, cy, 15, color);
        });
      },
      crossfade,
      now,
    );
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
