import type { Rgb } from "../color";
import type { Gl, Program, QuadGeometry } from "../gl/gl";
import type { TextSprite } from "../text/sprites";

/**
 * The stage is a stack of layers (ADR-0009). The engine owns the clock, the
 * protocol and the GPU context; each layer owns its programs and sprites,
 * updates from the shared `Frame` and draws itself in stack order.
 */
export interface Layer {
  /** Advances animation by `dt` seconds. Must not allocate. */
  update(dt: number, frame: Frame): void;
  /** Draws into the bound output. Must not allocate. */
  draw(frame: Frame): void;
  /** Re-rasterizes text (fonts loaded, scale changed, context restored). */
  repaint?(scale: number): void;
}

/** What layers get from the engine: the GPU, a shared quad and a sprite drawer. */
export interface StageContext {
  readonly gl: Gl;
  readonly quad: QuadGeometry;
  /** Compiles a program; a failure is reported in telemetry and returns null. */
  program(name: string, vertex: string, fragment: string): Program | null;
  drawSprite(sprite: TextSprite): void;
  /** Binds the output (canvas or capture target) as the draw target. */
  bindOutput(): void;
}

/**
 * Per-frame state shared between layers, written in update order: the engine
 * (time, voice, colors), the character (where it is), the effects (flashes).
 * One instance for the engine's lifetime, so the frame loop never allocates.
 */
export class Frame {
  t = 0;
  scale = 1;
  /** Atmosphere colors: the host's look, blended toward a game's palette. */
  readonly primary: Rgb = [0, 0, 0];
  readonly secondary: Rgb = [0, 0, 0];
  readonly background: Rgb = [0, 0, 0];
  /** The host's own colors (the character keeps them during games). */
  readonly hostPrimary: Rgb = [0, 0, 0];
  readonly hostSecondary: Rgb = [0, 0, 0];
  amplitude = 0;
  glow = 0.6;
  /** Gold light around the character (gift arrivals). */
  flash = 0;
  /** Gold over the whole stage (the biggest gifts). */
  screenFlash = 0;
  /** 0..1: the spotlight effect. */
  spotlight = 0;
  /** 0..1: how far into game layout the stage is (smaller character, caption lower). */
  game = 0;
  /** The character's body, as drawn this frame. */
  orbX = 540;
  orbY = 720;
  orbR = 165;
  orbAlpha = 1;
  squash = 0;
  /** 1 = orb, 0 = voice line. */
  characterMix = 1;
  moteFraction = 1;
  speaking = false;
  /** Where the now-playing chip goes, right of the AI badge (the text layer's; read a frame later). */
  nowPlayingX = 320;
  nowPlayingY = 262;
}
