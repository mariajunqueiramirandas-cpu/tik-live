import type { Challenge, PerksCard } from "@tik-live/shared";
import { Spring, SPRINGS } from "../anim/spring";
import type { Gl } from "../gl/gl";
import {
  bar,
  bubble,
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
  goalLeft,
  heart,
  HEART,
  HOT,
  type Mark,
  outlined,
  paintPanel,
  PERK_PINK,
  RAFFLE_GREEN,
  shrinkToFit,
  sparkle,
  star,
  tab,
  TAB_H,
  tabWidth,
  VIOLET,
  lineOrTwo,
  type Canvas2D,
} from "./kit";
import { GOLD, INK, measureWith, roundRect, TextSprite, withAlpha } from "./sprites";

/**
 * The spotlight (ADR-0049): the one call to action under the character,
 * above the caption. A challenge or raffle (ADR-0040) has it first, then a
 * call to people scrolling past (ADR-0037), then the gift showcase
 * (ADR-0041); a game board covers the spot, so they all give way to it.
 * Whatever has the spot drops in and bobs gently while it's up, so the
 * eye that lands on the character finds it next.
 */

/** The spotlight's center line and the top of its slot (the caption's first line starts near y 1060). */
const CENTER_X = 540;
/** Repaints of anything moving, at most this often. */
const FRAME_S = 1 / 30;

function dropIn(sprite: TextSprite): void {
  sprite.opacity.snap(0);
  sprite.opacity.target = 1;
  sprite.offsetY.snap(46);
  sprite.offsetY.target = 0;
}

// ---- the call to people scrolling past ----------------------------------------------

const HOOK = { top: 900, maxWidth: 980, ends: 72, label: "ACABOU DE CHEGAR?" };

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
    const room = HOOK.maxWidth - HOOK.ends * 2;
    // One line if it fits from 44 down to 34 px, else two lines.
    const lines = lineOrTwo(text, 900, 44, 34, 36, 28, room);
    const measure = measureWith(lines.font);
    const textW = Math.max(...lines.lines.map((line) => measure(line)));
    const labelW = tabWidth(HOOK.label, star);
    const width = Math.min(HOOK.maxWidth, Math.max(textW + HOOK.ends * 2, labelW + 80));
    const bannerH = lines.lines.length === 1 ? 88 : 124;
    const height = TAB_H / 2 + bannerH;
    this.sprite.x = CENTER_X - width / 2 - 14;
    this.sprite.y = HOOK.top - 14;
    paintPanel(this.sprite, width, height, scale, (ctx) => {
      const top = TAB_H / 2;
      const radius = Math.min(bannerH / 2, 44);
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

// ---- the gift showcase -------------------------------------------------------------

/** In the challenge's place under the character, above the caption. */
const SHOWCASE = { top: 892, width: 980, height: 160 };
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
    dropIn(this.sprite);
  }

  /** `away` (0 to 1): a game board coming in, or 1 while a challenge or a call has the spot. */
  update(dt: number, now: number, away: number, scale: number): void {
    if (this.card) {
      this.sprite.opacity.target = away > 0.05 ? 0 : 1;
      if (!this.revealed && now - this.paintedAt >= FRAME_S) this.paint(scale, now);
      if (now - this.shownAt > 0.6) this.sprite.offsetY.target = Math.sin((now - this.shownAt) * 3.2) * 4;
    }
    this.sprite.update(dt, now);
  }

  repaint(scale: number): void {
    if (this.card) this.paint(scale, this.paintedAt);
  }

  private paint(scale: number, now: number): void {
    const card = this.card as PerksCard;
    const { width, height } = SHOWCASE;
    const rows = card.rows.slice(0, 5);
    const t = now - this.shownAt;
    this.paintedAt = now;
    this.revealed = tileReveal(t, rows.length - 1) >= 1;
    this.sprite.x = CENTER_X - width / 2 - 14;
    this.sprite.y = SHOWCASE.top - 14;
    const priceFont = font(900, 26);
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
      const gold = ctx.createLinearGradient(0, 14, 0, 14 + TAB_H);
      gold.addColorStop(0, CREAM);
      gold.addColorStop(1, GOLD);
      const title = fit(card.title.toUpperCase(), font(900, 22), width * 0.5);
      const titleW = tab(ctx, 18, 14, title, gold, diamond);
      if (card.every) {
        const room = width - 18 - (18 + titleW + 20);
        const every = shrinkToFit(card.every, 780, 23, 18, room);
        ctx.font = every.font;
        ctx.textAlign = "right";
        ctx.fillStyle = INK;
        ctx.fillText(every.text, width - 22, 14 + TAB_H / 2 + 8);
        ctx.textAlign = "left";
      }
      // One tile per power in two rows, cheapest first: the price in a chip, then what it does. The biggest is crowned in gold.
      const gap = 10;
      const cols = Math.ceil(rows.length / 2);
      const tileW = (width - 28 - gap * (cols - 1)) / cols;
      const tileTop = 14 + TAB_H + 10;
      const tileH = (height - 14 - tileTop - gap) / 2;
      const chipW = Math.max(...rows.map((row) => measureWith(priceFont)(formatCount(row.diamonds)))) + 48;
      rows.forEach((row, i) => {
        const p = tileReveal(t, i);
        if (p <= 0) return;
        const best = i === rows.length - 1 && rows.length > 1;
        const color = best ? GOLD : DIAMOND;
        const x = 14 + (i % cols) * (tileW + gap);
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
        ctx.strokeStyle = withAlpha(color, best ? 0.95 : 0.45);
        ctx.lineWidth = 2;
        roundRect(ctx, x + 1, y + 1, tileW - 2, tileH - 2, tileH / 2 - 1);
        ctx.stroke();
        // The price: a diamond and the number in a chip.
        ctx.fillStyle = withAlpha(color, best ? 0.32 : 0.2);
        roundRect(ctx, x + 5, y + 5, chipW, tileH - 10, (tileH - 10) / 2);
        ctx.fill();
        diamond(ctx, x + 26, cy + 1, 20, color);
        ctx.font = priceFont;
        ctx.fillStyle = best ? GOLD : INK;
        ctx.fillText(formatCount(row.diamonds), x + 42, cy + 9);
        // What it does, shrunk to fit before it's cut, and a crown on the biggest.
        const crowned = best ? 34 : 0;
        const label = shrinkToFit(row.text, 800, 25, 20, tileW - chipW - 26 - crowned);
        ctx.font = label.font;
        ctx.fillStyle = best ? GOLD : INK;
        ctx.fillText(label.text, x + chipW + 16, cy + 9);
        if (best) crown(ctx, x + tileW - 30, cy, 24, GOLD);
        ctx.restore();
      });
    });
  }
}

