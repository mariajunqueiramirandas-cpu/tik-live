import { hexToRgb } from "../color";
import type { Program, QuadGeometry, RenderTarget } from "../gl/gl";
import { ATMOSPHERE_FRAGMENT, GLOW_DOT_FRAGMENT, MOTES_VERTEX, RECT_VERTEX, UPSCALE_FRAGMENT } from "../gl/shaders";
import type { Frame, Layer, StageContext } from "./layer";

export const STAGE_WIDTH = 1080;
export const STAGE_HEIGHT = 1920;
export const GOLD = hexToRgb("#FFD15C");

/**
 * The atmosphere renders at 1/4 of the output size in each direction (1/16
 * of the pixels): it's all soft gradients, light and slow caustics, and
 * comparisons against full resolution stay above 46 dB PSNR.
 */
const DOWNSCALE = 4;
const MOTES = 96;

/** Water, light, the character's halo and the drifting motes. */
export class AtmosphereLayer implements Layer {
  private readonly atmosphere: Program | null;
  private readonly upscale: Program | null;
  private readonly motes: Program | null;
  private readonly target: RenderTarget;
  private readonly moteQuad: QuadGeometry;

  constructor(
    private readonly ctx: StageContext,
    random: () => number,
  ) {
    this.atmosphere = ctx.program("atmosphere", RECT_VERTEX, ATMOSPHERE_FRAGMENT);
    this.upscale = ctx.program("upscale", RECT_VERTEX, UPSCALE_FRAGMENT);
    this.motes = ctx.program("motes", MOTES_VERTEX, GLOW_DOT_FRAGMENT);
    this.target = ctx.gl.target("high");
    this.moteQuad = ctx.gl.quad();
    const seeds = new Float32Array(MOTES * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = random();
    this.moteQuad.attachInstances(1, 4, seeds);
  }

  /** Follows the output size (canvas or capture target), at 1/`downscale` of it (finer at higher quality). */
  resize(width: number, height: number, downscale = DOWNSCALE): void {
    this.target.resize(Math.max(1, Math.ceil(width / downscale)), Math.max(1, Math.ceil(height / downscale)));
  }

  get ready(): boolean {
    return this.atmosphere !== null;
  }

  update(): void {}

  draw(f: Frame): void {
    const gl = this.ctx.gl.gl;
    const atmosphere = this.atmosphere;
    if (!atmosphere) return;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    // Soft everywhere: render it small (its cost was half of every frame in
    // software rendering), then scale it up with dithering. Without the
    // upscale program, draw it directly.
    if (this.upscale) this.target.bindForDrawing();
    else this.ctx.bindOutput();
    atmosphere
      .use()
      .v2("u_res", STAGE_WIDTH, STAGE_HEIGHT)
      .v4("u_rect", 0, 0, STAGE_WIDTH, STAGE_HEIGHT)
      .f("u_time", f.t)
      .rgb("u_bg", f.background)
      .rgb("u_primary", f.primary)
      .rgb("u_secondary", f.secondary)
      .rgb("u_gold", GOLD)
      .v2("u_orb", f.orbX, f.orbY)
      .f("u_glow", f.glow)
      .f("u_flash", f.flash)
      .v4("u_halo", f.orbR, f.squash, f.amplitude, f.orbAlpha)
      .f("u_haloAa", 2.4 / (f.orbR * f.scale))
      .v2("u_fx", f.spotlight, f.screenFlash);
    this.ctx.quad.draw();
    if (this.upscale) {
      this.ctx.bindOutput();
      this.target.bind(0);
      this.upscale.use().v2("u_res", STAGE_WIDTH, STAGE_HEIGHT).v4("u_rect", 0, 0, STAGE_WIDTH, STAGE_HEIGHT).i("u_tex", 0);
      this.ctx.quad.draw();
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if (this.motes) {
      this.motes.use().v2("u_res", STAGE_WIDTH, STAGE_HEIGHT).f("u_time", f.t).v2("u_orb", f.orbX, f.orbY).f("u_amp", f.amplitude).rgb("u_color", f.primary);
      this.moteQuad.draw(Math.round(MOTES * f.moteFraction));
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
}
