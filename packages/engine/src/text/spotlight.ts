import type { Challenge, GoalKind, GoalView, LeaderBoard, LeaderRow, PerksCard, SupportCard } from "@tik-live/shared";
import { Spring, SPRINGS } from "../anim/spring";
import type { Gl } from "../gl/gl";
import {
  bar,
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
  goalFraction,
  goalLeft,
  heart,
  HEART,
  HOT,
  HUD,
  lineOrTwo,
  type Mark,
  medal,
  outlined,
  paintPanel,
  PERK_PINK,
  RAFFLE_GREEN,
  shrinkToFit,
  sparkle,
  stageY,
  star,
  sweep,
  tab,
  TAB_H,
  tabWidth,
  VIOLET,
  WAY_COLORS,
  WAY_MARKS,
  windowLabel,
  type Canvas2D,
} from "./kit";
import { GOLD, HAZE, INK, measureWith, roundRect, TextSprite, withAlpha } from "./sprites";

/**
 * The moment stage (ADR-0049): one card at a time right under the
 * character, where the eye goes after the face, and the busiest place on
 * the stage. The server's banners have it first: a challenge or raffle
 * (ADR-0040), then a call to people scrolling past (ADR-0037), then how to
 * support the show (ADR-0032), then the gift showcase (ADR-0041). When none
 * is up, the stage's own moments take turns there (a goal almost reached,
 * the top three when they change, a reminder of what takes the crown), and
 * otherwise up next rests there on its countdown ring (`hud.ts`). A game
 * board covers the spot, so it all gives way to the board.
 */

const CENTER_X = 540;
/** The stage's cards are as wide as the safe frame. */
const WIDE = HUD.right - HUD.margin;
/** Repaints of anything moving, at most this often. */
const FRAME_S = 1 / 30;

function dropIn(sprite: TextSprite): void {
  sprite.opacity.snap(0);
  sprite.opacity.target = 1;
  sprite.offsetY.snap(40);
  sprite.offsetY.target = 0;
}

/** Puts a stage card's body, `width` wide and `height` tall, centered in the stage. */
function placeOnStage(sprite: TextSprite, width: number, height: number): void {
  sprite.x = CENTER_X - width / 2 - 14;
  sprite.y = stageY(height) - 14;
}

/** A gentle bob once a card has landed. */
function bob(sprite: TextSprite, now: number, since: number, amount = 4): void {
  if (now - since > 0.6) sprite.offsetY.target = Math.sin((now - since) * 3.2) * amount;
}

// ---- the call to people scrolling past ----------------------------------------------

const HOOK = { ends: 72, label: "ACABOU DE CHEGAR?" };

/**
 * A big, bright call to people scrolling past (ADR-0037), under a tab that
 * speaks to them ("ACABOU DE CHEGAR?"). Long calls wrap to two lines
 * instead of being cut.
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
    dropIn(this.sprite);
    this.sprite.pop(0.9);
  }

  /** A call is up. */
  get active(): boolean {
    return this.text !== null;
  }

  /** `away` (0 to 1) is how far a game board has come in, or 1 while a challenge has the spot: the banner gives way to them. */
  update(dt: number, now: number, away: number): void {
    if (this.text) {
      this.sprite.opacity.target = away > 0.05 ? 0 : 1;
      bob(this.sprite, now, this.shownAt, 5);
    }
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.text) this.paint(scale);
  }

  private paint(scale: number): void {
    const text = (this.text as string).toUpperCase();
    const room = WIDE - HOOK.ends * 2;
    // One line if it fits from 42 down to 32 px, else two lines.
    const lines = lineOrTwo(text, 900, 42, 32, 34, 26, room);
    const measure = measureWith(lines.font);
    const textW = Math.max(...lines.lines.map((line) => measure(line)));
    const labelW = tabWidth(HOOK.label, star);
    const width = Math.min(WIDE, Math.max(textW + HOOK.ends * 2, labelW + 80));
    const bannerH = lines.lines.length === 1 ? 86 : 118;
    const height = TAB_H / 2 + bannerH;
    placeOnStage(this.sprite, width, height);
    paintPanel(this.sprite, width, height, scale, (ctx) => {
      const top = TAB_H / 2;
      const radius = Math.min(bannerH / 2, 43);
      ctx.save();
      ctx.shadowColor = "rgba(255,61,139,0.75)";
      ctx.shadowBlur = 14;
      const fill = ctx.createLinearGradient(0, 0, width, 0);
      fill.addColorStop(0, "#FF3D8B");
      fill.addColorStop(1, "#FFB03B");
      ctx.fillStyle = fill;
      roundRect(ctx, 0, top, width, bannerH, radius);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 3;
      roundRect(ctx, 1.5, top + 1.5, width - 3, bannerH - 3, radius - 1);
      ctx.stroke();
      // Light along the top, and a twinkle at each end.
      const shine = ctx.createLinearGradient(0, top, 0, top + bannerH / 2);
      shine.addColorStop(0, "rgba(255,255,255,0.35)");
      shine.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = shine;
      roundRect(ctx, 6, top + 4, width - 12, bannerH / 2, radius / 2);
      ctx.fill();
      sparkle(ctx, HOOK.ends / 2 + 4, top + bannerH / 2, 28, "#FFF6D6");
      sparkle(ctx, width - HOOK.ends / 2 - 4, top + bannerH / 2, 28, "#FFF6D6");
      ctx.font = lines.font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const lineH = lines.size * 1.12;
      const first = top + bannerH / 2 - ((lines.lines.length - 1) * lineH) / 2 + 3;
      lines.lines.forEach((line, i) => outlined(ctx, line, width / 2, first + i * lineH, "#FFFFFF", "rgba(90,10,40,0.6)", 7));
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      // The tab on top, speaking to whoever just arrived.
      tab(ctx, width / 2 - labelW / 2, 0, HOOK.label, CYAN, star);
    });
  }
}