// ---- challenges and the raffle -------------------------------------------------------

/**
 * A challenge for the room or a raffle (ADR-0040), in the spotlight: a
 * title with how to take part, a bar that says what's left, and a
 * countdown that turns hot and beats every second at the end.
 */
const CHALLENGE = { top: 900, width: 960, height: 150 };
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
        const bob = Math.sin((now - this.shownAt) * 3.2) * 4;
        this.sprite.offsetY.target = bob;
        this.timer.offsetY.target = bob;
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
    const { width, height } = CHALLENGE;
    const [a, b] = this.colors(challenge);
    const { title, line } = challengeHeadline(challenge);
    const fraction = Math.max(0, Math.min(1, this.bar.value));
    this.barPainted = this.bar.value;
    this.barPaintedAt = now;
    const running = challenge.result === null;
    const raffle = challenge.kind === "raffle";
    // Room on the right of the title row for the countdown chip.
    const timerRoom = running ? 130 : 0;
    this.sprite.x = CENTER_X - width / 2 - 14;
    this.sprite.y = CHALLENGE.top - 14;
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
      const markX = 46;
      const rowY = 46;
      ctx.save();
      ctx.shadowColor = withAlpha(a, 0.8);
      ctx.shadowBlur = 12;
      ctx.fillStyle = a;
      ctx.beginPath();
      ctx.arc(markX, rowY, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      (challenge.result === "won" ? crown : CHALLENGE_MARKS[challenge.kind])(ctx, markX, rowY + 1, 28, DEEP);
      ctx.textBaseline = "middle";
      const titleRoom = width - 86 - 24 - timerRoom;
      const shownTitle = shrinkToFit(title, 900, 40, 30, titleRoom);
      ctx.font = shownTitle.font;
      ctx.save();
      ctx.shadowColor = withAlpha(a, 0.7);
      ctx.shadowBlur = 14;
      const fill = ctx.createLinearGradient(0, rowY - 20, 0, rowY + 20);
      fill.addColorStop(0, "#FFFFFF");
      fill.addColorStop(1, challenge.result === "won" ? GOLD : a);
      ctx.fillStyle = fill;
      ctx.fillText(shownTitle.text, 86, rowY + 2);
      ctx.restore();
      const titleW = measureWith(shownTitle.font)(shownTitle.text);
      if (running && !raffle && challenge.detail) {
        const room = titleRoom - titleW - 18;
        const detail = shrinkToFit(`· ${challenge.detail}`, 780, 27, 22, room);
        if (room > 70) {
          ctx.font = detail.font;
          ctx.fillStyle = "rgba(244,240,255,0.85)";
          ctx.fillText(detail.text, 86 + titleW + 14, rowY + 3);
        }
      }

      // Second row: the bar to the target, or the raffle's entry word and count.
      const barX = 22;
      const barY = 84;
      const barW = width - 44;
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
    const f = font(900, 28);
    const width = Math.max(96, measureWith(f)(text) + 34);
    const height = 48;
    const color = final ? HOT : CHALLENGE_COLORS[challenge.kind][0];
    this.timer.x = CENTER_X + CHALLENGE.width / 2 - 22 - width - 14;
    this.timer.y = CHALLENGE.top + 46 - height / 2 - 14;
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
