import type { Emotion } from "@tik-live/shared";
import { Spring, SPRINGS } from "../anim/spring";
import type { AudioEngine } from "../audio/audio";
import type { MouthShape } from "../audio/envelope";
import { FaceController } from "../character/face";
import { hexToRgb } from "../color";
import type { Program } from "../gl/gl";
import { ORB_FRAGMENT, RECT_VERTEX, VOICE_LINE_FRAGMENT } from "../gl/shaders";
import { GOLD, STAGE_HEIGHT, STAGE_WIDTH } from "./atmosphere";
import type { Frame, Layer, StageContext } from "./layer";

export type Move = "spin" | "jump" | "shake";

// extent: the orb quad's half-size in body radii. The body (wobble and squash
// included) stays inside 1.2; the halo around it is drawn with the atmosphere.
// It sits high in the frame TikTok leaves clear, with the moment stage and
// the caption under it, all above TikTok's comment feed (ADR-0050).
const ORB = { x: 540, y: 504, r: 165, extent: 1.25 };
/** During games the character moves up and shrinks so the board fits below, above TikTok's comments. */
const GAME_ORB = { y: 326, r: 92 };
const INK_DARK = hexToRgb("#0B0420");
const TAU = Math.PI * 2;

/** The host: the orb with its face, or the voice line, plus its moves. */
export class CharacterLayer implements Layer {
  readonly face: FaceController;
  /** 1 = orb, 0 = voice line. */
  readonly style = new Spring(1, SPRINGS.gentle);
  private readonly bounce = new Spring(0, SPRINGS.bouncy);
  private readonly glow = new Spring(0.6, SPRINGS.gentle);
  private readonly orb: Program | null;
  private readonly voiceLine: Program | null;
  private readonly vowel: MouthShape = { round: 0, wide: 0 };
  private emotionUntil = Infinity;
  // Move start times (-1: not playing) and strength.
  private spinAt = -1;
  private jumpAt = -1;
  private shakeAt = -1;
  private moveStrength = 1;
  private rotation = 0;
  private offsetX = 0;
  /** The voice line stays level (no idle bob); moves still carry it. */
  private lineY = ORB.y;

  constructor(
    private readonly ctx: StageContext,
    private readonly audio: AudioEngine,
    random: () => number,
  ) {
    this.face = new FaceController(random);
    this.orb = ctx.program("orb", RECT_VERTEX, ORB_FRAGMENT);
    this.voiceLine = ctx.program("voice-line", RECT_VERTEX, VOICE_LINE_FRAGMENT);
  }

  /** Shows an emotion; `holdSeconds` null holds it until `relax`. */
  setEmotion(emotion: Emotion, now: number, holdSeconds: number | null): void {
    this.face.setEmotion(emotion);
    this.emotionUntil = holdSeconds === null ? Infinity : now + holdSeconds;
  }

  /** Lets the current emotion fade back to neutral after a while. */
  relax(now: number, afterSeconds = 2.5): void {
    this.emotionUntil = now + afterSeconds;
  }

  kick(velocity: number): void {
    this.bounce.impulse(velocity);
  }

  move(move: Move, now: number, strength = 1): void {
    this.moveStrength = Math.max(0.5, Math.min(2, strength));
    if (move === "spin") this.spinAt = now;
    else if (move === "jump") this.jumpAt = now;
    else this.shakeAt = now;
  }