// ---- how to support the show --------------------------------------------------------

const SUPPORT_H = 144;

/**
 * How to support the show (ADR-0032), for the 20 seconds the server keeps
 * it up: the title, and the ways to help in two columns, gifts in gold.
 * In a game the support line by the goals says it instead.
 */
export class SupportBanner {
  readonly sprite: TextSprite;
  private card: SupportCard | null = null;
  private shownAt = 0;

  constructor(gl: Gl) {
    this.sprite = new TextSprite(gl);
  }

  /** The card is up. */
  get active(): boolean {
    return this.card !== null;
  }

  set(card: SupportCard | null, now: number, scale: number): void {
    this.card = card;
    if (!card) {
      this.sprite.opacity.target = 0;
      return;
    }
    this.shownAt = now;
    this.paint(scale);
    dropIn(this.sprite);
  }

  /** `away` (0 to 1): a game board coming in, or 1 while something louder has the spot. */
  update(dt: number, now: number, away: number): void {
    if (this.card) {
      this.sprite.opacity.target = away > 0.05 ? 0 : 1;
      bob(this.sprite, now, this.shownAt);
    }
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.card) this.paint(scale);
  }

  private paint(scale: number): void {
    const support = this.card as SupportCard;
    const width = WIDE;
    const height = SUPPORT_H;
    const lines = support.lines.slice(0, 4);
    placeOnStage(this.sprite, width, height);
    paintPanel(this.sprite, width, height, scale, (ctx) => {
      card(ctx, width, height, GOLD, HEART, 30);
      const tabW = tab(ctx, 18, 14, "APOIE A LIVE", GOLD, diamond);
      const title = shrinkToFit(support.title, 820, 27, 20, width - 18 - tabW - 18 - 18);
      ctx.font = title.font;
      ctx.fillStyle = INK;
      ctx.fillText(title.text, 18 + tabW + 18, 14 + TAB_H / 2 + 9);
      // The ways to help in two columns.
      const colW = (width - 36 - 12) / 2;
      lines.forEach((line, i) => {
        const x = 18 + (i % 2) * (colW + 12);
        const cy = 14 + TAB_H + 14 + Math.floor(i / 2) * 42 + 18;
        const color = WAY_COLORS[line.way];
        ctx.fillStyle = withAlpha(color, 0.2);
        ctx.beginPath();
        ctx.arc(x + 17, cy, 17, 0, Math.PI * 2);
        ctx.fill();
        WAY_MARKS[line.way](ctx, x + 17, cy, 18, color);
        const text = shrinkToFit(line.text, 780, 24, 18, colW - 46);
        ctx.font = text.font;
        ctx.fillStyle = line.way === "gift" ? GOLD : INK;
        ctx.fillText(text.text, x + 44, cy + 8);
      });
    });
  }
}

// ---- the gift showcase -------------------------------------------------------------

const SHOWCASE_H = 146;
/** Each tile pops in this long after the one before, over this long. */
const TILE_STAGGER_S = 0.12;
const TILE_IN_S = 0.3;

/** How far tile `i` has popped in, 0 to 1, `t` seconds after the showcase went up. */
export function tileReveal(t: number, i: number): number {
  return Math.max(0, Math.min(1, (t - i * TILE_STAGGER_S) / TILE_IN_S));
}

