import type { AlertKind, GoalKind, GoalView, LeaderBoard, LeaderRow, Ticker, UpNextItem } from "@tik-live/shared";
import { Spring, SPRINGS } from "../anim/spring";
import type { Gl } from "../gl/gl";
import {
  bar,
  BLEED,
  card,
  columnWidth,
  CREAM,
  crown,
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
  heart,
  HEART,
  HUD,
  lineOrTwo,
  type Mark,
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
  stageY,
  star,
  sweep,
  tab,
  VIOLET,
  WAY_COLORS,
  WAY_MARKS,
  type Canvas2D,
} from "./kit";
import { GOLD, HAZE, INK, measureWith, roundRect, TextSprite, truncate, withAlpha } from "./sprites";

/**
 * The stage's calm edges (ADR-0049): what stays on screen, small and
 * still, around the character, so the center can do the talking.
 *
 * - The title row, and a row of chips under it: the AI badge (a legal
 *   requirement, never hidden) and, from the effects layer, now playing.
 * - Left of the character, the kings: who gives the most and who taps the
 *   most, both at once (or a vote, or one viewer's pick), with the "dono da
 *   live" under them.
 * - Right of the character, the goals as two bars that say what's left,
 *   the always-on support line, and alerts as name cards.
 * - Up next rests in the moment stage under the character (`spotlight.ts`)
 *   and moves to the top of the left column during a game.
 *
 * During a game the side cards fold to one line per row and end above the
 * board. Painted when content changes; anything that counts or fills
 * repaints at most 20 to 30 times a second while it moves.
 */

const LEFT = HUD.margin;
const PAD = 14;
/** Anything that moves repaints at most this often. */
const FRAME_S = 1 / 30;
/** How far the glow around the kings card reaches past it. */
const AURA = 30;

function enter(sprite: TextSprite, wasHidden: boolean): void {
  if (wasHidden) {
    sprite.opacity.snap(0);
    sprite.offsetY.snap(-16);
  }
  sprite.opacity.target = 1;
  sprite.offsetY.target = 0;
}

/** Where the right column starts, at rest or in a game. */
function rightX(compact: boolean): number {
  return HUD.right - columnWidth(compact);
}

// ---- the title and its chips ---------------------------------------------------

const TITLE = { size: 44, minSize: 34, maxWidth: HUD.right - HUD.margin, glow: 30 };

/** The segment's title, and the AI-disclosure badge under it (a legal requirement: always on). */
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
    // Long titles shrink a little first, then squeeze into the safe frame.
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
    const f = font(760, 25);
    const text = this.badgeText;
    const height = 42;
    const width = measureWith(f)(text) + 62;
    const glow = this.glow;
    place(this.badge, LEFT, HUD.chipsTop);
    paintPanel(this.badge, width, height, scale, (ctx) => {
      ctx.fillStyle = "rgba(16,8,40,0.74)";
      roundRect(ctx, 0, 0, width, height, height / 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(244,240,255,0.34)";
      ctx.lineWidth = 1.5;
      roundRect(ctx, 0.75, 0.75, width - 1.5, height - 1.5, (height - 1.5) / 2);
      ctx.stroke();
      sparkle(ctx, 23, height / 2, 20, glow);
      ctx.font = f;
      ctx.textBaseline = "middle";
      ctx.fillStyle = INK;
      ctx.fillText(text, 41, height / 2 + 1);
    });
  }
}

// ---- up next ---------------------------------------------------------------------

/** Where up next is drawn: big in the moment stage, as a pill atop the left column in a game, or not at all. */
export type NextPlacement = "stage" | "column" | "hidden";

