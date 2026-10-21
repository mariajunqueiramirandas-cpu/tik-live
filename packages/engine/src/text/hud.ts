import type { AlertKind, GoalKind, GoalView, LeaderBoard, LeaderRow, SupportCard, Ticker, UpNextItem } from "@tik-live/shared";
import { Spring, SPRINGS } from "../anim/spring";
import type { Gl } from "../gl/gl";
import {
  bar,
  BLEED,
  bubble,
  card,
  chip,
  CREAM,
  crown,
  CROWN_LABEL,
  crownTarget,
  CYAN,
  DEEP,
  diamond,
  DIAMOND,
  EMBER,
  fit,
  font,
  formatClock,
  formatCount,
  formatCountdown,
  goalFraction,
  goalLeft,
  goalNear,
  goalPercent,
  heart,
  HEART,
  HOT,
  HUD,
  type Mark,
  medal,
  outlined,
  paintPanel,
  PERK_PINK,
  pickHeader,
  place,
  play,
  plus,
  RAFFLE_GREEN,
  ringFraction,
  share,
  shrinkToFit,
  sparkle,
  star,
  sweep,
  tab,
  TAB_H,
  VIOLET,
  WAY_COLORS,
  WAY_MARKS,
  windowLabel,
  lineOrTwo,
  type Canvas2D,
} from "./kit";
import { GOLD, HAZE, INK, measureWith, roundRect, TextSprite, truncate, withAlpha } from "./sprites";

/**
 * The stage's side panels (ADR-0049), flanking the character under
 * TikTok's header:
 *
 * - top left, the show bar: the segment's title and the AI badge;
 * - the left column: what's up next on a countdown ring, then one ranking
 *   card that takes turns between the top likers and the top gifters (or a
 *   vote, one viewer's pick, or how to support the show), and the "dono da
 *   live" under it;
 * - the right column: the stream's goals, the support ticker under them,
 *   and alerts as name cards under that.
 *
 * Every card has a colored tab that says what it is, names and numbers
 * big enough to read on a phone, and a line that gives a reason to act or
 * to stay (what's left for the goal, what takes the crown). During a game
 * the panels fold to their essentials so the board has the stage.
 * Painted when content changes; anything that counts or fills repaints
 * at most 30 times a second while it moves.
 */

const COL = HUD.column;
const LEFT = HUD.margin;
const RIGHT_X = HUD.right - COL;
const PAD = 16;
/** How long each ranking stays up before the card turns to the other one. Gifters get longer. */
const TURN_S = 8;
const TURN_GIFTS_S = 12;
/** The top gifters' card: a light sweep this often, lasting this long. */
const SHINE_EVERY_S = 4.5;
const SHINE_S = 0.9;
/** Anything that moves repaints at most this often. */
const FRAME_S = 1 / 30;
/** How far the glow around the top gifters' card reaches past it. */
const AURA = 34;

function enter(sprite: TextSprite, wasHidden: boolean): void {
  if (wasHidden) {
    sprite.opacity.snap(0);
    sprite.offsetY.snap(-16);
  }
  sprite.opacity.target = 1;
  sprite.offsetY.target = 0;
}

// ---- the show bar ----------------------------------------------------------------

const TITLE = { size: 46, minSize: 36, maxWidth: 620, glow: 30 };

/** The segment's title, big, and the AI-disclosure badge under it (a legal requirement: always on). */
export class Chrome {
  readonly title: TextSprite;
  readonly badge: TextSprite;
  private titleText = "";
  private badgeText = "";
  private glow = CYAN;

  constructor(gl: Gl) {
    this.title = new TextSprite(gl);
    this.badge = new TextSprite(gl);
    this.badge.opacity.snap(1);
  }

  /** Where the badge ends (stage px): the now-playing chip sits right of it. */
  get badgeRight(): number {
    return this.badge.width > 0 ? this.badge.x + this.badge.width - BLEED : LEFT + 240;
  }

  setGlow(color: string, scale: number): void {
    this.glow = color;
    if (this.titleText) this.paintTitle(scale);
    if (this.badgeText) this.paintBadge(scale);
  }

  setTitle(text: string, scale: number): void {
    if (text === this.titleText) return;
    this.titleText = text;
    this.paintTitle(scale);
    this.title.opacity.snap(0);
    this.title.opacity.target = 1;
    this.title.offsetX.snap(-40);
    this.title.offsetX.target = 0;
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
    // Long titles shrink a little first, then squeeze into the room left of the goals.
    let size = TITLE.size;
    while (size > TITLE.minSize && measureWith(font(820, size))(this.titleText) > TITLE.maxWidth) size -= 1;
    const f = font(820, size);
    const pad = TITLE.glow;
    const width = Math.min(TITLE.maxWidth, measureWith(f)(this.titleText)) + pad * 2;
    this.title.x = LEFT - pad;
    this.title.y = HUD.titleTop - pad;
    const glow = this.glow;
    const text = this.titleText;
    this.title.draw(width, TITLE.size * 1.2 + pad * 2, scale, (ctx) => {
      ctx.font = f;
      ctx.textBaseline = "alphabetic";
      ctx.shadowColor = withAlpha(glow, 0.6);
      ctx.shadowBlur = 24;
      ctx.fillStyle = INK;
      ctx.fillText(text, pad, pad + TITLE.size * 0.95, TITLE.maxWidth);
      ctx.shadowColor = "rgba(5,2,18,0.6)";
      ctx.shadowBlur = 8;
      ctx.fillText(text, pad, pad + TITLE.size * 0.95, TITLE.maxWidth);
    });
  }

  private paintBadge(scale: number): void {
    const f = font(760, 26);
    const text = this.badgeText;
    const height = 42;
    const width = measureWith(f)(text) + 64;
    const glow = this.glow;
    place(this.badge, LEFT, HUD.badgeTop);
    paintPanel(this.badge, width, height, scale, (ctx) => {
      ctx.fillStyle = "rgba(16,8,40,0.72)";
      roundRect(ctx, 0, 0, width, height, height / 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(244,240,255,0.34)";
      ctx.lineWidth = 1.5;
      roundRect(ctx, 0.75, 0.75, width - 1.5, height - 1.5, (height - 1.5) / 2);
      ctx.stroke();
      sparkle(ctx, 24, height / 2, 20, glow);
      ctx.font = f;
      ctx.textBaseline = "middle";
      ctx.fillStyle = INK;
      ctx.fillText(text, 42, height / 2 + 1);
    });
  }
}

// ---- up next ---------------------------------------------------------------------

const NEXT = { height: 100, ring: 84, radius: 34, line: 9 };
/** Under a minute the ring turns gold, in the last seconds it turns hot and pulses every second. */
const NEXT_SOON_S = 60;
const NEXT_FINAL_S = 10;

type NextMood = "calm" | "soon" | "final" | "due";

/** How urgent the countdown looks, from the seconds left. */
export function nextMood(left: number): NextMood {
  if (left <= 0) return "due";
  if (left <= NEXT_FINAL_S) return "final";
  return left <= NEXT_SOON_S ? "soon" : "calm";
}

/** What the card calls the thing up next. */
export function nextLabel(kind: UpNextItem["kind"], due: boolean): string {
  if (due) return "COMEÇA JÁ JÁ";
  if (kind === "game") return "PRÓXIMO JOGO";
  return kind === "podium" ? "PÓDIO DA RODADA" : "A SEGUIR";
}

/**
 * What's next on the show, on a ring that drains as it gets close: calm in
 * the host's color, gold under a minute, hot and pulsing every second at
 * the end. An open loop on screen at all times: the reason to stay a few
 * minutes more.
 */
export class UpNext {
  readonly card: TextSprite;
  readonly ring: TextSprite;
  private item: UpNextItem | null = null;
  /** When it's due, on the stage clock (seconds), and how long the ring had when it was set. */
  private deadline = 0;
  private total = 1;
  private mood: NextMood = "calm";
  private ringPaintedAt = -1;
  private second = Number.NaN;
  private primary = CYAN;