/**
 * What each gift does on the show (ADR-0041): the title on a gold tab, what
 * every gift gets on the right, and one tile per gift power with its price,
 * the biggest one crowned. The tiles pop in one by one, then the card bobs
 * while it's up. It gives way to anything louder.
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

  /** The showcase is up. */
  get active(): boolean {
    return this.card !== null;
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
    dropIn(this.sprite);
  }

  /** `away` (0 to 1): a game board coming in, or 1 while something louder has the spot. */
  update(dt: number, now: number, away: number, scale: number): void {
    if (this.card) {
      this.sprite.opacity.target = away > 0.05 ? 0 : 1;
      if (!this.revealed && now - this.paintedAt >= FRAME_S) this.paint(scale, now);
      bob(this.sprite, now, this.shownAt);
    }
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.card) this.paint(scale, this.paintedAt);
  }

  private paint(scale: number, now: number): void {
    const card = this.card as PerksCard;
    const width = WIDE;
    const height = SHOWCASE_H;
    const rows = card.rows.slice(0, 5);
    const t = now - this.shownAt;
    this.paintedAt = now;
    this.revealed = tileReveal(t, rows.length - 1) >= 1;
    placeOnStage(this.sprite, width, height);
    const priceFont = font(900, 23);
    paintPanel(this.sprite, width, height, scale, (ctx) => {
      ctx.save();
      ctx.shadowColor = withAlpha(GOLD, 0.55);
      ctx.shadowBlur = 14;
      ctx.fillStyle = "rgba(14,6,36,0.92)";
      roundRect(ctx, 0, 0, width, height, 28);
      ctx.fill();
      ctx.restore();
      const edge = ctx.createLinearGradient(0, 0, width, 0);
      edge.addColorStop(0, GOLD);
      edge.addColorStop(0.5, PERK_PINK);
      edge.addColorStop(1, GOLD);
      ctx.strokeStyle = edge;
      ctx.lineWidth = 3;
      roundRect(ctx, 1.5, 1.5, width - 3, height - 3, 27);
      ctx.stroke();
      // The header: the title on a gold tab, what every gift gets on the right.
      const gold = ctx.createLinearGradient(0, 12, 0, 12 + TAB_H);
      gold.addColorStop(0, CREAM);
      gold.addColorStop(1, GOLD);
      const title = fit(card.title.toUpperCase(), font(900, 22), width * 0.5);
      const titleW = tab(ctx, 16, 12, title, gold, diamond);
      if (card.every) {
        const room = width - 18 - (16 + titleW + 18);
        const every = shrinkToFit(card.every, 780, 22, 16, room);
        ctx.font = every.font;
        ctx.textAlign = "right";
        ctx.fillStyle = INK;
        ctx.fillText(every.text, width - 18, 12 + TAB_H / 2 + 8);
        ctx.textAlign = "left";
      }
      // One tile per power in two rows, cheapest first: the price in a chip, then what it does. The biggest is crowned in gold.
      const gap = 8;
      const cols = Math.ceil(rows.length / 2);
      const tileW = (width - 24 - gap * (cols - 1)) / cols;
      const tileTop = 12 + TAB_H + 8;
      const tileH = (height - 12 - tileTop - gap) / 2;
      const chipW = Math.max(...rows.map((row) => measureWith(priceFont)(formatCount(row.diamonds)))) + 44;
      rows.forEach((row, i) => {
        const p = tileReveal(t, i);
        if (p <= 0) return;
        const best = i === rows.length - 1 && rows.length > 1;
        const color = best ? GOLD : DIAMOND;
        const x = 12 + (i % cols) * (tileW + gap);
        const y = tileTop + Math.floor(i / cols) * (tileH + gap) + (1 - p) * 10;
        const cy = y + tileH / 2;
        ctx.save();
        ctx.globalAlpha = p;
        if (best) {
          ctx.shadowColor = withAlpha(GOLD, 0.7);
          ctx.shadowBlur = 12;
        }
        ctx.fillStyle = withAlpha(color, best ? 0.22 : 0.1);
        roundRect(ctx, x, y, tileW, tileH, tileH / 2);
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = p;
        ctx.strokeStyle = withAlpha(color, best ? 0.95 : 0.45);
        ctx.lineWidth = 2;
        roundRect(ctx, x + 1, y + 1, tileW - 2, tileH - 2, tileH / 2 - 1);
        ctx.stroke();
        // The price: a diamond and the number in a chip.
        ctx.fillStyle = withAlpha(color, best ? 0.32 : 0.2);
        roundRect(ctx, x + 4, y + 4, chipW, tileH - 8, (tileH - 8) / 2);
        ctx.fill();
        diamond(ctx, x + 23, cy + 1, 18, color);
        ctx.font = priceFont;
        ctx.fillStyle = best ? GOLD : INK;
        ctx.fillText(formatCount(row.diamonds), x + 38, cy + 8);
        // What it does, shrunk to fit before it's cut, and a crown on the biggest.
        const crowned = best ? 32 : 0;
        const label = shrinkToFit(row.text, 800, 23, 17, tileW - chipW - 24 - crowned);
        ctx.font = label.font;
        ctx.fillStyle = best ? GOLD : INK;
        ctx.fillText(label.text, x + chipW + 14, cy + 8);
        if (best) crown(ctx, x + tileW - 28, cy, 22, GOLD);
        ctx.restore();
      });
    });
  }
}

