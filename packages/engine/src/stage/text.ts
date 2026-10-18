import { TopLikers, UpNext } from "../text/hud";
import { Alerts, Caption, Chrome } from "../text/sprites";
import type { Frame, Layer, StageContext } from "./layer";

/** Segment title, AI-disclosure badge, up next, top likers, alerts and the caption: always on top. */
export class TextLayer implements Layer {
  readonly caption: Caption;
  readonly alerts: Alerts;
  readonly chrome: Chrome;
  readonly upNext: UpNext;
  readonly likers: TopLikers;

  constructor(private readonly ctx: StageContext) {
    this.caption = new Caption(ctx.gl);
    this.alerts = new Alerts(ctx.gl);
    this.chrome = new Chrome(ctx.gl);
    this.upNext = new UpNext(ctx.gl);
    this.likers = new TopLikers(ctx.gl);
  }

  setGlow(color: string, scale: number): void {
    this.caption.setGlow(color);
    this.alerts.setGlow(color);
    this.chrome.setGlow(color, scale);
    this.upNext.setGlow(color, scale);
  }

  update(dt: number, f: Frame): void {
    this.caption.update(dt, f.t, f.scale, f.game);
    this.alerts.update(dt, f.t);
    this.chrome.update(dt, f.t);
    this.upNext.update(dt, f.t, f.scale);
    this.likers.update(dt, f.t, this.upNext.height, f.game);
  }

  draw(): void {
    const { ctx } = this;
    ctx.drawSprite(this.chrome.title);
    ctx.drawSprite(this.upNext.card);
    ctx.drawSprite(this.upNext.timer);
    ctx.drawSprite(this.likers.sprite);
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
    this.likers.repaint(scale);
  }
}