  constructor(gl: Gl) {
    this.card = new TextSprite(gl);
    this.ring = new TextSprite(gl);
  }

  /** The room it takes in the column (0 when hidden). */
  get height(): number {
    return this.item ? NEXT.height + HUD.gap : 0;
  }

  setColors(primary: string, _secondary: string, scale: number): void {
    this.primary = primary;
    this.repaint(scale);
  }

  set(items: readonly UpNextItem[], now: number, scale: number): void {
    const next = items[0] ?? null;
    const before = this.item;
    this.item = next;
    if (!next) {
      this.card.opacity.target = 0;
      this.ring.opacity.target = 0;
      return;
    }
    const fresh = !before || before.kind !== next.kind || before.title !== next.title;
    const left = next.inMs / 1000;
    this.deadline = now + left;
    if (fresh || left > this.total) this.total = Math.max(1, left);
    this.mood = nextMood(left);
    this.paintCard(scale, fresh && before !== null, now);
    this.paintRing(now, scale);
    enter(this.card, before === null);
    enter(this.ring, before === null);
    if (fresh && before) this.card.pop(1.06);
  }

  update(dt: number, now: number, scale: number): void {
    if (this.item) {
      const left = this.deadline - now;
      const mood = nextMood(left);
      if (mood !== this.mood) {
        this.mood = mood;
        this.paintCard(scale, true, now);
      }
      const second = Math.ceil(left);
      if (second !== this.second) {
        // A beat on every second at the end, and a slow one while it's due.
        if (mood === "final") this.ring.pop(1.16);
        else if (mood === "due" && second % 2 === 0) this.ring.pop(1.07);
      }
      // The ring drains smoothly at the end; before that a step a second is enough.
      if (second !== this.second || (mood === "final" && now - this.ringPaintedAt >= FRAME_S)) this.paintRing(now, scale);
    }
    this.card.update(dt, now);
    this.ring.update(dt, now);
  }

  repaint(scale: number): void {
    if (!this.item) return;
    this.paintCard(scale, false, 0);
    this.second = Number.NaN;
  }

  private color(): string {
    if (this.item?.kind === "podium") return GOLD;
    switch (this.mood) {
      case "calm":
        return this.primary;
      case "soon":
        return GOLD;
      default:
        return EMBER;
    }
  }

  private paintCard(scale: number, crossfade: boolean, now: number): void {
    const item = this.item as UpNextItem;
    const color = this.color();
    const textX = NEXT.ring + 26;
    const room = COL - textX - PAD;
    const label = shrinkToFit(nextLabel(item.kind, this.mood === "due"), 880, 22, 18, room);
    const title = shrinkToFit(item.title, 820, 31, 22, room);
    place(this.card, LEFT, HUD.leftTop);
    paintPanel(
      this.card,
      COL,
      NEXT.height,
      scale,
      (ctx) => {
        card(ctx, COL, NEXT.height, color, VIOLET);
        ctx.textBaseline = "alphabetic";
        ctx.font = label.font;
        ctx.fillStyle = color;
        ctx.fillText(label.text, textX, 40);
        ctx.font = title.font;
        ctx.fillStyle = INK;
        ctx.fillText(title.text, textX, 76);
      },
      crossfade,
      now,
    );
  }

