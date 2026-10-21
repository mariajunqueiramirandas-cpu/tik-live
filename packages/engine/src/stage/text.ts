import type { LeaderBoard, LeaderRow } from "@tik-live/shared";
import { Alerts, BossBadge, Chrome, giftCameIn, GoalPanel, LeaderCard, SupportTicker, toastSlots, UpNext, type NextPlacement } from "../text/hud";
import { HUD } from "../text/kit";
import { ChallengeBanner, GiftShowcase, HookBanner, MomentStage, SupportBanner } from "../text/spotlight";
import { Caption } from "../text/sprites";
import type { Frame, Layer, StageContext } from "./layer";

/** Name cards end just above the moment stage. */
const ALERTS_FLOOR = HUD.stageTop - 8;

/** The names in a ranking's top three, in order, as one comparable string. */
function podiumKey(rows: readonly LeaderRow[]): string {
  return rows
    .slice(0, 3)
    .map((row) => row.name)
    .join("\n");
}

/**
 * The HUD (ADR-0049), always on top. Calm edges: the title and the AI
 * badge, the kings left of the character, the goals, the support line and
 * the name cards right of it, the "dono da live". A busy center: the
 * moment stage under the character, where a challenge, a call to
 * passers-by, how to support the show, the gift showcase, a goal almost
 * reached or a ranking's top three take turns, and up next rests when
 * nothing else is up; then the caption. During a game the side cards fold,
 * up next moves atop the left column, and the stage gives way to the board.
 */
export class TextLayer implements Layer {
  readonly caption: Caption;
  readonly alerts: Alerts;
  readonly chrome: Chrome;
  readonly upNext: UpNext;
  readonly card: LeaderCard;
  readonly goals: GoalPanel;
  readonly hook: HookBanner;
  readonly boss: BossBadge;
  readonly challenge: ChallengeBanner;
  readonly ticker: SupportTicker;
  readonly showcase: GiftShowcase;
  readonly support: SupportBanner;
  readonly moments: MomentStage;

  constructor(private readonly ctx: StageContext) {
    this.caption = new Caption(ctx.gl);
    this.alerts = new Alerts(ctx.gl);
    this.chrome = new Chrome(ctx.gl);
    this.upNext = new UpNext(ctx.gl);
    this.card = new LeaderCard(ctx.gl);
    this.goals = new GoalPanel(ctx.gl);
    this.hook = new HookBanner(ctx.gl);
    this.boss = new BossBadge(ctx.gl);
    this.challenge = new ChallengeBanner(ctx.gl);
    this.ticker = new SupportTicker(ctx.gl);
    this.showcase = new GiftShowcase(ctx.gl);
    this.support = new SupportBanner(ctx.gl);
    const { card, goals } = this;
    this.moments = new MomentStage(ctx.gl, {
      rows: (board) => card.rows(board),
      windowMin: (board) => card.windowMin(board),
      goal: (kind) => goals.goal(kind),
      near: (kind) => goals.near(kind),
    });
  }

  setGlow(color: string, scale: number): void {
    this.caption.setGlow(color);
    this.alerts.setGlow(color);
    this.chrome.setGlow(color, scale);
  }

  /** The look's two colors, for the countdown ring. */
  setColors(primary: string, secondary: string, scale: number): void {
    this.upNext.setColors(primary, secondary, scale);
  }

  /** A ranking changed: the kings card, and the top three on the stage when it matters. */
  leaders(board: LeaderBoard, rows: readonly LeaderRow[], windowMin: number, now: number, scale: number): void {
    const before = this.card.rows(board);
    const moved = podiumKey(before) !== podiumKey(rows);
    const gift = board === "gifts" && giftCameIn(before, rows);
    this.card.set(board, rows, windowMin, now, scale);
    if (board === "gifts" && (gift || moved) && rows.length) this.moments.queue.push("rank-gifts", now);
    // A new first place among the likers (not the first one ever).
    if (board === "likes" && before.length && (before[0]?.name ?? "") !== (rows[0]?.name ?? "")) this.moments.queue.push("rank-likes", now);
    this.moments.touch();
  }

