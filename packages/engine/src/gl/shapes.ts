import { RECT_VERTEX } from "./shaders";
import type { Program, Texture } from "./gl";
import type { StageContext } from "../stage/layer";

/**
 * Flat UI on the GPU (game boards, bars, timers, chips): rounded rectangles
 * from a distance field, with a border, an outer glow and an optional shine,
 * and pieces of text textures drawn at any rect. Anything that animates
 * every frame is drawn here instead of repainting a canvas.
 */
export const SHAPE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform vec4 u_rect;  // the quad on the stage, glow margin included
uniform vec4 u_box;   // half width, half height, corner radius, glow reach (stage px)
uniform vec4 u_fill;  // straight rgba
uniform vec4 u_line;  // border rgba
uniform vec4 u_glow;  // outer glow rgba
uniform vec3 u_fx;    // stage px per output px, shine position (<0: off), border width
void main() {
  vec2 p = (v_uv - 0.5) * u_rect.zw;
  vec2 q = abs(p) - u_box.xy + u_box.z;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_box.z;
  float aa = u_fx.x;
  float inside = 1.0 - smoothstep(-aa, aa, d);
  // Lit from above, a little.
  float a = u_fill.a * inside;
  vec3 c = u_fill.rgb * (1.1 - 0.2 * (p.y / u_box.y * 0.5 + 0.5)) * a;
  if (u_fx.y >= 0.0) {
    float x = p.x / u_box.x * 0.5 + 0.5 - p.y / u_box.y * 0.12;
    c += vec3(0.3) * exp(-pow((x - u_fx.y) * 7.0, 2.0)) * a;
  }
  float bw = u_fx.z * 0.5;
  float edge = (1.0 - smoothstep(bw - aa, bw + aa, abs(d + bw))) * u_line.a;
  c = c * (1.0 - edge) + u_line.rgb * edge;
  a = a * (1.0 - edge) + edge;
  float k = clamp(1.0 - d / max(u_box.w, 1.0), 0.0, 1.0);
  float g = u_glow.a * k * k * (1.0 - inside);
  c += u_glow.rgb * g * (1.0 - a);
  a += g * (1.0 - a);
  o = vec4(c, a);
}`;

/** A region of a texture (premultiplied) drawn at any rect. */
export const PIECE_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec4 u_uv;
uniform float u_opacity;
void main() {
  o = texture(u_tex, u_uv.xy + v_uv * u_uv.zw) * u_opacity;
}`;

export type Rgba = readonly [number, number, number, number];
export const NONE: Rgba = [0, 0, 0, 0];

export function rgba(hex: string, alpha = 1): Rgba {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

export class ShapeDrawer {
  private readonly shape: Program | null;
  private readonly piece: Program | null;

  constructor(private readonly ctx: StageContext) {
    this.shape = ctx.program("shape", RECT_VERTEX, SHAPE_FRAGMENT);
    this.piece = ctx.program("piece", RECT_VERTEX, PIECE_FRAGMENT);
  }

  /**
   * A rounded rect. `alpha` scales everything; `border` in stage px; `shine`
   * 0..1 sweeps a highlight across (negative: none).
   */
  box(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    fill: Rgba,
    alpha: number,
    line: Rgba = NONE,
    glow: Rgba = NONE,
    glowReach = 0,
    border = 3,
    shine = -1,
    scale = 1,
  ): void {
    if (!this.shape || alpha <= 0.004 || w <= 0 || h <= 0) return;
    const m = glow[3] > 0 ? glowReach : 0;
    const r = Math.min(radius, w / 2, h / 2);
    this.shape
      .use()
      .v2("u_res", 1080, 1920)
      .v4("u_rect", x - m, y - m, w + m * 2, h + m * 2)
      .v4("u_box", w / 2, h / 2, r, m)
      .v4("u_fill", fill[0], fill[1], fill[2], fill[3] * alpha)
      .v4("u_line", line[0], line[1], line[2], line[3] * alpha)
      .v4("u_glow", glow[0], glow[1], glow[2], glow[3] * alpha)
      .v3("u_fx", 1 / scale, shine, border);
    this.ctx.quad.draw();
  }

  /** Draws the region (u, v, du, dv in 0..1) of `texture` at a rect. */
  texture(texture: Texture, u: number, v: number, du: number, dv: number, x: number, y: number, w: number, h: number, opacity: number): void {
    if (!this.piece || opacity <= 0.004) return;
    texture.bind(0);
    this.piece.use().v2("u_res", 1080, 1920).v4("u_rect", x, y, w, h).v4("u_uv", u, v, du, dv).i("u_tex", 0).f("u_opacity", opacity);
    this.ctx.quad.draw();
  }
}