// ---- challenges and the raffle -------------------------------------------------------

/**
 * A challenge for the room or a raffle (ADR-0040): a title with how to
 * take part, a bar that says what's left, and a countdown that turns hot
 * and beats every second at the end.
 */
const CHALLENGE_H = 140;
const CHALLENGE_COLORS: Record<Challenge["kind"], readonly [string, string]> = {
  likes: [HEART, GOLD],
  chat: [CYAN, VIOLET],
  raffle: [RAFFLE_GREEN, CYAN],
};
const CHALLENGE_MARKS: Record<Challenge["kind"], Mark> = { likes: heart, chat: bubble, raffle: sparkle };
/** The countdown's last seconds: hot, and a beat every second. */
const CHALLENGE_FINAL_S = 10;

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

/** What the bar says: the count, and while it runs, what's left ("640 / 1.000 · FALTAM 360"). */
export function challengeBarText(challenge: Pick<Challenge, "kind" | "title" | "value" | "target" | "result" | "winner">): string {
  const { line } = challengeHeadline(challenge);
  if (challenge.kind === "raffle" || challenge.result !== null || challenge.value >= challenge.target) return line;
  return `${line} · ${goalLeft(challenge)}`;
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

  /** A challenge is up (everything else on the stage steps aside). */
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
      dropIn(this.sprite);
      dropIn(this.timer);
      this.sprite.pop(0.92);
    } else if (challenge.result !== null && before?.result === null) {
      // It just ended: a hop for the result.
      this.shownAt = now;
      this.sprite.offsetY.snap(-18);
      this.sprite.offsetY.target = 0;
      this.sprite.pop(challenge.result === "won" ? 1.1 : 1.04);
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
        const wave = Math.sin((now - this.shownAt) * 3.2) * 4;
        this.sprite.offsetY.target = wave;
        this.timer.offsetY.target = wave;
      }
      this.bar.step(dt);
      const moved = Math.abs(this.bar.value - this.barPainted) > 0.004;
      if (moved && now - this.barPaintedAt >= FRAME_S) this.paint(scale, now);
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

  private colors(challenge: Challenge): readonly [string, string] {
    if (challenge.result === "won") return [GOLD, EMBER];
    if (challenge.result === "lost") return ["#FF7A8A", VIOLET];
    return CHALLENGE_COLORS[challenge.kind];
  }

  private paint(scale: number, now: number): void {
    const challenge = this.challenge as Challenge;
    const width = WIDE;
    const height = CHALLENGE_H;
    const [a, b] = this.colors(challenge);
    const { title, line } = challengeHeadline(challenge);
    const fraction = Math.max(0, Math.min(1, this.bar.value));
    this.barPainted = this.bar.value;
    this.barPaintedAt = now;
    const running = challenge.result === null;
    const raffle = challenge.kind === "raffle";
    // Room on the right of the title row for the countdown chip.
    const timerRoom = running ? 124 : 0;
    placeOnStage(this.sprite, width, height);
    paintPanel(this.sprite, width, height, scale, (ctx) => {
      ctx.save();
      ctx.shadowColor = withAlpha(a, 0.6);
      ctx.shadowBlur = 14;
      const body = ctx.createLinearGradient(0, 0, width, height);
      body.addColorStop(0, "rgba(22,8,46,0.94)");
      body.addColorStop(1, challenge.result === "won" ? "rgba(84,52,10,0.94)" : "rgba(12,6,30,0.92)");
      ctx.fillStyle = body;
      roundRect(ctx, 0, 0, width, height, 30);
      ctx.fill();
      ctx.restore();
      const edge = ctx.createLinearGradient(0, 0, width, 0);
      edge.addColorStop(0, a);
      edge.addColorStop(1, b);
      ctx.strokeStyle = edge;
      ctx.lineWidth = 3;
      roundRect(ctx, 1.5, 1.5, width - 3, height - 3, 29);
      ctx.stroke();

      // Title row: the kind's mark in a solid disc, the title, and (while it runs) how to take part.
      const markX = 44;
      const rowY = 42;
      ctx.save();
      ctx.shadowColor = withAlpha(a, 0.8);
      ctx.shadowBlur = 12;
      ctx.fillStyle = a;
      ctx.beginPath();
      ctx.arc(markX, rowY, 25, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      (challenge.result === "won" ? crown : CHALLENGE_MARKS[challenge.kind])(ctx, markX, rowY + 1, 27, DEEP);
      ctx.textBaseline = "middle";
      const titleRoom = width - 82 - 20 - timerRoom;
      const shownTitle = shrinkToFit(title, 900, 38, 28, titleRoom);
      ctx.font = shownTitle.font;
      ctx.save();
      ctx.shadowColor = withAlpha(a, 0.7);
      ctx.shadowBlur = 14;
      const fill = ctx.createLinearGradient(0, rowY - 20, 0, rowY + 20);
      fill.addColorStop(0, "#FFFFFF");
      fill.addColorStop(1, challenge.result === "won" ? GOLD : a);
      ctx.fillStyle = fill;
      ctx.fillText(shownTitle.text, 82, rowY + 2);
      ctx.restore();
      const titleW = measureWith(shownTitle.font)(shownTitle.text);
      if (running && !raffle && challenge.detail) {
        const room = titleRoom - titleW - 16;
        const detail = shrinkToFit(`· ${challenge.detail}`, 780, 26, 20, room);
        if (room > 70) {
          ctx.font = detail.font;
          ctx.fillStyle = "rgba(244,240,255,0.85)";
          ctx.fillText(detail.text, 82 + titleW + 12, rowY + 3);
        }
      }

      // Second row: the bar to the target, or the raffle's entry word and count.
      const barX = 20;
      const barY = 78;
      const barW = width - 40;
      const barH = 46;
      if (raffle) {
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        roundRect(ctx, barX, barY, barW, barH, barH / 2);
        ctx.fill();
        const lineFont = font(880, 26);
        if (running && challenge.detail) {
          // The word to type, big and bright, then the entries on the right.
          const wordFont = font(900, 27);
          const word = fit(challenge.detail.toUpperCase(), wordFont, barW * 0.55);
          const pillW = measureWith(wordFont)(word) + 40;
          ctx.fillStyle = a;
          roundRect(ctx, barX + 4, barY + 4, pillW, barH - 8, (barH - 8) / 2);
          ctx.fill();
          ctx.font = wordFont;
          ctx.fillStyle = DEEP;
          ctx.fillText(word, barX + 24, barY + barH / 2 + 1);
          ctx.font = lineFont;
          ctx.textAlign = "right";
          ctx.fillStyle = INK;
          ctx.fillText(fit(line, lineFont, barW - pillW - 40), barX + barW - 20, barY + barH / 2 + 1);
        } else {
          ctx.font = lineFont;
          ctx.textAlign = "center";
          ctx.fillStyle = challenge.result === "won" ? GOLD : INK;
          ctx.fillText(fit(line, lineFont, barW - 40), barX + barW / 2, barY + barH / 2 + 1);
        }
        ctx.textAlign = "left";
      } else {
        bar(ctx, barX, barY, barW, barH, fraction, a, b, challenge.result === "lost" ? 0.5 : 1);
        const text = shrinkToFit(challengeBarText(challenge), 900, 27, 21, barW - 40);
        ctx.font = text.font;
        ctx.textAlign = "center";
        outlined(ctx, text.text, barX + barW / 2, barY + barH / 2 + 1);
        ctx.textAlign = "left";
      }
      ctx.textBaseline = "alphabetic";
      if (challenge.result === "won") {
        sparkle(ctx, width - 34, 24, 24, "#FFF6D6");
        sparkle(ctx, width - 68, 52, 14, "#FFF6D6");
        sparkle(ctx, 20, 18, 15, "#FFF6D6");
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
    const final = left <= CHALLENGE_FINAL_S && challenge.result === null;
    if (final && left > 0) this.timer.pop(1.16);
    const text = formatClock(left);
    const f = font(900, 27);
    const width = Math.max(94, measureWith(f)(text) + 32);
    const height = 46;
    const color = final ? HOT : CHALLENGE_COLORS[challenge.kind][0];
    this.timer.x = CENTER_X + WIDE / 2 - 20 - width - 14;
    this.timer.y = stageY(CHALLENGE_H) + 42 - height / 2 - 14;
    paintPanel(this.timer, width, height, scale, (ctx: Canvas2D) => {
      ctx.fillStyle = final ? withAlpha(HOT, 0.9) : withAlpha(color, 0.2);
      roundRect(ctx, 0, 0, width, height, height / 2);
      ctx.fill();
      ctx.strokeStyle = withAlpha(color, 0.9);
      ctx.lineWidth = 2;
      roundRect(ctx, 1, 1, width - 2, height - 2, (height - 2) / 2);
      ctx.stroke();
      ctx.font = f;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = final ? "#FFFFFF" : INK;
      ctx.fillText(text, width / 2, height / 2 + 1);
    });
  }
}

// ---- the stage's own moments -----------------------------------------------------------

/** What the stage brings up on its own: a goal almost reached, or a ranking's top three. */
export type MomentKind = "near-likes" | "near-gifts" | "rank-gifts" | "rank-likes";

/** How long a moment stays up. */
const MOMENT_S = 6;
/** A moment doesn't come back sooner than this after it was last up. */
const MOMENT_COOLDOWN_S: Record<MomentKind, number> = { "near-likes": 30, "near-gifts": 30, "rank-gifts": 12, "rank-likes": 40 };
/** Which moment goes first when several wait: lower first. */
const MOMENT_RANK: Record<MomentKind, number> = { "near-likes": 0, "near-gifts": 0, "rank-gifts": 1, "rank-likes": 2 };
/** A moment waiting longer than this (the stage was busy) is old news. */
const MOMENT_STALE_S = 20;
/** With the stage free and quiet this long, a ranking comes back as a reminder. */
const MOMENT_REMIND_S = 45;

/**
 * Decides what the stage's own moments show, one at a time, in the order
 * they came up: each stays `MOMENT_S`, waits out its cooldown before it can
 * come back, and is dropped if the stage stayed busy too long. When the
 * stage has been free and quiet for a while, the rankings take turns coming
 * back as a reminder. No allocation per frame once warmed up.
 */
export class MomentQueue {
  private readonly queue: Array<{ kind: MomentKind; at: number }> = [];
  private current: MomentKind | null = null;
  private endsAt = 0;
  private readonly lastAt: Record<MomentKind, number> = { "near-likes": -Infinity, "near-gifts": -Infinity, "rank-gifts": -Infinity, "rank-likes": -Infinity };
  private idleSince = 0;
  private remind: "rank-gifts" | "rank-likes" = "rank-gifts";

  /** Asks for a moment (ignored while it's up, waiting, or cooling down). */
  push(kind: MomentKind, now: number): void {
    if (this.current === kind || now - this.lastAt[kind] < MOMENT_COOLDOWN_S[kind]) return;
    for (let i = 0; i < this.queue.length; i++) if ((this.queue[i] as { kind: MomentKind }).kind === kind) return;
    this.queue.push({ kind, at: now });
  }

  /** What's up now. `free`: nothing else has the stage; `has(kind)`: there's something to show for it. */
  tick(now: number, free: boolean, has: (kind: MomentKind) => boolean): MomentKind | null {
    if (this.current && (!free || now >= this.endsAt || !has(this.current))) {
      this.current = null;
      this.idleSince = now;
    }
    if (!free) {
      this.idleSince = now;
      return null;
    }
    if (this.current) return this.current;
    // Old news goes; of the rest, a goal almost reached goes first, then in the order they came.
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const item = this.queue[i] as { kind: MomentKind; at: number };
      if (now - item.at > MOMENT_STALE_S || !has(item.kind)) this.queue.splice(i, 1);
    }
    if (this.queue.length) {
      let pick = 0;
      for (let i = 0; i < this.queue.length; i++) if (MOMENT_RANK[(this.queue[i] as { kind: MomentKind }).kind] < MOMENT_RANK[(this.queue[pick] as { kind: MomentKind }).kind]) pick = i;
      const [next] = this.queue.splice(pick, 1);
      this.start((next as { kind: MomentKind }).kind, now);
      return this.current;
    }
    if (now - this.idleSince >= MOMENT_REMIND_S) {
      const first = this.remind;
      const other = first === "rank-gifts" ? "rank-likes" : "rank-gifts";
      const kind = has(first) ? first : has(other) ? other : null;
      this.remind = kind === "rank-gifts" ? "rank-likes" : "rank-gifts";
      if (kind) this.start(kind, now);
      else this.idleSince = now;
    }
    return this.current;
  }

  private start(kind: MomentKind, now: number): void {
    this.current = kind;
    this.endsAt = now + MOMENT_S;
    this.lastAt[kind] = now;
  }
}

/** Where the stage's moments read their numbers. */
export interface MomentSource {
  rows(board: LeaderBoard): readonly LeaderRow[];
  windowMin(board: LeaderBoard): number;
  goal(kind: GoalKind): GoalView | undefined;
  near(kind: GoalKind): boolean;
}

/** "FALTAM 37 CURTIDAS PRA BATER A META!", "FALTA 1 DIAMANTE PRA BATER A META!". */
export function nearLine(goal: Pick<GoalView, "kind" | "value" | "target">): string {
  const left = Math.max(0, goal.target - goal.value);
  const unit = goal.kind === "likes" ? (left === 1 ? "CURTIDA" : "CURTIDAS") : left === 1 ? "DIAMANTE" : "DIAMANTES";
  return `${goalLeft(goal)} ${unit} PRA BATER A META!`;
}

const MOMENT_H = 140;
/** While a goal's moment is up, the light along its bar repaints this often. */
const NEAR_FRAME_S = 1 / 15;
const RANK_LOOK: Record<LeaderBoard, { title: string; color: string; mark: Mark; value: Mark; valueColor: string }> = {
  gifts: { title: "TOP DOADORES", color: GOLD, mark: crown, value: diamond, valueColor: DIAMOND },
  likes: { title: "TOP CURTIDAS", color: HEART, mark: heart, value: heart, valueColor: HEART },
};

/**
 * The stage's own moments, on one card: "QUASE LÁ!" with what's left and
 * the bar when a goal is close, or a ranking's top three side by side when
 * it changes (or now and then as a reminder), with what takes the crown or
 * how to climb. Names at the center, where people look: being seen there
 * is the reason to tap and to gift.
 */
export class MomentStage {
  readonly sprite: TextSprite;
  readonly queue = new MomentQueue();
  private showing: MomentKind | null = null;
  private shownAt = 0;
  private dirty = false;
  private paintedAt = 0;
  private readonly has = (kind: MomentKind): boolean => {
    switch (kind) {
      case "near-likes":
        return this.source.near("likes");
      case "near-gifts":
        return this.source.near("gifts");
      case "rank-gifts":
        return this.source.rows("gifts").length > 0;
      default:
        return this.source.rows("likes").length > 0;
    }
  };

  constructor(
    gl: Gl,
    private readonly source: MomentSource,
  ) {
    this.sprite = new TextSprite(gl);
  }

  /** One of the stage's moments is up. */
  get active(): boolean {
    return this.showing !== null;
  }

  /** A goal or a ranking changed: repaint if its moment is up. */
  touch(): void {
    this.dirty = true;
  }

  /** `free`: nothing louder has the stage (no banner, no game, no final countdown). */
  update(dt: number, now: number, free: boolean, scale: number): void {
    const kind = this.queue.tick(now, free, this.has);
    if (kind !== this.showing) {
      const was = this.showing;
      this.showing = kind;
      if (kind) {
        this.shownAt = now;
        this.paint(kind, scale, was !== null, now);
        if (was === null) dropIn(this.sprite);
        this.sprite.pop(was === null ? 0.92 : 1.05);
      } else this.sprite.opacity.target = 0;
    } else if (kind && ((this.dirty && now - this.paintedAt >= 0.25) || (this.near(kind) && now - this.paintedAt >= NEAR_FRAME_S))) this.paint(kind, scale, false, now);
    if (kind) bob(this.sprite, now, this.shownAt);
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.showing) this.paint(this.showing, scale, false, this.paintedAt);
  }

  /** A goal's moment: the light runs along its bar while it's up. */
  private near(kind: MomentKind): boolean {
    return kind === "near-likes" || kind === "near-gifts";
  }

  private paint(kind: MomentKind, scale: number, crossfade: boolean, now: number): void {
    this.dirty = false;
    this.paintedAt = now;
    if (kind === "near-likes" || kind === "near-gifts") this.paintNear(kind === "near-likes" ? "likes" : "gifts", scale, crossfade, now);
    else this.paintRank(kind === "rank-gifts" ? "gifts" : "likes", scale, crossfade, now);
  }

  /** A goal almost reached: the tab, what's left in big letters, and the bar with a light along it. */
  private paintNear(kind: GoalKind, scale: number, crossfade: boolean, now: number): void {
    const goal = this.source.goal(kind);
    if (!goal) return;
    const color = kind === "likes" ? HEART : DIAMOND;
    const width = WIDE;
    const height = MOMENT_H;
    placeOnStage(this.sprite, width, height);
    paintPanel(
      this.sprite,
      width,
      height,
      scale,
      (ctx) => {
        card(ctx, width, height, color, GOLD, 30);
        const tabW = tab(ctx, 18, 14, "QUASE LÁ!", color, kind === "likes" ? heart : diamond);
        const line = shrinkToFit(nearLine(goal), 900, 34, 22, width - 18 - tabW - 18 - 18);
        ctx.font = line.font;
        ctx.textBaseline = "middle";
        ctx.fillStyle = INK;
        ctx.fillText(line.text, 18 + tabW + 16, 14 + TAB_H / 2 + 2);
        ctx.textBaseline = "alphabetic";
        bar(ctx, 18, 70, width - 36, 52, goalFraction(goal), color, GOLD);
        sweep(ctx, 18, 70, width - 36, 52, 26, ((now - this.shownAt) % 1.6) / 1.6, 0.5);
        const pct = `${Math.floor(goalFraction(goal) * 100)}%`;
        ctx.font = font(900, 28);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        outlined(ctx, `${formatCount(goal.value)} / ${formatCount(goal.target)} · ${pct}`, width / 2, 97);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
      },
      crossfade,
      now,
    );
  }

  /** A ranking's top three side by side, with what takes the crown (gifts) or how to climb (likes). */
  private paintRank(board: LeaderBoard, scale: number, crossfade: boolean, now: number): void {
    const rows = this.source.rows(board).slice(0, 3);
    const look = RANK_LOOK[board];
    const gold = board === "gifts";
    const width = WIDE;
    const height = MOMENT_H;
    placeOnStage(this.sprite, width, height);
    paintPanel(
      this.sprite,
      width,
      height,
      scale,
      (ctx) => {
        let body: string | CanvasGradient = "rgba(13,7,34,0.9)";
        if (gold) {
          const warm = ctx.createLinearGradient(0, 0, 0, height);
          warm.addColorStop(0, "rgba(36,12,64,0.94)");
          warm.addColorStop(1, "rgba(64,34,18,0.92)");
          body = warm;
        }
        card(ctx, width, height, look.color, gold ? DIAMOND : VIOLET, 30, body);
        let fill: string | CanvasGradient = look.color;
        if (gold) {
          const g = ctx.createLinearGradient(0, 14, 0, 14 + TAB_H);
          g.addColorStop(0, CREAM);
          g.addColorStop(1, GOLD);
          fill = g;
        }
        const tabW = tab(ctx, 18, 14, look.title, fill, look.mark);
        const window = windowLabel(this.source.windowMin(board));
        const chipW = chip(ctx, 18 + tabW + 10 + measureWith(font(850, 20))(window) + 24, 14, window, gold ? DIAMOND : HAZE);
        // The call on the right: what takes the crown, or how to climb.
        const callX = 18 + tabW + 10 + chipW + 18;
        if (gold && rows[0]) {
          const target = crownTarget(rows[0].value);
          const valueFont = font(900, 26);
          const valueW = measureWith(valueFont)(target);
          ctx.font = valueFont;
          ctx.textAlign = "right";
          ctx.fillStyle = GOLD;
          ctx.fillText(target, width - 18, 14 + TAB_H / 2 + 9);
          ctx.textAlign = "left";
          diamond(ctx, width - 18 - valueW - 15, 14 + TAB_H / 2 + 1, 19, DIAMOND);
          const label = shrinkToFit(`${CROWN_LABEL}:`, 820, 24, 17, width - 18 - valueW - 34 - callX);
          ctx.font = label.font;
          ctx.textAlign = "right";
          ctx.fillStyle = CREAM;
          ctx.fillText(label.text, width - 18 - valueW - 32, 14 + TAB_H / 2 + 9);
          ctx.textAlign = "left";
        } else if (!gold) {
          const call = shrinkToFit("Toque na tela pra subir!", 820, 24, 17, width - 18 - callX);
          ctx.font = call.font;
          ctx.textAlign = "right";
          ctx.fillStyle = HEART;
          ctx.fillText(call.text, width - 18, 14 + TAB_H / 2 + 9);
          ctx.textAlign = "left";
        }
        // The top three, side by side: a medal, the name, and the count under it.
        const cellW = (width - 36 - 16) / 3;
        rows.forEach((row, i) => {
          const x = 18 + i * (cellW + 8);
          const y = 62;
          const h = height - y - 12;
          ctx.fillStyle = i === 0 ? withAlpha(look.color, 0.22) : "rgba(255,255,255,0.06)";
          roundRect(ctx, x, y, cellW, h, 18);
          ctx.fill();
          if (i === 0) {
            ctx.strokeStyle = withAlpha(look.color, 0.7);
            ctx.lineWidth = 1.5;
            roundRect(ctx, x + 0.75, y + 0.75, cellW - 1.5, h - 1.5, 17);
            ctx.stroke();
          }
          medal(ctx, x + 28, y + h / 2, 17, i + 1);
          if (i === 0 && gold) crown(ctx, x + 28, y + h / 2 - 22, 16, CREAM);
          const textX = x + 54;
          const name = shrinkToFit(row.name, 850, 27, 18, cellW - 54 - 12);
          ctx.font = name.font;
          ctx.fillStyle = i === 0 && gold ? CREAM : INK;
          ctx.fillText(name.text, textX, y + 32);
          const value = formatCount(row.value);
          look.value(ctx, textX + 8, y + 51, 15, look.valueColor);
          ctx.font = font(880, 21);
          ctx.fillStyle = look.valueColor;
          ctx.fillText(value, textX + 22, y + 59);
        });
      },
      crossfade,
      now,
    );
  }
}