  update(dt: number, f: Frame): void {
    // Past halfway into a game, the side cards fold to fit above the board.
    const compact = f.game > 0.5;
    this.caption.update(dt, f.t, f.scale, f.game);
    this.chrome.update(dt, f.t);
    // The now-playing chip (the effects layer's) sits right of the badge.
    f.nowPlayingX = this.chrome.badgeRight + 12;
    f.nowPlayingY = HUD.chipsTop;

    // The stage: a challenge or a call has it first; up next's last seconds go ahead of the support card and the showcase.
    const loud = this.challenge.active || this.hook.active;
    const urgent = this.upNext.urgent && !compact;
    this.hook.update(dt, f.t, this.challenge.active ? 1 : f.game);
    this.challenge.update(dt, f.t, f.game, f.scale);
    this.support.update(dt, f.t, loud || urgent ? 1 : f.game);
    this.showcase.update(dt, f.t, loud || urgent || this.support.active ? 1 : f.game, f.scale);
    const banner = loud || this.support.active || this.showcase.active;
    // A goal close to done asks for the stage now and then while it's close.
    if (this.goals.near("likes")) this.moments.queue.push("near-likes", f.t);
    if (this.goals.near("gifts")) this.moments.queue.push("near-gifts", f.t);
    this.moments.update(dt, f.t, !compact && !banner && !urgent, f.scale);
    let placement: NextPlacement = "stage";
    if (compact) placement = "column";
    else if ((banner && !urgent) || loud || this.moments.active) placement = "hidden";
    this.upNext.update(dt, f.t, placement, f.scale);

    // The edges.
    this.card.update(dt, f.t, this.upNext.columnHeight, compact, f.scale);
    this.goals.update(dt, f.t, compact, f.scale);
    // In a game the name cards share the support line's spot, and go first.
    const nameCard = compact && this.alerts.showing;
    this.ticker.update(dt, f.t, this.goals.bottom(), compact, nameCard, f.scale);
    const top = (compact ? this.goals.bottom() : this.ticker.bottom(this.goals.bottom())) + HUD.gap;
    this.alerts.update(dt, f.t, top, toastSlots(top, compact ? HUD.boardTop : ALERTS_FLOOR), compact, f.scale);
    this.boss.update(dt, f.t, this.card.bottom(this.upNext.columnHeight), f.game, f.scale);
  }

  draw(): void {
    const { ctx } = this;
    ctx.drawSprite(this.chrome.title);
    ctx.drawSprite(this.card.aura);
    ctx.drawSprite(this.card.sprite);
    ctx.drawSprite(this.goals.sprite);
    ctx.drawSprite(this.ticker.sprite);
    ctx.drawSprite(this.upNext.card);
    ctx.drawSprite(this.upNext.ring);
    ctx.drawSprite(this.moments.sprite);
    ctx.drawSprite(this.showcase.sprite);
    ctx.drawSprite(this.support.sprite);
    ctx.drawSprite(this.hook.sprite);
    ctx.drawSprite(this.challenge.sprite);
    ctx.drawSprite(this.challenge.timer);
    ctx.drawSprite(this.boss.sprite);
    // The disclosure badge is a legal requirement: it's drawn last but one and never hidden.
    ctx.drawSprite(this.chrome.badge);
    this.alerts.forEachSprite(ctx.drawSprite);
    ctx.drawSprite(this.caption.sprite);
  }

  repaint(scale: number): void {
    this.caption.invalidate();
    this.alerts.repaint(scale);
    this.chrome.repaint(scale);
    this.upNext.repaint(scale);
    this.card.repaint(scale);
    this.goals.repaint(scale);
    this.hook.repaint(scale);
    this.boss.repaint(scale);
    this.challenge.repaint(scale);
    this.ticker.repaint(scale);
    this.showcase.repaint(scale);
    this.support.repaint(scale);
    this.moments.repaint(scale);
  }
}