  update(dt: number, f: Frame): void {
    const t = f.t;
    this.style.step(dt);
    this.bounce.step(dt);
    this.glow.target = 0.55 + f.amplitude * 0.6;
    this.glow.step(dt);
    f.glow = this.glow.value;
    this.audio.mouthShape(this.vowel);
    if (!f.speaking && t > this.emotionUntil && this.face.current !== "neutral") this.face.setEmotion("neutral");
    this.face.update(dt, t, f.speaking ? f.amplitude : 0, this.vowel);

    const g = f.game;
    const k = 1 + (GAME_ORB.r / ORB.r - 1) * g;
    const s = this.moveStrength;
    // Moves: analytic curves from their start time, so they never drift.
    let lift = 0;
    let p = (t - this.jumpAt) / 0.7;
    if (this.jumpAt >= 0 && p < 1) lift = Math.sin(Math.PI * p) * 150 * k * s;
    else if (this.jumpAt >= 0) {
      this.jumpAt = -1;
      this.bounce.impulse(-3.5);
    }
    p = (t - this.shakeAt) / 0.7;
    this.offsetX = this.shakeAt >= 0 && p < 1 ? Math.sin(p * 44) * (1 - p) * 26 * k * s : 0;
    p = (t - this.spinAt) / 0.9;
    this.rotation = this.spinAt >= 0 && p < 1 ? (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2) * TAU : 0;

    const mix = this.style.value;
    f.characterMix = mix;
    f.orbAlpha = mix > 0.01 ? Math.min(1, mix) : 0;
    f.orbX = ORB.x + this.offsetX;
    this.lineY = ORB.y + (GAME_ORB.y - ORB.y) * g + this.bounce.value * 6 - lift;
    f.orbY = this.lineY + Math.sin(t * 1.3) * 14 * k;
    f.orbR = ORB.r * k * (1 + f.amplitude * 0.05 + f.flash * 0.04) * (0.6 + 0.4 * f.orbAlpha);
    f.squash = Math.max(-0.08, Math.min(0.08, this.bounce.velocity * 0.012));
  }

  draw(f: Frame): void {
    if (f.orbAlpha > 0) this.drawOrb(f);
    if (f.characterMix < 0.99) this.drawVoiceLine(f, Math.min(1, 1 - f.characterMix));
  }

  private drawOrb(f: Frame): void {
    if (!this.orb) return;
    const face = this.face.state;
    const half = f.orbR * ORB.extent;
    this.orb
      .use()
      .v2("u_res", STAGE_WIDTH, STAGE_HEIGHT)
      .v4("u_rect", f.orbX - half, f.orbY - half, half * 2, half * 2)
      .f("u_time", f.t)
      .f("u_amp", f.amplitude)
      .rgb("u_primary", f.hostPrimary)
      .rgb("u_secondary", f.hostSecondary)
      .rgb("u_ink", INK_DARK)
      .rgb("u_gold", GOLD)
      .f("u_desat", face.desat)
      .f("u_flash", f.flash)
      .f("u_squash", f.squash)
      .f("u_extent", ORB.extent)
      .f("u_px", 1 / (f.orbR * f.scale))
      .v4("u_eye", face.eye[0], face.eye[1], face.eye[2], face.eye[3])
      .v4("u_eye2", face.eye2[0], face.eye2[1], face.eye2[2], face.eye2[3])
      .v2("u_gaze", face.gaze[0], face.gaze[1])
      .v4("u_mouth", face.mouth[0], face.mouth[1], face.mouth[2], face.mouth[3])
      .v2("u_vowel", face.vowel[0], face.vowel[1])
      .f("u_blush", face.blush)
      .f("u_alpha", f.orbAlpha)
      .f("u_rot", this.rotation + face.tilt);
    this.ctx.quad.draw();
  }

  private drawVoiceLine(f: Frame, alpha: number): void {
    if (!this.voiceLine) return;
    const mood = this.face.state.mood;
    const height = 400 * (1 - 0.35 * f.game);
    this.voiceLine
      .use()
      .v2("u_res", STAGE_WIDTH, STAGE_HEIGHT)
      .v4("u_rect", this.offsetX, this.lineY - height / 2, STAGE_WIDTH, height)
      .f("u_time", f.t)
      .f("u_amp", f.amplitude * alpha * (1 - 0.35 * f.game))
      .rgb("u_primary", f.hostPrimary)
      .rgb("u_secondary", f.hostSecondary)
      .rgb("u_gold", GOLD)
      .f("u_flash", f.flash)
      .f("u_px", 1 / f.scale)
      .f("u_alpha", alpha)
      .v4("u_mood", mood[0], mood[1], mood[2], mood[3]);
    this.ctx.quad.draw();
  }
}
