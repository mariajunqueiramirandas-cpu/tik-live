import type { Emotion } from "@tik-live/shared";
import { Spring, SpringVector, SPRINGS } from "../anim/spring";
import type { MouthShape } from "../audio/envelope";

/**
 * Parametric face (ADR-0009). Each emotion is a target set of shape
 * parameters; springs blend between them, so expressions morph smoothly
 * into each other instead of switching.
 */
//               open  width happy heart  lid  brow  sparkle  smile round smirk blush desat
type FaceTarget = [number, number, number, number, number, number, number, number, number, number, number, number];

const FACES: Record<Emotion, FaceTarget> = {
  neutral: [1.0, 1.0, 0, 0, 0, 0, 0.3, 0.6, 0, 0, 0.15, 0],
  happy: [1.0, 1.0, 1, 0, 0, 0, 0, 1.0, 0, 0, 0.8, 0],
  excited: [1.15, 1.1, 0, 0, 0, 0, 1, 1.0, 0, 0, 0.8, 0],
  laugh: [1.0, 1.0, 1, 0, 0, 0, 0, 1.0, 0, 0, 1.0, 0],
  surprised: [1.25, 1.2, 0, 0, 0, 0, 0.6, 0, 1, 0, 0.2, 0],
  thinking: [0.85, 1.0, 0, 0, 0, 0, 0.2, 0.1, 0, 0.45, 0.1, 0],
  sad: [0.9, 0.95, 0, 0, 0, 1, 0.2, -0.8, 0, 0, 0, 0.35],
  love: [1.0, 1.0, 0, 1, 0, 0, 0, 1.0, 0, 0, 1.0, 0],
  mischief: [0.9, 1.05, 0, 0, 1, 0, 0.2, 0.7, 0, 1, 0.3, 0],
};

export interface FaceState {
  eye: [number, number, number, number];
  eye2: [number, number, number, number];
  gaze: [number, number];
  mouth: [number, number, number, number];
  /** While talking: round (o, u) and wide (i, e) vowel shapes. */
  vowel: [number, number];
  blush: number;
  desat: number;
}

export class FaceController {
  private readonly shape = new SpringVector(FACES.neutral, SPRINGS.gentle);
  private readonly gazeX = new Spring(0, SPRINGS.gentle);
  private readonly gazeY = new Spring(0, SPRINGS.gentle);
  readonly mouthOpen = new Spring(0, SPRINGS.quick);
  private readonly mouthRound = new Spring(0, SPRINGS.quick);
  private readonly mouthWide = new Spring(0, SPRINGS.quick);
  private emotion: Emotion = "neutral";
  private nextGlance = 0;
  private blinkStart = -1;
  private nextBlink = 1.5;
  private attention: { x: number; y: number; until: number } | null = null;
  readonly state: FaceState = {
    eye: [1, 1, 0, 0],
    eye2: [0, 0, 0.3, 0],
    gaze: [0, 0],
    mouth: [0, 0.6, 0, 0],
    vowel: [0, 0],
    blush: 0.15,
    desat: 0,
  };

  constructor(private readonly random: () => number) {}

  setEmotion(emotion: Emotion): void {
    this.emotion = emotion;
    this.shape.setTarget(FACES[emotion] ?? FACES.neutral);
  }

  get current(): Emotion {
    return this.emotion;
  }

  /** Look toward a point (in -1..1 face space) for a while, e.g. at incoming gifts. */
  lookAt(x: number, y: number, untilSeconds: number): void {
    this.attention = { x, y, until: untilSeconds };
  }

  update(dt: number, t: number, amplitude: number, vowel?: MouthShape): FaceState {
    this.shape.step(dt);

    if (this.attention && t < this.attention.until) {
      this.gazeX.target = this.attention.x;
      this.gazeY.target = this.attention.y;
    } else if (this.emotion === "thinking") {
      this.gazeX.target = 0.6;
      this.gazeY.target = -0.7;
    } else if (t > this.nextGlance) {
      this.gazeX.target = (this.random() - 0.5) * 0.8;
      this.gazeY.target = (this.random() - 0.5) * 0.5;
      this.nextGlance = t + 2.5 + this.random() * 4;
    }
    this.gazeX.step(dt);
    this.gazeY.step(dt);

    let blink = 0;
    if (this.blinkStart < 0 && t > this.nextBlink) this.blinkStart = t;
    if (this.blinkStart >= 0) {
      const p = (t - this.blinkStart) / 0.15;
      if (p >= 1) {
        this.blinkStart = -1;
        this.nextBlink = t + 2.5 + this.random() * 3.5;
      } else {
        blink = Math.sin(p * Math.PI);
      }
    }

    this.mouthOpen.target = amplitude;
    this.mouthOpen.step(dt);
    this.mouthRound.target = amplitude > 0.05 ? (vowel?.round ?? 0) : 0;
    this.mouthWide.target = amplitude > 0.05 ? (vowel?.wide ?? 0) : 0;
    this.mouthRound.step(dt);
    this.mouthWide.step(dt);

    const s = this.state;
    s.eye[0] = this.shape.get(0);
    s.eye[1] = this.shape.get(1);
    s.eye[2] = clamp01(this.shape.get(2));
    s.eye[3] = clamp01(this.shape.get(3));
    s.eye2[0] = clamp01(this.shape.get(4));
    s.eye2[1] = clamp01(this.shape.get(5));
    s.eye2[2] = clamp01(this.shape.get(6));
    s.eye2[3] = blink;
    s.gaze[0] = this.gazeX.value;
    s.gaze[1] = this.gazeY.value;
    s.mouth[0] = clamp01(this.mouthOpen.value);
    s.mouth[1] = this.shape.get(7);
    s.mouth[2] = clamp01(this.shape.get(8));
    s.mouth[3] = this.shape.get(9);
    s.vowel[0] = clamp01(this.mouthRound.value);
    s.vowel[1] = clamp01(this.mouthWide.value);
    s.blush = clamp01(this.shape.get(10));
    s.desat = clamp01(this.shape.get(11));
    return s;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