  /** The ring and the time in it. */
  private paintRing(now: number, scale: number): void {
    const item = this.item as UpNextItem;
    const left = Math.max(0, this.deadline - now);
    this.second = Math.ceil(this.deadline - now);
    this.ringPaintedAt = now;
    const color = this.color();
    const size = NEXT.ring;
    const c = size / 2;
    const fraction = this.mood === "due" ? 1 : ringFraction(left, this.total);
    place(this.ring, LEFT + 10, HUD.leftTop + (NEXT.height - size) / 2);
    paintPanel(this.ring, size, size, scale, (ctx) => {
      ctx.lineCap = "round";
      ctx.lineWidth = NEXT.line;
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.arc(c, c, NEXT.radius, 0, Math.PI * 2);
      ctx.stroke();
      if (fraction > 0.002) {
        ctx.save();
        ctx.shadowColor = withAlpha(color, 0.85);
        ctx.shadowBlur = 10;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(c, c, NEXT.radius, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (this.mood === "due") {
        // It's due: a play mark (the board says "já já").
        (item.kind === "podium" ? crown : play)(ctx, c + (item.kind === "podium" ? 0 : 3), c, 30, color);
        return;
      }
      // Under a minute, just the seconds, bigger.
      const s = Math.ceil(left);
      const text = s < 60 ? String(s) : formatCountdown(s);
      const shown = shrinkToFit(text, 900, s < 60 ? 34 : 24, 17, NEXT.radius * 2 - NEXT.line - 6);
      ctx.font = shown.font;
      ctx.fillStyle = this.mood === "calm" ? INK : color;
      ctx.fillText(shown.text, c, c + 2);
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

/** Which ranking the card shows next: the other one when it has rows, else whichever does. */
export function nextBoard(current: LeaderBoard | null, hasRows: (board: LeaderBoard) => boolean): LeaderBoard | null {
  const other: LeaderBoard = current === "likes" ? "gifts" : "likes";
  if (current && hasRows(other)) return other;
  if (current && hasRows(current)) return current;
  if (hasRows("likes")) return "likes";
  return hasRows("gifts") ? "gifts" : null;
}

/** Whether a gift just came in for the gifters shown: their diamonds grew. Gifts aging out of the window only shrink them. */
export function giftCameIn(before: readonly LeaderRow[], after: readonly LeaderRow[]): boolean {
  const total = (rows: readonly LeaderRow[]) => rows.reduce((sum, row) => sum + row.value, 0);
  return total(after) > total(before);
}

/** The vote's tab: what to type. */
export function voteTab(options: number): string {
  return options <= 2 ? "VOTE: DIGITE 1 OU 2" : `VOTE: DIGITE 1 A ${options}`;
}

/** Where the top gifters' card twinkles (fractions of its size), and each twinkle's phase in the sweep. */
const TWINKLES = [
  { x: 0.9, y: 0.06, size: 14, phase: 0.15 },
  { x: 0.64, y: 0.04, size: 9, phase: 0.45 },
  { x: 0.97, y: 0.46, size: 10, phase: 0.7 },
  { x: 0.03, y: 0.6, size: 9, phase: 0.3 },
  { x: 0.5, y: 0.98, size: 11, phase: 0.85 },
] as const;

/** How bright a twinkle is, 0.35 at rest up to 1 as the light sweep passes it. */
export function twinkle(shine: number | null, phase: number): number {
  if (shine === null) return 0.35;
  return 0.35 + 0.65 * Math.max(0, 1 - Math.abs(shine - phase) * 4);
}

/**
 * One card that takes turns between the top likers and the top gifters, or
 * shows an open vote, one viewer's pick, or how to support the show. The
 * top gifters get the loud version: gold, a crowned first place on a
 * banner, a glow that breathes around the card, a light sweep now and then,
 * and they cut in whenever a gift comes in. Each ranking ends with how to
 * climb it. During a game only the tab and first place stay.
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
  private compact = false;
  private body = 0;
  private readonly top = new Spring(HUD.leftTop, SPRINGS.snappy);
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
      this.sprite.pop(1.05);
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
    const opened = vote !== null && this.vote === null;
    this.vote = vote;
    if (!vote) this.showing = nextBoard(null, (b) => this.has(b));
    this.turnedAt = now;
    this.paint(scale, crossfade, now);
    if (opened && crossfade) this.sprite.pop(1.06);
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
    return this.visible ? this.top.target + this.body : HUD.leftTop + above - (above ? HUD.gap : 0);
  }

  /** `above` is the room up next takes over this card; `compact` folds it for a game. */
  update(dt: number, now: number, above: number, compact: boolean, scale: number): void {
    if (compact !== this.compact) {
      this.compact = compact;
      if (this.visible) this.paint(scale, true, now);
    }
    if (!this.vote && !this.support && this.showing && now - this.turnedAt >= (this.showsGifts() ? TURN_GIFTS_S : TURN_S)) {
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
      if (p <= 1 && now - this.shinePaintedAt >= FRAME_S) {
        this.shinePainted = p;
        this.shinePaintedAt = now;
        this.paintGifts(scale, false, now, p);
      } else if (p > 1 && this.shinePainted >= 0) {
        this.shinePainted = -1;
        this.paintGifts(scale, false, now, null);
      }
    }
    this.top.target = HUD.leftTop + above;
    this.top.step(dt);
    place(this.sprite, LEFT, this.top.value);
    this.sprite.update(dt, now);
    // The glow breathes, and flares when a gift cuts in.
    const flare = Math.max(0, 1 - (now - this.flashAt) / 1.5);
    const glow = this.showsGifts() && this.visible ? Math.min(1, 0.7 + 0.3 * Math.sin(now * 2.6) + flare) : 0;
    this.aura.x = LEFT - AURA;
    this.aura.y = this.top.value + this.sprite.offsetY.value - AURA;
    this.aura.zoom.snap(this.sprite.zoom.value);
    this.aura.opacity.snap(glow * Math.min(1, Math.max(0, this.sprite.opacity.value)));
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
    const fade = crossfade && !wasHidden;
    if (vote?.by) this.paintPick(vote as HudVote & { by: string }, scale, fade, now);
    else if (vote) this.paintVote(vote, scale, fade, now);
    else if (support) this.paintSupport(support, scale, fade, now);
    else if (board === "gifts") this.paintGifts(scale, fade, now, null);
    else this.paintLikes(scale, fade, now);
    if (wasHidden) this.top.snap(this.top.target);
    enter(this.sprite, wasHidden);
  }

  private draw(height: number, scale: number, paint: (ctx: Canvas2D) => void, crossfade: boolean, now: number): void {
    this.body = height;
    paintPanel(this.sprite, COL, height, scale, paint, crossfade, now);
  }

  /** The top likers: pink, and how to climb. */
  private paintLikes(scale: number, crossfade: boolean, now: number): void {
    const { rows: all, windowMin } = this.boards.likes;
    const rows = this.compact ? all.slice(0, 1) : all;
    const head = 66;
    const rowH = 48;
    const foot = this.compact ? 6 : 50;
    const height = head + rows.length * rowH + foot;
    const countFont = font(900, 26);
    const counts = rows.map((row) => formatCount(row.value));
    const countW = Math.max(...counts.map((text) => measureWith(countFont)(text)));
    const nameRoom = COL - 58 - PAD - countW - 30;
    this.draw(
      height,
      scale,
      (ctx) => {
        card(ctx, COL, height, HEART, VIOLET);
        tab(ctx, PAD, PAD, "TOP CURTIDAS", HEART, heart);
        chip(ctx, COL - PAD, PAD, windowLabel(windowMin), HAZE);
        rows.forEach((row, i) => {
          const cy = head + i * rowH + rowH / 2;
          medal(ctx, PAD + 16, cy, 16, i + 1);
          const name = shrinkToFit(row.name, 780, 28, 21, nameRoom);
          ctx.font = name.font;
          ctx.fillStyle = INK;
          ctx.fillText(name.text, 58, cy + 10);
          ctx.font = countFont;
          ctx.textAlign = "right";
          ctx.fillStyle = i === 0 ? HEART : INK;
          ctx.fillText(counts[i] as string, COL - PAD, cy + 9);
          ctx.textAlign = "left";
          heart(ctx, COL - PAD - countW - 15, cy, 17, HEART);
        });
        if (!this.compact) footer(ctx, head + rows.length * rowH, height, heart, HEART, "Toque na tela pra subir");
      },
      crossfade,
      now,
    );
  }

  /** The top gifters, loud: gold edges, a crowned first place on a banner, twinkles and a light sweep (`shine` 0 to 1), and what takes the crown. */
  private paintGifts(scale: number, crossfade: boolean, now: number, shine: number | null): void {
    const { rows: all, windowMin } = this.boards.gifts;
    const rows = this.compact ? all.slice(0, 1) : all;
    const head = 62;
    const champH = 60;
    const rowH = 46;
    const foot = this.compact ? 4 : 52;
    const height = head + champH + 6 + Math.max(0, rows.length - 1) * rowH + foot;
    const champCountFont = font(900, 28);
    const countFont = font(850, 24);
    const counts = rows.map((row) => formatCount(row.value));
    const champCountW = measureWith(champCountFont)(counts[0] ?? "");
    const countW = Math.max(0, ...counts.slice(1).map((text) => measureWith(countFont)(text)));
    const top = rows[0]?.value ?? 0;
    this.paintAura(height, scale);
    this.draw(
      height,
      scale,
      (ctx) => {
        // A richer body: deep purple warming toward gold at the bottom (the glow around it is the aura's).
        const body = ctx.createLinearGradient(0, 0, 0, height);
        body.addColorStop(0, "rgba(36,12,64,0.94)");
        body.addColorStop(1, "rgba(64,34,18,0.92)");
        ctx.fillStyle = body;
        roundRect(ctx, 0, 0, COL, height, 26);
        ctx.fill();
        const edge = ctx.createLinearGradient(0, 0, COL, height);
        edge.addColorStop(0, GOLD);
        edge.addColorStop(0.5, "#FF7AC8");
        edge.addColorStop(1, DIAMOND);
        ctx.strokeStyle = edge;
        ctx.lineWidth = 3;
        roundRect(ctx, 1.5, 1.5, COL - 3, height - 3, 25);
        ctx.stroke();

        const gold = ctx.createLinearGradient(0, PAD, 0, PAD + TAB_H);
        gold.addColorStop(0, CREAM);
        gold.addColorStop(1, GOLD);
        tab(ctx, PAD, PAD, "TOP DOADORES", gold, crown);
        chip(ctx, COL - PAD, PAD, windowLabel(windowMin), DIAMOND);

        rows.forEach((row, i) => {
          if (i === 0) {
            // First place: a golden banner, a crowned medal, and the biggest letters on the card.
            const y = head;
            const banner = ctx.createLinearGradient(PAD, 0, COL - PAD, 0);
            banner.addColorStop(0, withAlpha(GOLD, 0.42));
            banner.addColorStop(1, withAlpha(EMBER, 0.12));
            ctx.fillStyle = banner;
            roundRect(ctx, 8, y, COL - 16, champH, 18);
            ctx.fill();
            ctx.strokeStyle = withAlpha(GOLD, 0.75);
            ctx.lineWidth = 1.5;
            roundRect(ctx, 8.75, y + 0.75, COL - 17.5, champH - 1.5, 17);
            ctx.stroke();
            const cy = y + champH / 2;
            medal(ctx, PAD + 18, cy + 4, 17, 1);
            crown(ctx, PAD + 18, cy - 16, 18, CREAM);
            const name = shrinkToFit(row.name, 850, 32, 22, COL - 64 - PAD - champCountW - 32);
            ctx.save();
            ctx.shadowColor = withAlpha(GOLD, 0.8);
            ctx.shadowBlur = 12;
            ctx.font = name.font;
            ctx.fillStyle = CREAM;
            ctx.fillText(name.text, 60, cy + 11);
            ctx.restore();
            ctx.font = champCountFont;
            ctx.textAlign = "right";
            ctx.fillStyle = GOLD;
            ctx.fillText(counts[0] as string, COL - PAD - 4, cy + 10);
            ctx.textAlign = "left";
            diamond(ctx, COL - PAD - 4 - champCountW - 16, cy + 1, 19, DIAMOND);
            return;
          }
          const cy = head + champH + 6 + (i - 1) * rowH + rowH / 2;
          medal(ctx, PAD + 18, cy, 15, i + 1);
          const name = shrinkToFit(row.name, 780, 26, 20, COL - 60 - PAD - countW - 30);
          ctx.font = name.font;
          ctx.fillStyle = INK;
          ctx.fillText(name.text, 60, cy + 9);
          ctx.font = countFont;
          ctx.textAlign = "right";
          ctx.fillStyle = DIAMOND;
          ctx.fillText(counts[i] as string, COL - PAD - 4, cy + 8);
          ctx.textAlign = "left";
          diamond(ctx, COL - PAD - 4 - countW - 15, cy + 1, 15, DIAMOND);
        });

        if (!this.compact) {
          // What takes the crown: past first place's diamonds.
          footer(ctx, height - foot, height, crown, GOLD, CROWN_LABEL, CREAM, COL - PAD * 2 - 30 - measureWith(font(900, 23))(crownTarget(top)) - 30);
          const cy = height - foot / 2 + 2;
          ctx.font = font(900, 23);
          ctx.textAlign = "right";
          ctx.fillStyle = GOLD;
          ctx.fillText(crownTarget(top), COL - PAD, cy + 8);
          ctx.textAlign = "left";
          diamond(ctx, COL - PAD - measureWith(font(900, 23))(crownTarget(top)) - 14, cy + 1, 17, DIAMOND);
        }
        for (const t of TWINKLES) sparkle(ctx, t.x * COL, t.y * height, t.size, withAlpha("#FFF6D6", twinkle(shine, t.phase)));
        if (shine !== null) sweep(ctx, 0, 0, COL, height, 26, shine, 0.28);
      },
      crossfade,
      now,
    );
  }

  /** The soft gold glow behind the gifters' card, repainted only when the card's height changes. */
  private paintAura(height: number, scale: number): void {
    if (height === this.auraHeight) return;
    this.auraHeight = height;
    const w = COL + AURA * 2;
    const h = height + AURA * 2;
    this.aura.draw(w, h, scale, (ctx) => {
      // Two passes, a wide warm halo and a tighter bright one, kept inside the texture so it never shows an edge.
      for (const [blur, alpha] of [
        [24, 0.7],
        [10, 0.85],
      ] as const) {
        ctx.save();
        ctx.shadowColor = withAlpha(GOLD, alpha);
        ctx.shadowBlur = blur;
        ctx.fillStyle = withAlpha(GOLD, alpha);
        roundRect(ctx, AURA, AURA, COL, height, 26);
        ctx.fill();
        ctx.restore();
      }
    });
  }

  /** How to support the show (ADR-0032). */
  private paintSupport(support: SupportCard, scale: number, crossfade: boolean, now: number): void {
    const lines = support.lines.slice(0, this.compact ? 1 : 4);
    const head = this.compact ? 62 : 104;
    const room = COL - PAD * 2 - 46;
    // Long lines take two rows instead of being cut.
    const texts = lines.map((line) => lineOrTwo(line.text, 760, 24, 21, 22, 18, room));
    const rows = texts.map((text) => (text.lines.length > 1 ? 64 : 46));
    const height = head + rows.reduce((sum, h) => sum + h, 0) + 10;
    this.draw(
      height,
      scale,
      (ctx) => {
        card(ctx, COL, height, GOLD, HEART);
        tab(ctx, PAD, PAD, "APOIE A LIVE", GOLD, diamond);
        if (!this.compact) {
          const title = shrinkToFit(support.title, 800, 27, 21, COL - PAD * 2);
          ctx.font = title.font;
          ctx.fillStyle = INK;
          ctx.fillText(title.text, PAD, 88);
        }
        let y = head;
        lines.forEach((line, i) => {
          const rowH = rows[i] as number;
          const cy = y + rowH / 2;
          y += rowH;
          const color = WAY_COLORS[line.way];
          ctx.fillStyle = withAlpha(color, 0.18);
          ctx.beginPath();
          ctx.arc(PAD + 17, cy, 17, 0, Math.PI * 2);
          ctx.fill();
          WAY_MARKS[line.way](ctx, PAD + 17, cy, 18, color);
          const text = texts[i] as ReturnType<typeof lineOrTwo>;
          ctx.font = text.font;
          ctx.fillStyle = line.way === "gift" ? GOLD : INK;
          const lineH = text.size * 1.12;
          const first = cy - ((text.lines.length - 1) * lineH) / 2 + text.size * 0.36;
          text.lines.forEach((row, k) => ctx.fillText(row, PAD + 46, first + k * lineH));
        });
      },
      crossfade,
      now,
    );
  }

  /** One viewer chooses (a gift power or the raffle's prize): their name on the tab, the options numbered, no tally. */
  private paintPick(vote: HudVote & { by: string }, scale: number, crossfade: boolean, now: number): void {
    const options = this.compact ? [] : vote.options.slice(0, 3);
    const head = this.compact ? 62 : 102;
    const rowH = 48;
    const foot = 48;
    const height = head + options.length * rowH + foot;
    this.draw(
      height,
      scale,
      (ctx) => {
        card(ctx, COL, height, GOLD, EMBER);
        tab(ctx, PAD, PAD, fit(pickHeader(vote.by), font(900, 22), COL - PAD * 2 - 58), GOLD, crown);
        if (!this.compact) {
          const title = shrinkToFit(vote.title, 800, 27, 21, COL - PAD * 2);
          ctx.font = title.font;
          ctx.fillStyle = INK;
          ctx.fillText(title.text, PAD, 86);
        }
        options.forEach((option, i) => {
          const y = head + i * rowH;
          ctx.fillStyle = "rgba(255,255,255,0.07)";
          roundRect(ctx, PAD - 4, y + 3, COL - PAD * 2 + 8, rowH - 6, 14);
          ctx.fill();
          // The number in a gold disc: that's what they type.
          ctx.fillStyle = GOLD;
          ctx.beginPath();
          ctx.arc(PAD + 16, y + rowH / 2, 15, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = font(900, 19);
          ctx.textAlign = "center";
          ctx.fillStyle = DEEP;
          ctx.fillText(String(i + 1), PAD + 16, y + rowH / 2 + 7);
          ctx.textAlign = "left";
          const text = shrinkToFit(option, 760, 24, 19, COL - PAD * 2 - 46);
          ctx.font = text.font;
          ctx.fillStyle = INK;
          ctx.fillText(text.text, PAD + 42, y + rowH / 2 + 8);
        });
        const hint = shrinkToFit(`${vote.by}, digite o número no chat`, 760, 22, 18, COL - PAD * 2);
        ctx.font = hint.font;
        ctx.fillStyle = GOLD;
        ctx.fillText(hint.text, PAD, height - 18);
      },
      crossfade,
      now,
    );
  }

  /** Chat's vote: what to type on the tab, a bar per option, the leader in gold. In a game, only the leader. */
  private paintVote(vote: HudVote, scale: number, crossfade: boolean, now: number): void {
    const all = vote.options.slice(0, 3);
    const total = vote.tally.reduce((sum, n) => sum + n, 0);
    const lead = total ? vote.tally.indexOf(Math.max(...vote.tally)) : -1;
    const shown = this.compact ? [Math.max(0, lead)] : all.map((_, i) => i);
    const head = this.compact ? 62 : 102;
    const rowH = 50;
    const height = head + shown.length * rowH + 10;
    this.draw(
      height,
      scale,
      (ctx) => {
        card(ctx, COL, height, GOLD, "#FF5FA2");
        tab(ctx, PAD, PAD, voteTab(all.length), GOLD, bubble);
        if (!this.compact) {
          const title = shrinkToFit(vote.title, 800, 27, 21, COL - PAD * 2);
          ctx.font = title.font;
          ctx.fillStyle = INK;
          ctx.fillText(title.text, PAD, 86);
        }
        shown.forEach((index, row) => {
          const y = head + row * rowH;
          const share = total ? (vote.tally[index] ?? 0) / total : 0;
          const leading = index === lead;
          const w = COL - PAD * 2 + 8;
          ctx.fillStyle = "rgba(255,255,255,0.07)";
          roundRect(ctx, PAD - 4, y + 3, w, rowH - 6, 14);
          ctx.fill();
          if (share > 0) {
            ctx.fillStyle = withAlpha(leading ? GOLD : VIOLET, 0.42);
            roundRect(ctx, PAD - 4, y + 3, Math.max(28, w * share), rowH - 6, 14);
            ctx.fill();
          }
          ctx.fillStyle = leading ? GOLD : "rgba(244,240,255,0.85)";
          ctx.beginPath();
          ctx.arc(PAD + 16, y + rowH / 2, 15, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = font(900, 19);
          ctx.textAlign = "center";
          ctx.fillStyle = DEEP;
          ctx.fillText(String(index + 1), PAD + 16, y + rowH / 2 + 7);
          ctx.textAlign = "right";
          ctx.font = font(900, 24);
          ctx.fillStyle = leading ? GOLD : INK;
          const pct = total ? `${Math.round(share * 100)}%` : "";
          ctx.fillText(pct, COL - PAD, y + rowH / 2 + 9);
          ctx.textAlign = "left";
          const text = shrinkToFit(all[index] ?? "", 760, 24, 19, COL - PAD * 2 - 46 - (pct ? 62 : 0));
          ctx.font = text.font;
          ctx.fillStyle = INK;
          ctx.fillText(text.text, PAD + 42, y + rowH / 2 + 8);
        });
      },
      crossfade,
      now,
    );
  }
}

/** A card's last line: a hairline, a mark and a call to act (in `room` px). */
function footer(ctx: Canvas2D, y: number, height: number, mark: Mark, color: string, text: string, textColor = color, room = COL - PAD * 2 - 30): void {
  ctx.fillStyle = "rgba(255,255,255,0.09)";
  ctx.fillRect(PAD, y + 2, COL - PAD * 2, 1.5);
  const cy = (y + height) / 2 + 2;
  mark(ctx, PAD + 11, cy, 19, color);
  const line = shrinkToFit(text, 780, 22, 18, room);
  ctx.font = line.font;
  ctx.fillStyle = textColor;
  ctx.fillText(line.text, PAD + 30, cy + 8);
}

// ---- the stream's goals ----------------------------------------------------------

/** How long a goal just reached shows "META BATIDA!" before the next goal. */
const CELEBRATE_S = 4;
/** Near a goal, a light runs along its bar this often, lasting this long. */
const NEAR_SWEEP_EVERY_S = 1.8;
const NEAR_SWEEP_S = 0.7;
/**
 * The goal panel repaints at most this often while a bar fills or a light
 * runs along it. Likes arrive a few times a second in a storm, so small
 * steps jump instead of animating: the cloud broadcaster paints in software.
 */
const GOAL_FRAME_S = 1 / 20;
const GOAL_STEP = 0.02;
const GOAL_LOOK: Record<GoalKind, { label: string; color: string; color2: string; mark: Mark }> = {
  likes: { label: "CURTIDAS", color: HEART, color2: "#FF9AD5", mark: heart },
  gifts: { label: "DIAMANTES", color: DIAMOND, color2: "#B8F0FF", mark: diamond },
};

/**
 * The like and gift goals (ADR-0036), top right: a bar each that fills with
 * a spring as they come in and says what's left ("FALTAM 1.760"). Near the
 * goal it says "QUASE!" and a light runs along the bar; reaching it turns
 * the bar gold with a pop. In a game, just the bars.
 */
export class GoalPanel {
  readonly sprite: TextSprite;
  private goals: GoalView[] = [];
  /** Until when (stage clock, seconds) each goal just reached shows its celebration. */
  private readonly celebrating = new Map<GoalKind, number>();
  private readonly fill: Record<GoalKind, Spring> = { likes: new Spring(0, SPRINGS.gentle), gifts: new Spring(0, SPRINGS.gentle) };
  private readonly painted: Record<GoalKind, number> = { likes: -1, gifts: -1 };
  private paintedAt = 0;
  private sweepPainted = false;
  private compact = false;
  private body = 0;

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
  }

  set(goals: readonly GoalView[], now: number, scale: number): void {
    const wasHidden = this.goals.length === 0;
    let reached = false;
    for (const goal of goals) {
      const before = this.goals.find((old) => old.kind === goal.kind);
      if (before && goal.level > before.level) {
        this.celebrating.set(goal.kind, now + CELEBRATE_S);
        reached = true;
      }
      const spring = this.fill[goal.kind];
      const fraction = goalFraction(goal);
      if (!before || Math.abs(fraction - spring.value) < GOAL_STEP) spring.snap(fraction);
      else if (!this.celebrating.has(goal.kind)) spring.target = fraction;
    }
    this.goals = goals.slice(0, 2);
    if (this.goals.length === 0) {
      this.celebrating.clear();
      this.sprite.opacity.target = 0;
      return;
    }
    this.paint(now, scale);
    if (wasHidden) enter(this.sprite, true);
    else if (reached) this.sprite.pop(1.1);
  }

  update(dt: number, now: number, compact: boolean, scale: number): void {
    let dirty = false;
    let crossfade = false;
    if (compact !== this.compact) {
      this.compact = compact;
      dirty = crossfade = true;
    }
    // Only while a goal celebrates (the map is empty otherwise).
    if (this.celebrating.size) for (const [kind, until] of this.celebrating) {
      if (until > now) continue;
      this.celebrating.delete(kind);
      // The next goal starts where its count already is.
      const goal = this.goals.find((g) => g.kind === kind);
      if (goal) this.fill[kind].snap(goalFraction(goal));
      dirty = crossfade = true;
    }
    let moving = false;
    for (let i = 0; i < this.goals.length; i++) {
      const kind = (this.goals[i] as GoalView).kind;
      const spring = this.fill[kind];
      spring.step(dt);
      if (Math.abs(spring.value - this.painted[kind]) > 0.003) moving = true;
    }
    const sweeping = this.sweepAt(now) !== null;
    if (this.goals.length) {
      if (dirty) this.paint(now, scale, crossfade);
      else if ((moving || sweeping || this.sweepPainted) && now - this.paintedAt >= GOAL_FRAME_S) this.paint(now, scale);
    }
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.goals.length) this.paint(this.paintedAt, scale);
  }

  /** Where the panel ends (stage px), or where it would start when there are no goals. */
  bottom(): number {
    return this.goals.length ? HUD.rightTop + this.body : HUD.rightTop;
  }

  /** The light along a near goal's bar, 0 to 1, or null between sweeps (or when no goal is near). Runs every frame: no closures. */
  private sweepAt(now: number): number | null {
    let near = false;
    for (let i = 0; i < this.goals.length; i++) {
      const goal = this.goals[i] as GoalView;
      if (goalNear(goal) && !this.celebrating.has(goal.kind)) near = true;
    }
    if (!near) return null;
    const p = (now % NEAR_SWEEP_EVERY_S) / NEAR_SWEEP_S;
    return p <= 1 ? p : null;
  }

  private paint(now: number, scale: number, crossfade = false): void {
    const goals = this.goals;
    const compact = this.compact;
    const shine = this.sweepAt(now);
    this.sweepPainted = shine !== null;
    this.paintedAt = now;
    for (const goal of goals) this.painted[goal.kind] = this.fill[goal.kind].value;
    const party = goals.some((goal) => this.celebrating.has(goal.kind));
    const head = compact ? 12 : 64;
    const rowH = compact ? 44 : 82;
    const gap = compact ? 8 : 12;
    const barH = compact ? 44 : 40;
    const height = head + goals.length * rowH + (goals.length - 1) * gap + (compact ? 12 : 16);
    this.body = height;
    place(this.sprite, RIGHT_X, HUD.rightTop);
    paintPanel(
      this.sprite,
      COL,
      height,
      scale,
      (ctx) => {
        card(ctx, COL, height, party ? GOLD : HEART, party ? EMBER : DIAMOND);
        if (!compact) {
          const fill = ctx.createLinearGradient(PAD, 0, PAD + 200, 0);
          fill.addColorStop(0, party ? GOLD : HEART);
          fill.addColorStop(1, party ? EMBER : DIAMOND);
          tab(ctx, PAD, PAD, party ? "META BATIDA!" : "METAS DA LIVE", fill, star);
        }
        goals.forEach((goal, i) => {
          const top = head + i * (rowH + gap);
          const look = GOAL_LOOK[goal.kind];
          const done = this.celebrating.has(goal.kind);
          const near = !done && goalNear(goal);
          const color = done ? GOLD : look.color;
          const color2 = done ? CREAM : look.color2;
          const barY = compact ? top : top + 38;
          if (!compact) {
            look.mark(ctx, PAD + 11, top + 15, 21, color);
            // "CURTIDAS · META 2" when there's room next to the percent, else just "CURTIDAS".
            const labelFont = font(880, 22);
            const room = COL - PAD * 2 - 30 - (near ? 96 : measureWith(font(900, 24))(done ? "100%" : goalPercent(goal)) + 12);
            const numbered = `${look.label} · META ${goal.level}`;
            const label = goal.level > 1 && measureWith(labelFont)(numbered) <= room ? numbered : look.label;
            ctx.font = labelFont;
            ctx.fillStyle = color;
            ctx.fillText(fit(label, labelFont, room), PAD + 30, top + 23);
            if (near) {
              // "QUASE!" in a filled pill: the room is almost there.
              const f = font(900, 20);
              const w = measureWith(f)("QUASE!") + 22;
              ctx.fillStyle = color;
              roundRect(ctx, COL - PAD - w, top + 1, w, 30, 15);
              ctx.fill();
              ctx.font = f;
              ctx.textAlign = "center";
              ctx.fillStyle = DEEP;
              ctx.fillText("QUASE!", COL - PAD - w / 2, top + 23);
            } else {
              ctx.font = font(900, 24);
              ctx.textAlign = "right";
              ctx.fillStyle = done ? GOLD : INK;
              ctx.fillText(done ? "100%" : goalPercent(goal), COL - PAD, top + 24);
            }
            ctx.textAlign = "left";
          }
          const fraction = done ? 1 : this.fill[goal.kind].value;
          bar(ctx, PAD, barY, COL - PAD * 2, barH, fraction, color, color2);
          if (near && shine !== null) sweep(ctx, PAD, barY, COL - PAD * 2, barH, barH / 2, shine, 0.55);
          // What's left, in the bar: the number that makes people tap.
          const text = done ? "META BATIDA!" : near && compact ? `QUASE! ${goalLeft(goal)}` : goalLeft(goal);
          const textX = compact ? PAD + 40 + (COL - PAD * 2 - 40) / 2 : PAD + (COL - PAD * 2) / 2;
          const shown = shrinkToFit(text, 900, 24, 18, COL - PAD * 2 - (compact ? 56 : 20));
          ctx.font = shown.font;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          outlined(ctx, shown.text, textX, barY + barH / 2 + 1);
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
          if (compact) {
            ctx.save();
            ctx.shadowColor = "rgba(10,4,26,0.8)";
            ctx.shadowBlur = 6;
            look.mark(ctx, PAD + 22, barY + barH / 2, 22, "#FFFFFF");
            ctx.restore();
          }
        });
      },
      crossfade,
      now,
    );
  }
}

// ---- the support ticker ---------------------------------------------------------------

/** How long each line stays up before the next. */
const TICKER_TURN_S = 4.5;
const TICKER_H = 124;
const TICKER_COMPACT_H = 72;

/**
 * Always on (ADR-0041), under the goals: "APOIE A LIVE" and one line at a
 * time, taking turns between what gifts pay for, what each gift gets on
 * the show (a gift power with its price) and the free ways to help. Lines
 * wrap to two rows instead of being cut. Each new line slides in. In a
 * game, one row without the tab.
 */
export class SupportTicker {
  readonly sprite: TextSprite;
  private ticker: Ticker | null = null;
  private index = 0;
  private turnedAt = 0;
  private compact = false;
  private readonly top = new Spring(HUD.rightTop, SPRINGS.snappy);

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
    return this.ticker ? this.top.target + (this.compact ? TICKER_COMPACT_H : TICKER_H) : fallback;
  }

  /** `above` is where the goals end. */
  update(dt: number, now: number, above: number, compact: boolean, scale: number): void {
    const ticker = this.ticker;
    if (ticker && compact !== this.compact) {
      this.compact = compact;
      this.paint(scale, true, now);
    } else this.compact = compact;
    if (ticker && ticker.lines.length > 1 && now - this.turnedAt >= TICKER_TURN_S) {
      this.index = (this.index + 1) % ticker.lines.length;
      this.turnedAt = now;
      this.paint(scale, true, now);
      this.sprite.offsetX.snap(18);
      this.sprite.offsetX.target = 0;
    }
    const top = above > HUD.rightTop ? above + HUD.gap : HUD.rightTop;
    if (this.top.target !== top && !this.sprite.visible()) this.top.snap(top);
    this.top.target = top;
    this.top.step(dt);
    place(this.sprite, RIGHT_X, this.top.value);
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.ticker) this.paint(scale, false, 0);
  }

  private paint(scale: number, crossfade: boolean, now: number): void {
    const ticker = this.ticker as Ticker;
    const line = ticker.lines[this.index % ticker.lines.length] as Ticker["lines"][number];
    const compact = this.compact;
    const height = compact ? TICKER_COMPACT_H : TICKER_H;
    const gift = line.way === "gift";
    const accent = gift ? GOLD : WAY_COLORS[line.way];
    const chipFont = font(900, 25);
    const price = line.diamonds ? formatCount(line.diamonds) : "";
    const chipW = price ? measureWith(chipFont)(price) + 46 : 0;
    paintPanel(
      this.sprite,
      COL,
      height,
      scale,
      (ctx) => {
        card(ctx, COL, height, accent, PERK_PINK);
        if (!compact) {
          const title = fit(ticker.title.toUpperCase(), font(900, 22), COL - PAD * 2 - 28 - 90);
          tab(ctx, PAD, PAD, title, GOLD, diamond);
          // How far along the lines it is.
          const dots = Math.min(ticker.lines.length, 9);
          for (let i = 0; i < dots; i++) {
            ctx.fillStyle = i === this.index % dots ? GOLD : "rgba(255,255,255,0.24)";
            ctx.beginPath();
            ctx.arc(COL - PAD - 4 - (dots - 1 - i) * 10, PAD + TAB_H / 2, 3.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        // The line: a gift power's price in a chip, or the way's mark, then the text.
        const cy = compact ? height / 2 : 60 + (height - 60) / 2;
        let x = PAD;
        if (price) {
          ctx.fillStyle = withAlpha(GOLD, 0.24);
          roundRect(ctx, x, cy - 19, chipW, 38, 19);
          ctx.fill();
          diamond(ctx, x + 18, cy + 1, 19, DIAMOND);
          ctx.font = chipFont;
          ctx.fillStyle = GOLD;
          ctx.fillText(price, x + 33, cy + 9);
          x += chipW + 12;
        } else {
          ctx.fillStyle = withAlpha(accent, 0.2);
          ctx.beginPath();
          ctx.arc(x + 19, cy, 19, 0, Math.PI * 2);
          ctx.fill();
          WAY_MARKS[line.way](ctx, x + 19, cy, 20, accent);
          x += 50;
        }
        const room = COL - x - PAD;
        ctx.fillStyle = gift ? GOLD : INK;
        const text = compact ? lineOrTwo(line.text, 800, 23, 20, 21, 18, room) : lineOrTwo(line.text, 800, 26, 22, 25, 20, room);
        ctx.font = text.font;
        const lineH = text.size * 1.15;
        const first = cy - ((text.lines.length - 1) * lineH) / 2 + text.size * 0.36;
        text.lines.forEach((row, i) => ctx.fillText(row, x, first + i * lineH));
      },
      crossfade,
      now,
    );
  }
}

// ---- alerts ------------------------------------------------------------------------

const TOAST = { minWidth: 236, height: 84, gap: 10, icon: 26, life: 6, loudLife: 7.5 };

/** What goes between the name and the highlighted end: "duda enviou Rose", "duda ativou Fura-fila!". */
export function alertVerb(kind: AlertKind): string {
  return kind === "gift" ? " enviou " : kind === "perk" ? " ativou " : " ";
}

/** The name card's second line: what they did ("enviou Rose ×5", "começou a seguir"). */
export function toastLine(kind: AlertKind, detail: string): string {
  return `${alertVerb(kind)}${detail}`.trim();
}

/** How many name cards fit between `top` and `floor` (at least one, at most three). */
export function toastSlots(top: number, floor: number): number {
  return Math.max(1, Math.min(3, Math.floor((floor - top + TOAST.gap) / (TOAST.height + TOAST.gap))));
}

const TOAST_MARKS: Record<AlertKind, Mark> = { gift: diamond, follow: plus, share, level: star, crown, perk: diamond, raffle: sparkle };

/**
 * Alerts as name cards, right column, newest on top: the viewer's name big,
 * what they did under it in the alert's color, and a mark in a disc. Each
 * slides in from the edge with a pop; the loud ones (a gift, a new top
 * gifter, a gift power) glow gold or pink.
 */
export class Alerts {
  private readonly items: Array<{ sprite: TextSprite; bornAt: number; slot: Spring; kind: AlertKind; parts: [string, string]; width: number }> = [];
  private readonly pool: TextSprite[] = [];
  private glow = CYAN;

  constructor(private readonly gl: Gl) {}

  setGlow(color: string): void {
    this.glow = color;
  }

  push(kind: AlertKind, name: string, detail: string, now: number, scale: number): void {
    const sprite = this.pool.pop() ?? new TextSprite(this.gl);
    const parts: [string, string] = [truncate(name, 24), toastLine(kind, detail)];
    const width = this.paint(sprite, kind, parts, scale);
    sprite.opacity.snap(0);
    sprite.opacity.target = 1;
    sprite.offsetX.snap(70);
    sprite.offsetX.target = 0;
    sprite.offsetY.snap(0);
    sprite.offsetY.target = 0;
    sprite.pop(0.86);
    for (const item of this.items) item.slot.target += 1;
    this.items.unshift({ sprite, bornAt: now, slot: new Spring(0, SPRINGS.snappy), kind, parts, width });
    while (this.items.length > 4) this.retire(this.items.length - 1);
  }

  /** `top` is where the stack starts (under the support ticker); only `slots` name cards stay up at once. */
  update(dt: number, now: number, top: number, slots: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!;
      const life = item.kind === "crown" || item.kind === "perk" ? TOAST.loudLife : TOAST.life;
      if (now - item.bornAt > life || item.slot.target >= slots) {
        item.sprite.opacity.target = 0;
        item.sprite.offsetX.target = 50;
      }
      item.slot.step(dt);
      item.sprite.update(dt, now);
      place(item.sprite, HUD.right - item.width, top + item.slot.value * (TOAST.height + TOAST.gap));
      if (now - item.bornAt > life + 1) this.retire(i);
    }
  }

  repaint(scale: number): void {
    for (const item of this.items) item.width = this.paint(item.sprite, item.kind, item.parts, scale);
  }

  sprites(): TextSprite[] {
    return this.items.map((item) => item.sprite);
  }

  /** Visits each live alert sprite without allocating (frame loop). */
  forEachSprite(visit: (sprite: TextSprite) => void): void {
    for (let i = 0; i < this.items.length; i++) visit((this.items[i] as { sprite: TextSprite }).sprite);
  }

  private retire(index: number): void {
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

  /** Paints one name card and returns its width. */
  private paint(sprite: TextSprite, kind: AlertKind, parts: [string, string], scale: number): number {
    const { height, icon } = TOAST;
    const accent = this.accent(kind);
    const loud = kind === "gift" || kind === "crown" || kind === "perk";
    const textX = PAD + icon * 2 + 14;
    const room = COL - textX - PAD;
    const name = shrinkToFit(parts[0], 860, 30, 22, room);
    const line = shrinkToFit(parts[1], 780, 23, 19, room);
    const natural = Math.max(measureWith(name.font)(name.text), measureWith(line.font)(line.text));
    const width = Math.max(TOAST.minWidth, Math.min(COL, Math.ceil(textX + natural + PAD + 4)));
    paintPanel(sprite, width, height, scale, (ctx) => {
      let body: string | CanvasGradient = "rgba(13,7,34,0.9)";
      if (loud) {
        const warm = ctx.createLinearGradient(0, 0, width, 0);
        warm.addColorStop(0, kind === "perk" ? "rgba(78,10,66,0.94)" : "rgba(84,52,10,0.94)");
        warm.addColorStop(1, "rgba(20,8,40,0.92)");
        body = warm;
      }
      card(ctx, width, height, accent, loud ? accent : VIOLET, height / 2, body);
      // The mark in a solid disc in the alert's color.
      const cx = PAD + icon - 4;
      ctx.save();
      ctx.shadowColor = withAlpha(accent, 0.8);
      ctx.shadowBlur = 12;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(cx, height / 2, icon, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      TOAST_MARKS[kind](ctx, cx, height / 2 + (kind === "crown" ? 2 : 0), 26, DEEP);
      ctx.textBaseline = "alphabetic";
      ctx.font = name.font;
      ctx.fillStyle = kind === "crown" ? CREAM : INK;
      ctx.fillText(name.text, textX, 38);
      ctx.font = line.font;
      ctx.fillStyle = accent;
      ctx.fillText(line.text, textX, 67);
    });
    return width;
  }
}

// ---- the "dono da live" ------------------------------------------------------------

/**
 * Where the "dono da live" badge sits (ADR-0039): left, under the ranking
 * card (it follows the column's bottom, never above `minTop`), left of the
 * character and above the spotlight under it. A game board covers that
 * spot, so the badge gives way to it.
 */
const BOSS = { minTop: 600, gap: 14, height: 104, glow: 26 };

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
      this.sprite.pop(0.88);
    }
  }

  /** `below` is where the ranking card ends; `away` (0 to 1) how far a game board has come in. */
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
    this.sprite.x = LEFT - BOSS.glow;
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
    const { height, glow } = BOSS;
    const width = COL;
    const clock = formatClock(left);
    const shown = shrinkToFit(name, 860, 32, 22, width - 92 - PAD);
    const clockFont = font(850, 20);
    const clockW = measureWith(clockFont)(clock) + 22;
    const ending = left <= 30;
    this.sprite.draw(width + glow * 2, height + glow * 2, scale, (ctx) => {
      ctx.translate(glow, glow);
      // A warm gold glow around a deep body that turns gold at the bottom.
      ctx.save();
      ctx.shadowColor = withAlpha(GOLD, 0.75);
      ctx.shadowBlur = 18;
      const body = ctx.createLinearGradient(0, 0, 0, height);
      body.addColorStop(0, "rgba(40,14,66,0.95)");
      body.addColorStop(1, "rgba(96,58,10,0.93)");
      ctx.fillStyle = body;
      roundRect(ctx, 0, 0, width, height, 26);
      ctx.fill();
      ctx.restore();
      const edge = ctx.createLinearGradient(0, 0, width, height);
      edge.addColorStop(0, CREAM);
      edge.addColorStop(0.5, GOLD);
      edge.addColorStop(1, EMBER);
      ctx.strokeStyle = edge;
      ctx.lineWidth = 3;
      roundRect(ctx, 1.5, 1.5, width - 3, height - 3, 25);
      ctx.stroke();
      // The crown, big, in a soft gold disc.
      ctx.fillStyle = withAlpha(GOLD, 0.2);
      ctx.beginPath();
      ctx.arc(48, height / 2, 32, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.shadowColor = withAlpha(GOLD, 0.9);
      ctx.shadowBlur = 12;
      crown(ctx, 48, height / 2 + 2, 40, GOLD);
      ctx.restore();
      sparkle(ctx, 70, height / 2 - 24, 13, "#FFF6D6");
      ctx.textBaseline = "alphabetic";
      ctx.font = font(900, 21);
      ctx.fillStyle = GOLD;
      ctx.fillText("DONO DA LIVE", 92, 36);
      // The countdown in a chip, top right.
      ctx.fillStyle = withAlpha(ending ? HOT : GOLD, ending ? 0.34 : 0.2);
      roundRect(ctx, width - 14 - clockW, 14, clockW, 30, 15);
      ctx.fill();
      ctx.font = clockFont;
      ctx.textAlign = "center";
      ctx.fillStyle = ending ? "#FFD6DA" : GOLD;
      ctx.fillText(clock, width - 14 - clockW / 2, 36);
      ctx.textAlign = "left";
      ctx.save();
      ctx.shadowColor = withAlpha(GOLD, 0.85);
      ctx.shadowBlur = 14;
      ctx.font = shown.font;
      ctx.fillStyle = CREAM;
      ctx.fillText(shown.text, 92, 80);
      ctx.restore();
    });
  }
}

