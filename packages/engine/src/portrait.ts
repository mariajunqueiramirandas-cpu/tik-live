import type { Emotion, Look } from "@tik-live/shared";
import { facePose } from "./character/face";
import { hexToRgb } from "./color";
import { Gl } from "./gl/gl";
import { ATMOSPHERE_FRAGMENT, ORB_FRAGMENT, RECT_VERTEX } from "./gl/shaders";
import { GOLD } from "./stage/atmosphere";

export interface PortraitOptions {
  /** Width and height of the picture, in pixels. */
  size?: number;
  emotion?: Emotion;
  /** Moment of the orb's wobble and the water's motion, in seconds. */
  time?: number;
}

/**
 * The character as a square profile picture: the stage's own atmosphere and
 * orb shaders drawn once, so the picture matches what viewers see live. The
 * shaders' constants are tuned for a 1080 px wide stage, so it draws a
 * logical 1080×1080 square scaled to `size`. Throws without WebGL2.
 */
export function renderPortrait(look: Look, options: PortraitOptions = {}): Promise<Blob> {
  const size = Math.round(options.size ?? 1080);
  const time = options.time ?? 4;
  const logical = 1080;
  const scale = size / logical;
  // A profile picture is cropped to a circle: the orb and its halo stay well inside it.
  const orb = { x: logical / 2, y: logical / 2, r: 330, extent: 1.25 };
  const primary = hexToRgb(look.primary);
  const secondary = hexToRgb(look.secondary);
  const face = facePose(options.emotion ?? "happy");

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const gl = new Gl(canvas, { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const g = gl.gl;
  try {
    const quad = gl.quad();
    g.viewport(0, 0, size, size);
    g.disable(g.BLEND);
    gl.program("atmosphere", RECT_VERTEX, ATMOSPHERE_FRAGMENT)
      .use()
      .v2("u_res", logical, logical)
      .v4("u_rect", 0, 0, logical, logical)
      .f("u_time", time)
      .rgb("u_bg", hexToRgb(look.background))
      .rgb("u_primary", primary)
      .rgb("u_secondary", secondary)
      .rgb("u_gold", GOLD)
      .v2("u_orb", orb.x, orb.y)
      .f("u_glow", 0.6)
      .f("u_flash", 0)
      .v4("u_halo", orb.r, 0, 0, 1)
      .f("u_haloAa", 2.4 / (orb.r * scale))
      .v2("u_fx", 0, 0);
    quad.draw();

    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    const half = orb.r * orb.extent;
    gl.program("orb", RECT_VERTEX, ORB_FRAGMENT)
      .use()
      .v2("u_res", logical, logical)
      .v4("u_rect", orb.x - half, orb.y - half, half * 2, half * 2)
      .f("u_time", time)
      .f("u_amp", 0)
      .rgb("u_primary", primary)
      .rgb("u_secondary", secondary)
      .rgb("u_ink", hexToRgb("#0B0420"))
      .rgb("u_gold", GOLD)
      .f("u_desat", face.desat)
      .f("u_flash", 0)
      .f("u_squash", 0)
      .f("u_extent", orb.extent)
      .f("u_px", 1 / (orb.r * scale))
      .v4("u_eye", face.eye[0], face.eye[1], face.eye[2], face.eye[3])
      .v4("u_eye2", face.eye2[0], face.eye2[1], face.eye2[2], face.eye2[3])
      .v2("u_gaze", face.gaze[0], face.gaze[1])
      .v4("u_mouth", face.mouth[0], face.mouth[1], face.mouth[2], face.mouth[3])
      .v2("u_vowel", face.vowel[0], face.vowel[1])
      .f("u_blush", face.blush)
      .f("u_alpha", 1)
      .f("u_rot", face.tilt);
    quad.draw();
  } catch (error) {
    g.getExtension("WEBGL_lose_context")?.loseContext();
    throw error;
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      // Browsers cap live WebGL contexts; give this one back right away.
      g.getExtension("WEBGL_lose_context")?.loseContext();
      if (blob) resolve(blob);
      else reject(new Error("The portrait could not be encoded"));
    }, "image/png");
  });
}
