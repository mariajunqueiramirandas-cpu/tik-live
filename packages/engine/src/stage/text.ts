import { Alerts, Caption, Chrome } from "../text/sprites";
import type { Frame, Layer, StageContext } from "./layer";

/** Segment title, AI-disclosure badge, alerts and the caption: always on top. */
export class TextLayer implements Layer {
  readonly caption: Caption;
  readonly alerts: Alerts;
  readonly chrome: Chrome;

  constructor(private readonly ctx: StageContext) {
    this.caption = new Caption(ctx.gl);
    this.alerts = new Alerts(ctx.gl);
    this.chrome = new Chrome(ctx.gl);
  }

  setGlow(color: string, scale: number): void {
    this.caption.setGlow(color);
    this.alerts.setGlow(color);
    this.chrome.setGlow(color, scale);
  }

  update(dt: number, f: Frame): void {
    this.caption.update(dt, f.t, f.scale, f.game);
    this.alerts.update(dt, f.t);
    this.chrome.update(dt, f.t);
  }

  draw(): void {
    const { ctx } = this;
    ctx.drawSprite(this.chrome.title);
    // The disclosure badge is a legal requirement: it's drawn last but one and never hidden.
    ctx.drawSprite(this.chrome.badge);
    this.alerts.forEachSprite(ctx.drawSprite);
    ctx.drawSprite(this.caption.sprite);
  }

  repaint(scale: number): void {
    this.caption.invalidate();
    this.alerts.repaint(scale);
    this.chrome.repaint(scale);
  }
}