const NEXT_STAGE = { width: 620, height: 108, ring: 88, radius: 35, line: 10 };
const NEXT_PILL = { height: 64, ring: 54, radius: 20, line: 6 };
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
 * the end. The open loop that keeps people a few minutes more, so at rest
 * it's the moment stage's resting card, right under the character.
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
  /** Where it's drawn now, and where it's going (it fades out, moves, and fades back in). */
  private shown: NextPlacement = "hidden";
  private wanted: NextPlacement = "hidden";

  constructor(gl: Gl) {
    this.card = new TextSprite(gl);
    this.ring = new TextSprite(gl);
  }

  /** Something is up next. */
  get active(): boolean {
    return this.item !== null;
  }

  /** The last seconds, or due: it outranks the stage's other moments. */
  get urgent(): boolean {
    return this.item !== null && (this.mood === "final" || this.mood === "due");
  }

  /** The room it takes atop the left column (0 unless it's a pill there). */
  get columnHeight(): number {
    return this.item && this.wanted === "column" ? NEXT_PILL.height + HUD.gap : 0;
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
      this.wanted = "hidden";
      return;
    }
    const fresh = !before || before.kind !== next.kind || before.title !== next.title;
    const left = next.inMs / 1000;
    this.deadline = now + left;
    if (fresh || left > this.total) this.total = Math.max(1, left);
    this.mood = nextMood(left);
    if (this.shown !== "hidden") {
      this.paintCard(scale, fresh, now);
      this.paintRing(now, scale);
      if (fresh) this.card.pop(1.06);
    }
  }

  update(dt: number, now: number, placement: NextPlacement, scale: number): void {
    this.wanted = this.item ? placement : "hidden";
    if (this.wanted !== this.shown) {
      // Out where it is, then in where it's going.
      this.card.opacity.target = 0;
      this.ring.opacity.target = 0;
      if (this.shown === "hidden" || this.card.opacity.value < 0.05) {
        this.shown = this.wanted;
        if (this.shown !== "hidden") {
          this.mood = nextMood(this.deadline - now);
          this.paintCard(scale, false, now);
          this.paintRing(now, scale);
          enter(this.card, true);
          enter(this.ring, true);
          this.card.pop(0.92);
        }
      }
    }
    if (this.item && this.shown !== "hidden") {
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
    if (!this.item || this.shown === "hidden") return;
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
    if (this.shown === "column") {
      // A pill atop the left column: the ring, then the title.
      const width = HUD.gameColumn;
      const height = NEXT_PILL.height;
      const textX = NEXT_PILL.ring + 18;
      const title = shrinkToFit(item.title, 820, 25, 18, width - textX - PAD);
      place(this.card, LEFT, HUD.sideTop);
      paintPanel(
        this.card,
        width,
        height,
        scale,
        (ctx) => {
          card(ctx, width, height, color, VIOLET, height / 2);
          ctx.font = title.font;
          ctx.fillStyle = INK;
          ctx.textBaseline = "middle";
          ctx.fillText(title.text, textX, height / 2 + 1);
        },
        crossfade,
        now,
      );
      return;
    }
    // The resting card in the moment stage: the ring, what it is, and its title, big.
    const { width, height, ring } = NEXT_STAGE;
    const textX = ring + 34;
    const room = width - textX - 22;
    const label = shrinkToFit(nextLabel(item.kind, this.mood === "due"), 900, 24, 19, room);
    const title = shrinkToFit(item.title, 840, 38, 26, room);
    place(this.card, 540 - width / 2, stageY(height));
    paintPanel(
      this.card,
      width,
      height,
      scale,
      (ctx) => {
        card(ctx, width, height, color, VIOLET, 34);
        ctx.textBaseline = "alphabetic";
        ctx.font = label.font;
        ctx.fillStyle = color;
        ctx.fillText(label.text, textX, 42);
        ctx.font = title.font;
        ctx.fillStyle = INK;
        ctx.fillText(title.text, textX, 84);
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
    const pill = this.shown === "column";
    const { ring: size, radius, line } = pill ? NEXT_PILL : NEXT_STAGE;
    const color = this.color();
    const c = size / 2;
    const fraction = this.mood === "due" ? 1 : ringFraction(left, this.total);
    if (pill) place(this.ring, LEFT + 5, HUD.sideTop + (NEXT_PILL.height - size) / 2);
    else place(this.ring, 540 - NEXT_STAGE.width / 2 + 12, stageY(NEXT_STAGE.height) + (NEXT_STAGE.height - size) / 2);
    paintPanel(this.ring, size, size, scale, (ctx) => {
      ctx.lineCap = "round";
      ctx.lineWidth = line;
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.arc(c, c, radius, 0, Math.PI * 2);
      ctx.stroke();
      if (fraction > 0.002) {
        ctx.save();
        ctx.shadowColor = withAlpha(color, 0.85);
        ctx.shadowBlur = 10;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(c, c, radius, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (this.mood === "due") {
        // It's due: a play mark (or a crown for the podium).
        (item.kind === "podium" ? crown : play)(ctx, c + (item.kind === "podium" ? 0 : 3), c, radius * 0.85, color);
        return;
      }
      // Under a minute, just the seconds, bigger.
      const s = Math.ceil(left);
      const text = s < 60 ? String(s) : formatCountdown(s);
      const big = pill ? 22 : 34;
      const small = pill ? 16 : 24;
      const shown = shrinkToFit(text, 900, s < 60 ? big : small, 13, radius * 2 - line - 6);
      ctx.font = shown.font;
      ctx.fillStyle = this.mood === "calm" ? INK : color;
      ctx.fillText(shown.text, c, c + 2);
    });
  }
}

// ---- the kings ------------------------------------------------------------------

/** A chat vote shown in the kings' place while it's open (ADR-0029), or one viewer's pick (`by`, ADR-0039). */
export interface HudVote {
  title: string;
  options: string[];
  tally: number[];
  by?: string;
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

/** Each king's row: its mark, label and color, and what it says when nobody's there yet. */
const KINGS: Record<LeaderBoard, { label: string; color: string; mark: Mark; empty: string }> = {
  gifts: { label: "TOP DOADOR", color: GOLD, mark: crown, empty: "Seja o primeiro!" },
  likes: { label: "TOP CURTIDAS", color: HEART, mark: heart, empty: "Toque na tela!" },
};
const KING_ORDER: readonly LeaderBoard[] = ["gifts", "likes"];

/**
 * Who's on top, left of the character: the top gifter (gold, crowned) and
 * the top liker, both at once, so nobody waits for their turn on screen.
 * Whoever isn't there yet is an invitation ("Seja o primeiro!"). A gift
 * flares the gold glow around the card. The full top three take the
 * moment stage when they change (`spotlight.ts`). A vote or one viewer's
 * pick takes this card's place while it's open.
 */
export class LeaderCard {
  readonly sprite: TextSprite;
  /** The gold glow around the card, brighter for a moment when a gift comes in. */
  readonly aura: TextSprite;
  private readonly boards: Record<LeaderBoard, { rows: LeaderRow[]; windowMin: number }> = { likes: { rows: [], windowMin: 15 }, gifts: { rows: [], windowMin: 60 } };
  private vote: HudVote | null = null;
  private visible = false;
  private compact = false;
  private body = 0;
  private readonly top = new Spring(HUD.sideTop, SPRINGS.snappy);
  private flashAt = -Infinity;
  private auraKey = "";

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
    this.aura = new TextSprite(gl);
  }

  /** A ranking's rows (top three), for the moment stage. */
  rows(board: LeaderBoard): readonly LeaderRow[] {
    return this.boards[board].rows;
  }

  /** A ranking's window in minutes. */
  windowMin(board: LeaderBoard): number {
    return this.boards[board].windowMin;
  }

  set(board: LeaderBoard, rows: readonly LeaderRow[], windowMin: number, now: number, scale: number): void {
    const before = this.boards[board].rows;
    this.boards[board] = { rows: rows.slice(0, 3), windowMin };
    const gift = board === "gifts" && giftCameIn(before, this.boards.gifts.rows);
    if (gift) this.flashAt = now;
    if (this.vote) return;
    const newKing = (before[0]?.name ?? "") !== (rows[0]?.name ?? "");
    if (newKing || (before[0]?.value ?? 0) !== (rows[0]?.value ?? 0) || !this.visible) this.paint(scale, this.visible && newKing, now);
    if (gift) this.sprite.pop(1.05);
  }

  /** Shows a vote instead of the kings (null: back to the kings). */
  setVote(vote: HudVote | null, now: number, scale: number): void {
    const crossfade = this.visible;
    const opened = vote !== null && this.vote === null;
    this.vote = vote;
    this.paint(scale, crossfade, now);
    if (opened && crossfade) this.sprite.pop(1.06);
  }

  /** Where the card ends (stage px), or where it would start when hidden. */
  bottom(above: number): number {
    return this.visible ? this.top.target + this.body : HUD.sideTop + above - HUD.gap;
  }

  /** `above` is the room up next takes atop the column; `compact` folds the card for a game. */
  update(dt: number, now: number, above: number, compact: boolean, scale: number): void {
    if (compact !== this.compact) {
      this.compact = compact;
      if (this.visible) this.paint(scale, true, now);
    }
    this.top.target = HUD.sideTop + above;
    this.top.step(dt);
    place(this.sprite, LEFT, this.top.value);
    this.sprite.update(dt, now);
    // A soft warm glow while someone holds the crown; it flares when a gift comes in.
    const flare = Math.max(0, 1 - (now - this.flashAt) / 1.6);
    const crowned = !this.vote && this.visible && this.boards.gifts.rows.length > 0;
    this.aura.x = LEFT - AURA;
    this.aura.y = this.top.value + this.sprite.offsetY.value - AURA;
    this.aura.zoom.snap(this.sprite.zoom.value);
    this.aura.opacity.snap(crowned ? Math.min(1, 0.3 + flare) * Math.min(1, Math.max(0, this.sprite.opacity.value)) : 0);
    this.aura.update(dt, now);
  }

  repaint(scale: number): void {
    this.auraKey = "";
    this.paint(scale, false, 0);
  }

  private paint(scale: number, crossfade: boolean, now: number): void {
    const wasHidden = !this.visible;
    const vote = this.vote;
    if (!vote && !this.boards.gifts.rows.length && !this.boards.likes.rows.length) {
      this.visible = false;
      this.sprite.opacity.target = 0;
      return;
    }
    this.visible = true;
    const fade = crossfade && !wasHidden;
    if (vote?.by) this.paintPick(vote as HudVote & { by: string }, scale, fade, now);
    else if (vote) this.paintVote(vote, scale, fade, now);
    else this.paintKings(scale, fade, now);
    if (wasHidden) this.top.snap(this.top.target);
    enter(this.sprite, wasHidden);
  }

  private draw(height: number, scale: number, paint: (ctx: Canvas2D) => void, crossfade: boolean, now: number): void {
    this.body = height;
    paintPanel(this.sprite, columnWidth(this.compact), height, scale, paint, crossfade, now);
  }

  /** Both kings: two lines a row at rest (what they are and the count, then the name), one line a row in a game. */
  private paintKings(scale: number, crossfade: boolean, now: number): void {
    const width = columnWidth(this.compact);
    const rowH = this.compact ? 46 : 66;
    const gap = 6;
    const pad = 8;
    const height = pad * 2 + rowH * 2 + gap;
    this.paintAura(width, height, scale);
    this.draw(
      height,
      scale,
      (ctx) => {
        const body = ctx.createLinearGradient(0, 0, 0, height);
        body.addColorStop(0, "rgba(36,12,64,0.92)");
        body.addColorStop(1, "rgba(20,8,44,0.9)");
        card(ctx, width, height, GOLD, HEART, 24, body);
        KING_ORDER.forEach((board, i) => {
          const king = KINGS[board];
          const row = this.boards[board].rows[0];
          const y = pad + i * (rowH + gap);
          const gold = board === "gifts";
          // The crown's row sits on a soft gold band: it's the card's loudest thing.
          if (gold) {
            const band = ctx.createLinearGradient(pad, 0, width - pad, 0);
            band.addColorStop(0, withAlpha(GOLD, row ? 0.3 : 0.1));
            band.addColorStop(1, withAlpha(EMBER, 0.05));
            ctx.fillStyle = band;
            roundRect(ctx, pad - 2, y, width - pad * 2 + 4, rowH, 18);
            ctx.fill();
          }
          // The mark in a solid disc.
          const r = this.compact ? 16 : 20;
          const cx = pad + 6 + r;
          const cy = y + rowH / 2;
          ctx.fillStyle = row ? king.color : withAlpha(king.color, 0.35);
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
          king.mark(ctx, cx, cy + 1, r * 1.05, DEEP);
          const textX = cx + r + 11;
          const value = row ? formatCount(row.value) : "";
          const valueMark = gold ? diamond : heart;
          const valueColor = gold ? DIAMOND : HEART;
          if (this.compact) {
            // One line: the name, then the count on the right.
            const valueFont = font(900, 22);
            const valueW = value ? measureWith(valueFont)(value) + 22 : 0;
            const name = shrinkToFit(row ? row.name : king.empty, 820, 23, 16, width - textX - PAD - valueW - 6);
            ctx.font = name.font;
            ctx.fillStyle = row ? (gold ? CREAM : INK) : HAZE;
            ctx.fillText(name.text, textX, cy + 8);
            if (value) {
              ctx.font = valueFont;
              ctx.textAlign = "right";
              ctx.fillStyle = king.color;
              ctx.fillText(value, width - PAD, cy + 8);
              ctx.textAlign = "left";
              valueMark(ctx, width - PAD - measureWith(valueFont)(value) - 11, cy, 15, valueColor);
            }
            return;
          }
          // The name big, and under it the count with its mark (or the invitation).
          const name = shrinkToFit(row ? row.name : king.empty, row ? 850 : 760, 28, 19, width - textX - PAD);
          ctx.save();
          if (row && gold) {
            ctx.shadowColor = withAlpha(GOLD, 0.7);
            ctx.shadowBlur = 10;
          }
          ctx.font = name.font;
          ctx.fillStyle = row ? (gold ? CREAM : INK) : HAZE;
          ctx.fillText(name.text, textX, y + 31);
          ctx.restore();
          if (value) {
            valueMark(ctx, textX + 8, y + 47, 15, valueColor);
            ctx.font = font(900, 22);
            ctx.fillStyle = king.color;
            ctx.fillText(value, textX + 22, y + 55);
          } else {
            ctx.font = font(860, 17);
            ctx.fillStyle = withAlpha(king.color, 0.85);
            ctx.fillText(king.label, textX, y + 55);
          }
        });
      },
      crossfade,
      now,
    );
  }

  /** The soft gold glow behind the card, repainted only when the card's size changes. */
  private paintAura(width: number, height: number, scale: number): void {
    const key = `${width}x${height}`;
    if (key === this.auraKey) return;
    this.auraKey = key;
    this.aura.draw(width + AURA * 2, height + AURA * 2, scale, (ctx) => {
      // Two passes, a wide warm halo and a tighter bright one, kept inside the texture so it never shows an edge.
      for (const [blur, alpha] of [
        [22, 0.7],
        [9, 0.85],
      ] as const) {
        ctx.save();
        ctx.shadowColor = withAlpha(GOLD, alpha);
        ctx.shadowBlur = blur;
        ctx.fillStyle = withAlpha(GOLD, alpha);
        roundRect(ctx, AURA, AURA, width, height, 24);
        ctx.fill();
        ctx.restore();
      }
    });
  }

  /** One viewer chooses (a gift power or the raffle's prize): their name on the tab, the options numbered, no tally. */
  private paintPick(vote: HudVote & { by: string }, scale: number, crossfade: boolean, now: number): void {
    const width = columnWidth(this.compact);
    const options = this.compact ? [] : vote.options.slice(0, 3);
    const head = this.compact ? 60 : 98;
    const rowH = 46;
    const foot = 46;
    const height = head + options.length * rowH + foot;
    this.draw(
      height,
      scale,
      (ctx) => {
        card(ctx, width, height, GOLD, EMBER);
        tab(ctx, PAD, PAD, fit(pickHeader(vote.by), font(900, 22), width - PAD * 2 - 58), GOLD, crown);
        if (!this.compact) {
          const title = shrinkToFit(vote.title, 800, 26, 20, width - PAD * 2);
          ctx.font = title.font;
          ctx.fillStyle = INK;
          ctx.fillText(title.text, PAD, 84);
        }
        options.forEach((option, i) => {
          const y = head + i * rowH;
          ctx.fillStyle = "rgba(255,255,255,0.07)";
          roundRect(ctx, PAD - 4, y + 3, width - PAD * 2 + 8, rowH - 6, 14);
          ctx.fill();
          // The number in a gold disc: that's what they type.
          ctx.fillStyle = GOLD;
          ctx.beginPath();
          ctx.arc(PAD + 15, y + rowH / 2, 14, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = font(900, 18);
          ctx.textAlign = "center";
          ctx.fillStyle = DEEP;
          ctx.fillText(String(i + 1), PAD + 15, y + rowH / 2 + 7);
          ctx.textAlign = "left";
          const text = shrinkToFit(option, 760, 23, 18, width - PAD * 2 - 42);
          ctx.font = text.font;
          ctx.fillStyle = INK;
          ctx.fillText(text.text, PAD + 38, y + rowH / 2 + 8);
        });
        const hint = shrinkToFit(`${vote.by}, digite o número no chat`, 760, 21, 16, width - PAD * 2);
        ctx.font = hint.font;
        ctx.fillStyle = GOLD;
        ctx.fillText(hint.text, PAD, height - 17);
      },
      crossfade,
      now,
    );
  }

  /** Chat's vote: what to type on the tab, a bar per option, the leader in gold. In a game, only the leader. */
  private paintVote(vote: HudVote, scale: number, crossfade: boolean, now: number): void {
    const width = columnWidth(this.compact);
    const all = vote.options.slice(0, 3);
    const total = vote.tally.reduce((sum, n) => sum + n, 0);
    const lead = total ? vote.tally.indexOf(Math.max(...vote.tally)) : -1;
    const shown = this.compact ? [Math.max(0, lead)] : all.map((_, i) => i);
    const head = this.compact ? 60 : 98;
    const rowH = 48;
    const height = head + shown.length * rowH + 10;
    this.draw(
      height,
      scale,
      (ctx) => {
        card(ctx, width, height, GOLD, "#FF5FA2");
        tab(ctx, PAD, PAD, fit(voteTab(all.length), font(900, 22), width - PAD * 2 - 30), GOLD);
        if (!this.compact) {
          const title = shrinkToFit(vote.title, 800, 26, 20, width - PAD * 2);
          ctx.font = title.font;
          ctx.fillStyle = INK;
          ctx.fillText(title.text, PAD, 84);
        }
        shown.forEach((index, row) => {
          const y = head + row * rowH;
          const share = total ? (vote.tally[index] ?? 0) / total : 0;
          const leading = index === lead;
          const w = width - PAD * 2 + 8;
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
          ctx.arc(PAD + 15, y + rowH / 2, 14, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = font(900, 18);
          ctx.textAlign = "center";
          ctx.fillStyle = DEEP;
          ctx.fillText(String(index + 1), PAD + 15, y + rowH / 2 + 7);
          ctx.textAlign = "right";
          ctx.font = font(900, 23);
          ctx.fillStyle = leading ? GOLD : INK;
          const pct = total ? `${Math.round(share * 100)}%` : "";
          ctx.fillText(pct, width - PAD, y + rowH / 2 + 9);
          ctx.textAlign = "left";
          const text = shrinkToFit(all[index] ?? "", 760, 23, 18, width - PAD * 2 - 42 - (pct ? 58 : 0));
          ctx.font = text.font;
          ctx.fillStyle = INK;
          ctx.fillText(text.text, PAD + 38, y + rowH / 2 + 8);
        });
      },
      crossfade,
      now,
    );
  }
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
const GOAL_LOOK: Record<GoalKind, { color: string; color2: string; mark: Mark }> = {
  likes: { color: HEART, color2: "#FF9AD5", mark: heart },
  gifts: { color: DIAMOND, color2: "#B8F0FF", mark: diamond },
};
const GOAL_BAR_H = 42;

/**
 * The like and gift goals (ADR-0036), right of the character: a thick bar
 * each, with its mark, that fills with a spring as they come in and says
 * what's left ("FALTAM 1.760"). Near the goal a light runs along it (and
 * the moment stage says "QUASE LÁ!" big); reaching it turns the bar gold
 * with a pop. The same bars in a game, a little wider.
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

  /** A goal as last sent, for the moment stage. */
  goal(kind: GoalKind): GoalView | undefined {
    for (let i = 0; i < this.goals.length; i++) if ((this.goals[i] as GoalView).kind === kind) return this.goals[i];
    return undefined;
  }

  /** The goal is close (80% and up) and not celebrating. Runs every frame: no closures. */
  near(kind: GoalKind): boolean {
    const goal = this.goal(kind);
    return goal !== undefined && goalNear(goal) && !this.celebrating.has(kind);
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
    else if (reached) this.sprite.pop(1.12);
  }

  update(dt: number, now: number, compact: boolean, scale: number): void {
    let dirty = false;
    let crossfade = false;
    if (compact !== this.compact) {
      this.compact = compact;
      dirty = crossfade = true;
    }
    // Only while a goal celebrates (the map is empty otherwise).
    if (this.celebrating.size)
      for (const [kind, until] of this.celebrating) {
        if (until > now) continue;
        this.celebrating.delete(kind);
        // The next goal starts where its count already is.
        const goal = this.goal(kind);
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

  /** Where the panel ends (stage px), or just above where it would start when there are no goals. */
  bottom(): number {
    return this.goals.length ? HUD.sideTop + this.body : HUD.sideTop - HUD.gap;
  }

  /** The light along a near goal's bar, 0 to 1, or null between sweeps (or when no goal is near). */
  private sweepAt(now: number): number | null {
    let any = false;
    for (let i = 0; i < this.goals.length; i++) if (this.near((this.goals[i] as GoalView).kind)) any = true;
    if (!any) return null;
    const p = (now % NEAR_SWEEP_EVERY_S) / NEAR_SWEEP_S;
    return p <= 1 ? p : null;
  }

  private paint(now: number, scale: number, crossfade = false): void {
    const goals = this.goals;
    const width = columnWidth(this.compact);
    const shine = this.sweepAt(now);
    this.sweepPainted = shine !== null;
    this.paintedAt = now;
    for (const goal of goals) this.painted[goal.kind] = this.fill[goal.kind].value;
    const party = goals.some((goal) => this.celebrating.has(goal.kind));
    const pad = 10;
    const gap = 8;
    const height = pad * 2 + goals.length * GOAL_BAR_H + (goals.length - 1) * gap;
    this.body = height;
    place(this.sprite, rightX(this.compact), HUD.sideTop);
    paintPanel(
      this.sprite,
      width,
      height,
      scale,
      (ctx) => {
        card(ctx, width, height, party ? GOLD : HEART, party ? EMBER : DIAMOND, 24);
        goals.forEach((goal, i) => {
          const top = pad + i * (GOAL_BAR_H + gap);
          const look = GOAL_LOOK[goal.kind];
          const done = this.celebrating.has(goal.kind);
          const near = !done && goalNear(goal);
          const color = done ? GOLD : look.color;
          const color2 = done ? CREAM : look.color2;
          const barW = width - pad * 2;
          const fraction = done ? 1 : this.fill[goal.kind].value;
          bar(ctx, pad, top, barW, GOAL_BAR_H, fraction, color, color2);
          if (near && shine !== null) sweep(ctx, pad, top, barW, GOAL_BAR_H, GOAL_BAR_H / 2, shine, 0.55);
          // The mark in white at the bar's start, then what's left: the number that makes people tap.
          ctx.save();
          ctx.shadowColor = "rgba(10,4,26,0.8)";
          ctx.shadowBlur = 6;
          look.mark(ctx, pad + 22, top + GOAL_BAR_H / 2, 22, "#FFFFFF");
          ctx.restore();
          const text = done ? "META BATIDA!" : near ? `${goalLeft(goal)}!` : goalLeft(goal);
          const room = barW - 52;
          const shown = shrinkToFit(text, 900, 24, 17, room);
          ctx.font = shown.font;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          outlined(ctx, shown.text, pad + 42 + room / 2, top + GOAL_BAR_H / 2 + 1);
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
        });
      },
      crossfade,
      now,
    );
  }
}

// ---- the support line ---------------------------------------------------------------

/** How long each line stays up before the next. */
const TICKER_TURN_S = 4.5;
const TICKER_H = 78;
const TICKER_COMPACT_H = 66;

/**
 * Always on (ADR-0041), under the goals: one line at a time, taking turns
 * between what gifts pay for, what each gift gets on the show (a gift power
 * with its price) and the free ways to help. Lines wrap to two rows instead
 * of being cut; each new one slides in. In a game it shares its spot with
 * a name card, which goes first.
 */
export class SupportTicker {
  readonly sprite: TextSprite;
  private ticker: Ticker | null = null;
  private index = 0;
  private turnedAt = 0;
  private compact = false;
  private readonly top = new Spring(HUD.sideTop, SPRINGS.snappy);

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

  /** Where the line ends (stage px), or `fallback` when it's off. */
  bottom(fallback: number): number {
    return this.ticker ? this.top.target + (this.compact ? TICKER_COMPACT_H : TICKER_H) : fallback;
  }

  /** `above` is where the goals end; `yieldTo` is true while a name card has its spot. */
  update(dt: number, now: number, above: number, compact: boolean, yieldTo: boolean, scale: number): void {
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
    if (ticker) this.sprite.opacity.target = yieldTo ? 0 : 1;
    const top = above + HUD.gap;
    if (this.top.target !== top && !this.sprite.visible()) this.top.snap(top);
    this.top.target = top;
    this.top.step(dt);
    place(this.sprite, rightX(this.compact), this.top.value);
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.ticker) this.paint(scale, false, 0);
  }

  private paint(scale: number, crossfade: boolean, now: number): void {
    const ticker = this.ticker as Ticker;
    const line = ticker.lines[this.index % ticker.lines.length] as Ticker["lines"][number];
    const width = columnWidth(this.compact);
    const height = this.compact ? TICKER_COMPACT_H : TICKER_H;
    const gift = line.way === "gift";
    const accent = gift ? GOLD : WAY_COLORS[line.way];
    const chipFont = font(900, 23);
    const price = line.diamonds ? formatCount(line.diamonds) : "";
    const chipW = price ? measureWith(chipFont)(price) + 42 : 0;
    paintPanel(
      this.sprite,
      width,
      height,
      scale,
      (ctx) => {
        card(ctx, width, height, accent, PERK_PINK, 24);
        // A gift power's price in a chip, or the way's mark in a disc, then the line.
        const cy = height / 2;
        let x = 12;
        if (price) {
          ctx.fillStyle = withAlpha(GOLD, 0.24);
          roundRect(ctx, x, cy - 18, chipW, 36, 18);
          ctx.fill();
          diamond(ctx, x + 17, cy + 1, 18, DIAMOND);
          ctx.font = chipFont;
          ctx.fillStyle = GOLD;
          ctx.fillText(price, x + 31, cy + 8);
          x += chipW + 10;
        } else {
          ctx.fillStyle = withAlpha(accent, 0.2);
          ctx.beginPath();
          ctx.arc(x + 18, cy, 18, 0, Math.PI * 2);
          ctx.fill();
          WAY_MARKS[line.way](ctx, x + 18, cy, 19, accent);
          x += 46;
        }
        const text = lineOrTwo(line.text, 800, 23, 20, 21, 17, width - x - 12);
        ctx.font = text.font;
        ctx.fillStyle = gift ? GOLD : INK;
        const lineH = text.size * 1.12;
        const first = cy - ((text.lines.length - 1) * lineH) / 2 + text.size * 0.36;
        text.lines.forEach((row, i) => ctx.fillText(row, x, first + i * lineH));
      },
      crossfade,
      now,
    );
  }
}

// ---- alerts ------------------------------------------------------------------------

const TOAST = { minWidth: 220, height: 84, gap: 10, icon: 25, life: 6, loudLife: 7.5 };

/** What goes between the name and the highlighted end: "duda enviou Rose", "duda ativou Fura-fila!". */
export function alertVerb(kind: AlertKind): string {
  return kind === "gift" ? " enviou " : kind === "perk" ? " ativou " : " ";
}

/** The name card's second line: what they did ("enviou Rose ×5", "começou a seguir"). */
export function toastLine(kind: AlertKind, detail: string): string {
  return `${alertVerb(kind)}${detail}`.trim();
}

/** How many name cards fit between `top` and `floor` (at most three; none when there's no room). */
export function toastSlots(top: number, floor: number): number {
  return Math.max(0, Math.min(3, Math.floor((floor - top + TOAST.gap) / (TOAST.height + TOAST.gap))));
}

const TOAST_MARKS: Record<AlertKind, Mark> = { gift: diamond, follow: plus, share, level: star, crown, perk: diamond, raffle: sparkle };

/**
 * Alerts as name cards, right of the character, newest on top: the
 * viewer's name big, what they did under it in the alert's color, and a
 * mark in a disc. Each slides in from the edge with a pop; the loud ones (a
 * gift, a new top gifter, a gift power) glow gold or pink.
 */
export class Alerts {
  private readonly items: Array<{ sprite: TextSprite; bornAt: number; slot: Spring; kind: AlertKind; parts: [string, string]; width: number }> = [];
  private readonly pool: TextSprite[] = [];
  private glow = CYAN;
  private compact = false;

  constructor(private readonly gl: Gl) {}

  setGlow(color: string): void {
    this.glow = color;
  }

  /** A name card is up (or coming in). Runs every frame: no closures. */
  get showing(): boolean {
    for (let i = 0; i < this.items.length; i++) if ((this.items[i] as { sprite: TextSprite }).sprite.opacity.target > 0) return true;
    return false;
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

  /** `top` is where the stack starts; only `slots` name cards stay up at once; `compact` sizes them for a game. */
  update(dt: number, now: number, top: number, slots: number, compact: boolean, scale: number): void {
    if (compact !== this.compact) {
      this.compact = compact;
      this.repaint(scale);
    }
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
    const max = columnWidth(this.compact);
    const accent = this.accent(kind);
    const loud = kind === "gift" || kind === "crown" || kind === "perk";
    const textX = 12 + icon * 2 + 12;
    const room = max - textX - 14;
    const name = shrinkToFit(parts[0], 860, 29, 20, room);
    const line = shrinkToFit(parts[1], 780, 22, 17, room);
    const natural = Math.max(measureWith(name.font)(name.text), measureWith(line.font)(line.text));
    const width = Math.max(TOAST.minWidth, Math.min(max, Math.ceil(textX + natural + 18)));
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
      const cx = 12 + icon;
      ctx.save();
      ctx.shadowColor = withAlpha(accent, 0.8);
      ctx.shadowBlur = 12;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(cx, height / 2, icon, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      TOAST_MARKS[kind](ctx, cx, height / 2 + (kind === "crown" ? 2 : 0), 25, DEEP);
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
 * Where the "dono da live" badge sits (ADR-0039): left of the character,
 * under the kings card (it follows the card's bottom), above the moment
 * stage. A game board covers that spot, so the badge gives way to it.
 */
const BOSS = { gap: 12, height: 100, glow: 26 };

/** A loud gold badge: a crown, "DONO DA LIVE", the name, and how long the reign has left. */
export class BossBadge {
  readonly sprite: TextSprite;
  private name: string | null = null;
  /** When the reign ends, on the stage clock (seconds). */
  private endsAt = 0;
  private second = Number.NaN;
  private shownAt = 0;
  private now = 0;
  private below: number = HUD.sideTop;
  private readonly top = new Spring(HUD.sideTop, SPRINGS.snappy);

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

  /** `below` is where the kings card ends; `away` (0 to 1) how far a game board has come in. */
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
    return below + BOSS.gap;
  }

  /** Repaints when the second on the countdown changes. */
  private paint(now: number, scale: number): void {
    const left = Math.max(0, Math.ceil(this.endsAt - now - 1e-6));
    if (left === this.second || !this.name) return;
    this.second = left;
    const name = this.name;
    const { height, glow } = BOSS;
    const width = HUD.column;
    const clock = formatClock(left);
    const shown = shrinkToFit(name, 860, 30, 20, width - 84 - 14);
    const clockFont = font(820, 18);
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
      roundRect(ctx, 0, 0, width, height, 24);
      ctx.fill();
      ctx.restore();
      const edge = ctx.createLinearGradient(0, 0, width, height);
      edge.addColorStop(0, CREAM);
      edge.addColorStop(0.5, GOLD);
      edge.addColorStop(1, EMBER);
      ctx.strokeStyle = edge;
      ctx.lineWidth = 3;
      roundRect(ctx, 1.5, 1.5, width - 3, height - 3, 23);
      ctx.stroke();
      // The crown, big, in a soft gold disc.
      ctx.fillStyle = withAlpha(GOLD, 0.2);
      ctx.beginPath();
      ctx.arc(44, height / 2, 30, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.shadowColor = withAlpha(GOLD, 0.9);
      ctx.shadowBlur = 12;
      crown(ctx, 44, height / 2 + 2, 36, GOLD);
      ctx.restore();
      sparkle(ctx, 64, height / 2 - 22, 12, "#FFF6D6");
      ctx.textBaseline = "alphabetic";
      ctx.font = font(900, 19);
      ctx.fillStyle = GOLD;
      ctx.fillText("DONO DA LIVE", 84, 30);
      ctx.save();
      ctx.shadowColor = withAlpha(GOLD, 0.85);
      ctx.shadowBlur = 14;
      ctx.font = shown.font;
      ctx.fillStyle = CREAM;
      ctx.fillText(shown.text, 84, 63);
      ctx.restore();
      // How long the reign has left, hot in its last half minute.
      ctx.font = clockFont;
      ctx.fillStyle = ending ? "#FFB3BC" : withAlpha(GOLD, 0.85);
      ctx.fillText(`por mais ${clock}`, 84, 88);
    });
  }
}
