import { Alerts, BossBadge, Chrome, GoalPanel, LeaderCard, SupportTicker, toastSlots, UpNext } from "../text/hud";
import { HUD } from "../text/kit";
import { ChallengeBanner, GiftShowcase, HookBanner } from "../text/spotlight";
import { Caption } from "../text/sprites";
import type { Frame, Layer, StageContext } from "./layer";

/** Name cards end above the spotlight under the character (it starts near y 900). */
const ALERTS_FLOOR = 888;

/**
 * The HUD (ADR-0049), always on top: the show bar (segment title and the
 * AI-disclosure badge), up next and the ranking card on the left, the
 * goals, the support ticker and the alerts on the right, the spotlight
 * under the character (a challenge, a call to passers-by or the gift
 * showcase), the "dono da live", and the caption. During a game the side
 * panels fold to their essentials and the spotlight gives way to the board.
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

  update(dt: number, f: Frame): void {
    // Past halfway into a game, the side panels fold to fit above the board.
    const compact = f.game > 0.5;
    this.caption.update(dt, f.t, f.scale, f.game);
    this.chrome.update(dt, f.t);
    // The now-playing chip (the effects layer's) sits right of the badge.
    f.nowPlayingX = this.chrome.badgeRight + 12;
    f.nowPlayingY = HUD.badgeTop;
    this.upNext.update(dt, f.t, f.scale);
    this.card.update(dt, f.t, this.upNext.height, compact, f.scale);
    this.goals.update(dt, f.t, compact, f.scale);
    this.ticker.update(dt, f.t, this.goals.bottom(), compact, f.scale);
    // Name cards stack under the ticker, as many as fit above the spotlight (or the board).
    const top = this.ticker.bottom(this.goals.bottom()) + HUD.gap;
    this.alerts.update(dt, f.t, top, toastSlots(top, compact ? HUD.boardTop : ALERTS_FLOOR));
    // A challenge takes the hook's spot while it's up, and the gift showcase steps aside for both.
    this.hook.update(dt, f.t, this.challenge.active ? 1 : f.game);
    this.challenge.update(dt, f.t, f.game, f.scale);
    this.showcase.update(dt, f.t, this.challenge.active || this.hook.active ? 1 : f.game, f.scale);
    this.boss.update(dt, f.t, this.card.bottom(this.upNext.height), f.game, f.scale);
  }

  draw(): void {
    const { ctx } = this;
    ctx.drawSprite(this.chrome.title);
    ctx.drawSprite(this.upNext.card);
    ctx.drawSprite(this.upNext.ring);
    ctx.drawSprite(this.card.aura);
    ctx.drawSprite(this.card.sprite);
    ctx.drawSprite(this.goals.sprite);
    ctx.drawSprite(this.ticker.sprite);
    ctx.drawSprite(this.showcase.sprite);
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
  }
}
