import { Spring, SPRINGS } from "../anim/spring";
import type { Program } from "../gl/gl";
import { RECT_VERTEX } from "../gl/shaders";
import { FONT_FAMILY, measureWith, TextSprite } from "../text/sprites";
import { STAGE_HEIGHT, STAGE_WIDTH } from "./atmosphere";
import { LASER_FRAGMENT, LASER_VERTEX, RGB_EDGE_FRAGMENT } from "./fx-shaders";
import type { Frame, StageContext } from "./layer";

/** How long each part of hype mode lasts (seconds; 0 = not at all), and how much of it there is. */
export interface HypeLevel {
  /** The RGB LED strip around the stage. */
  lights: number;
  /** Laser beams sweeping from the corners. */
  lasers: number;
  /** "Deal with it" sunglasses dropping onto the host's face. */
  glasses: number;
  /** Meme stamps slammed onto the stage ("MITOU!", "+1000 DE AURA"). */
  stamps: number;
  /** Hitmarkers popping around the host. */
  hits: number;
}

/** Hype by gift tier (giftTier in fx.ts): even a single rose gets lights, sunglasses and a hitmarker or three. */
const HYPE: readonly HypeLevel[] = [
  { lights: 3.5, lasers: 0, glasses: 3, stamps: 1, hits: 3 },
  { lights: 5.5, lasers: 3.5, glasses: 4.5, stamps: 2, hits: 5 },
  { lights: 8.5, lasers: 7, glasses: 7, stamps: 3, hits: 9 },
  { lights: 13, lasers: 12, glasses: 11, stamps: 4, hits: 14 },
];

const STAMP_SLOTS = 4;
/** A combo keeps the party going: this much longer per gift in a row, up to the cap. */
const COMBO_SECONDS = 0.6;
const COMBO_CAP_SECONDS = 6;

/** Hype mode for a gift of this tier, made bigger by a combo of gifts in a row (ADR-0046). */
export function hypeFor(tier: 0 | 1 | 2 | 3, combo = 1): HypeLevel {
  const base = HYPE[tier] as HypeLevel;
  const extra = Math.min(COMBO_CAP_SECONDS, Math.max(0, combo - 1) * COMBO_SECONDS);
  return {
    lights: base.lights + extra,
    lasers: base.lasers > 0 ? base.lasers + extra : combo >= 3 ? 2 + extra : 0,
    glasses: base.glasses + extra,
    stamps: Math.min(STAMP_SLOTS, base.stamps + (combo >= 5 ? 1 : 0)),
    hits: base.hits + Math.min(8, Math.max(0, combo - 1)),
  };
}

/** Brazilian internet hype, plus the MLG classics. Small gifts draw from the first ones. */
export const STAMPS = [
  "MITOU!",
  "BRABO!",
  "WOW",
  "LENDA!",
  "+1000 DE AURA",
  "QUE ISSO?!",
  "INSANO",
  "DEAL WITH IT",
  "ABSURDO!",
  "LENDÁRIO",
  "OH BABY A TRIPLE",
  "360 NO SCOPE",
  "MLG",
  "SURREAL",
] as const;
const SMALL_STAMPS = 5;

/** Where stamps land: around the character, clear of the caption and the gift banner. */
const SPOTS: ReadonlyArray<readonly [number, number]> = [
  [540, 300],
  [250, 560],
  [835, 600],
  [290, 1370],
  [790, 1530],
];
/** During a game: beside and above the smaller character, never on the board. */
const GAME_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [540, 190],
  [215, 430],
  [865, 450],
];
/** Stamps keep this far inside the stage's edges once they've landed. */
const STAMP_MARGIN = 24;

/** "Deal with it" sunglasses, in pixels: X is black, W the shine. */
const GLASSES = [
  "XXXXXXXXXXXXXXXXXXXXXX",
  "..XXWWXXXX..XXWWXXXX..",
  "..XWWXXXXX..XWWXXXXX..",
  "...XXXXXX....XXXXXX...",
  "....XXXX......XXXX....",
] as const;
const GLASSES_PIXEL = 16;
const GLASSES_WIDTH = (GLASSES[0] as string).length * GLASSES_PIXEL;
const GLASSES_HEIGHT = GLASSES.length * GLASSES_PIXEL;
/** How long the sunglasses take to slide down onto the face. */
const GLASSES_DROP_S = 0.6;

const EDGE = 150;
const LASERS: ReadonlyArray<{ x: number; y: number; angle: number; speed: number; phase: number }> = [
  { x: 0, y: STAGE_HEIGHT, angle: -Math.PI / 4, speed: 1.7, phase: 0 },
  { x: STAGE_WIDTH, y: STAGE_HEIGHT, angle: (-3 * Math.PI) / 4, speed: 1.9, phase: 2.1 },
  { x: 0, y: 0, angle: Math.PI / 4, speed: 1.3, phase: 4.2 },
  { x: STAGE_WIDTH, y: 0, angle: (3 * Math.PI) / 4, speed: 1.5, phase: 1.2 },
];
const LASER_LENGTH = 2300;
const LASER_WIDTH = 64;

/** A color around the color wheel (0..1), written into `out`. */
export function hueRgb(h: number, out: [number, number, number]): [number, number, number] {
  const f = h - Math.floor(h);
  for (let i = 0; i < 3; i++) {
    const k = (f + (3 - i) / 3) % 1;
    out[i] = Math.max(0, Math.min(1, Math.abs(k * 6 - 3) - 1));
  }
  return out;
}

/**
 * Hype mode (ADR-0046): what every gift sets off on top of its tier's
 * particles. An RGB LED strip runs around the stage, lasers sweep from the
 * corners, pixel "deal with it" sunglasses slide down onto the host's face
 * and meme stamps slam onto the stage. A bigger gift (or a combo) makes it
 * longer and louder. Part of the effects layer: it updates and draws when
 * that layer does, and allocates nothing per frame.
 */
export class Hype {
  private readonly edge: Program | null;
  private readonly laser: Program | null;
  private readonly lights = new Spring(0, SPRINGS.snappy);
  private lightsUntil = -1;
  private lightsLevel = 0;
  private readonly lasers = new Spring(0, SPRINGS.gentle);
  private lasersUntil = -1;
  private readonly tint: [number, number, number] = [0, 0, 0];

  private readonly glasses: TextSprite;
  private glassesAt = -1;
  private glassesUntil = -1;

  private readonly stamps: TextSprite[] = [];
  private readonly stampAt = new Float64Array(STAMP_SLOTS).fill(-1);
  private readonly stampUntil = new Float64Array(STAMP_SLOTS);
  private readonly stampX = new Float32Array(STAMP_SLOTS);
  private readonly stampY = new Float32Array(STAMP_SLOTS);
  private readonly stampW = new Float32Array(STAMP_SLOTS);
  private readonly stampH = new Float32Array(STAMP_SLOTS);
  private readonly stampSize = new Float32Array(STAMP_SLOTS);
  private readonly stampTilt = new Float32Array(STAMP_SLOTS);
  private readonly stampHue = new Float32Array(STAMP_SLOTS);
  private readonly stampShown = new Uint8Array(STAMP_SLOTS);
  private readonly stampText: string[] = [];
  private nextSlot = 0;
  private nextSpot = 0;
  /** Cursors through the small gifts' words and the whole list: one gift never says the same thing twice. */
  private smallPhrase: number;
  private bigPhrase: number;
  private game = 0;
  private scale = 1;

  constructor(
    private readonly ctx: StageContext,
    private readonly random: () => number,
  ) {
    this.edge = ctx.program("rgb-edge", RECT_VERTEX, RGB_EDGE_FRAGMENT);
    this.laser = ctx.program("laser", LASER_VERTEX, LASER_FRAGMENT);
    this.glasses = new TextSprite(ctx.gl);
    for (let i = 0; i < STAMP_SLOTS; i++) {
      this.stamps.push(new TextSprite(ctx.gl));
      this.stampText.push("");
    }
    this.smallPhrase = Math.floor(random() * SMALL_STAMPS);
    this.bigPhrase = Math.floor(random() * STAMPS.length);
    this.paintGlasses(1);
  }

  /** Sets hype mode off (or keeps it going longer): `big` stamps draw from the whole list, not just the small gifts' words. */
  trigger(level: HypeLevel, big: boolean, now: number): void {
    if (level.lights > 0) {
      // Brighter for a big gift; a small one never dims lights a big one turned up.
      this.lightsLevel = Math.max(now < this.lightsUntil ? this.lightsLevel : 0, big ? 1 : 0.7);
      this.lightsUntil = Math.max(this.lightsUntil, now + level.lights);
    }
    if (level.lasers > 0) this.lasersUntil = Math.max(this.lasersUntil, now + level.lasers);
    if (level.glasses > 0) {
      // Already on: they stay on longer. Off: they drop again.
      if (now >= this.glassesUntil) this.glassesAt = now;
      this.glassesUntil = Math.max(this.glassesUntil, now + level.glasses);
    }
    for (let i = 0; i < level.stamps; i++) this.stamp(big, now + i * 0.32);
  }

  repaint(scale: number): void {
    this.scale = scale;
    this.paintGlasses(scale);
    for (let i = 0; i < STAMP_SLOTS; i++) if (this.stampText[i]) this.paintStamp(i, scale);
  }

  update(dt: number, f: Frame): void {
    const t = f.t;
    this.game = f.game;
    // A gentle two-beats-a-second pulse (never a strobe).
    this.lights.target = t < this.lightsUntil ? this.lightsLevel * (0.82 + 0.18 * Math.sin(t * Math.PI * 4)) : 0;
    this.lights.step(dt);
    this.lasers.target = t < this.lasersUntil ? 1 : 0;
    this.lasers.step(dt);

    // The sunglasses slide down onto the eyes (or the middle of a voice line) and stay there.
    const g = this.glasses;
    const on = t >= this.glassesAt && t < this.glassesUntil;
    if (on && g.opacity.value < 0.05 && t - this.glassesAt < 0.1) g.opacity.snap(1);
    g.opacity.target = on ? 1 : 0;
    const p = Math.min(1, Math.max(0, (t - this.glassesAt) / GLASSES_DROP_S));
    const drop = on ? -520 * (1 - p) ** 3 : -40 * (1 - Math.min(1, g.opacity.value));
    const orb = f.orbAlpha > 0.5;
    const width = orb ? f.orbR * 1.62 : 300;
    const height = (width * GLASSES_HEIGHT) / GLASSES_WIDTH;
    g.width = width;
    g.height = height;
    g.x = (orb ? f.orbX : STAGE_WIDTH / 2) - width / 2;
    g.y = f.orbY - (orb ? f.orbR * 0.08 : 0) - height * 0.38 + drop;
    g.update(dt, t);

    for (let i = 0; i < STAMP_SLOTS; i++) {
      const at = this.stampAt[i] as number;
      if (at < 0) continue;
      const sprite = this.stamps[i] as TextSprite;
      const age = t - at;
      if (age < 0) continue;
      if (!this.stampShown[i]) {
        this.stampShown[i] = 1;
        sprite.opacity.snap(1);
      }
      const until = this.stampUntil[i] as number;
      sprite.opacity.target = t < until ? 1 : 0;
      // Slammed on from big, with a little wobble as it lands.
      const s = 1 + 1.1 * Math.exp(-age * 11) + 0.05 * Math.sin(age * 10) * Math.exp(-age * 2);
      sprite.width = (this.stampW[i] as number) * s;
      sprite.height = (this.stampH[i] as number) * s;
      sprite.x = (this.stampX[i] as number) - sprite.width / 2;
      sprite.y = (this.stampY[i] as number) - sprite.height / 2;
      sprite.update(dt, t);
      if (t > until && sprite.opacity.value < 0.01) this.stampAt[i] = -1;
    }
  }

  /** The lights and lasers, added to what's below them. */
  drawLights(f: Frame): void {
    const amount = this.lights.value;
    const beams = this.lasers.value;
    if (amount < 0.003 && beams < 0.003) return;
    const gl = this.ctx.gl.gl;
    gl.blendFunc(gl.ONE, gl.ONE);
    if (this.edge && amount >= 0.003) {
      const edge = this.edge.use().v2("u_res", STAGE_WIDTH, STAGE_HEIGHT).f("u_time", f.t).f("u_amount", amount);
      edge.v4("u_rect", 0, 0, STAGE_WIDTH, EDGE);
      this.ctx.quad.draw();
      edge.v4("u_rect", 0, STAGE_HEIGHT - EDGE, STAGE_WIDTH, EDGE);
      this.ctx.quad.draw();
      edge.v4("u_rect", 0, EDGE, EDGE, STAGE_HEIGHT - 2 * EDGE);
      this.ctx.quad.draw();
      edge.v4("u_rect", STAGE_WIDTH - EDGE, EDGE, EDGE, STAGE_HEIGHT - 2 * EDGE);
      this.ctx.quad.draw();
    }
    if (this.laser && beams >= 0.003) {
      const laser = this.laser.use().v2("u_res", STAGE_WIDTH, STAGE_HEIGHT).v2("u_size", LASER_LENGTH, LASER_WIDTH).f("u_amount", beams * 0.85);
      for (let i = 0; i < LASERS.length; i++) {
        const beam = LASERS[i] as (typeof LASERS)[number];
        const angle = beam.angle + Math.sin(f.t * beam.speed + beam.phase) * 0.55;
        const tint = hueRgb(f.t * 0.3 + i * 0.25, this.tint);
        laser.v2("u_origin", beam.x, beam.y).v2("u_dir", Math.cos(angle), Math.sin(angle)).v3("u_color", tint[0], tint[1], tint[2]);
        this.ctx.quad.draw();
      }
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  drawGlasses(): void {
    this.ctx.drawSprite(this.glasses);
  }

  drawStamps(): void {
    for (let i = 0; i < STAMP_SLOTS; i++) if ((this.stampAt[i] as number) >= 0 && this.stampShown[i]) this.ctx.drawSprite(this.stamps[i] as TextSprite);
  }

  /** What's on right now (tests and the lab). */
  get active(): { lights: boolean; lasers: boolean; glasses: boolean; stamps: number } {
    let stamps = 0;
    for (let i = 0; i < STAMP_SLOTS; i++) if ((this.stampAt[i] as number) >= 0) stamps++;
    return { lights: this.lights.target > 0, lasers: this.lasers.target > 0, glasses: this.glasses.opacity.target > 0, stamps };
  }

  private stamp(big: boolean, at: number): void {
    const i = this.nextSlot;
    this.nextSlot = (this.nextSlot + 1) % STAMP_SLOTS;
    const text = STAMPS[big ? this.bigPhrase++ % STAMPS.length : this.smallPhrase++ % SMALL_STAMPS] as string;
    const spots = this.game > 0.5 ? GAME_SPOTS : SPOTS;
    const spot = spots[this.nextSpot++ % spots.length] as readonly [number, number];
    this.stampText[i] = text;
    // Smaller beside a game board, where there's less room.
    this.stampSize[i] = (big ? 92 : 76) * (this.game > 0.5 ? 0.68 : 1);
    this.stampTilt[i] = (this.random() - 0.5) * 0.5;
    this.stampHue[i] = this.random();
    this.stampX[i] = spot[0] + (this.random() - 0.5) * 60;
    this.stampY[i] = spot[1] + (this.random() - 0.5) * 50;
    this.stampAt[i] = at;
    this.stampUntil[i] = at + (big ? 1.6 : 1.3);
    this.stampShown[i] = 0;
    (this.stamps[i] as TextSprite).opacity.snap(0);
    this.paintStamp(i, this.scale);
    // A long phrase near a side moves in until it fits.
    const half = (this.stampW[i] as number) / 2 + STAMP_MARGIN;
    this.stampX[i] = Math.max(half, Math.min(STAGE_WIDTH - half, this.stampX[i] as number));
  }

  private paintStamp(i: number, scale: number): void {
    const text = this.stampText[i] as string;
    const size = this.stampSize[i] as number;
    const tilt = this.stampTilt[i] as number;
    const hue = this.stampHue[i] as number;
    const font = `800 ${size}px ${FONT_FAMILY}`;
    const w = Math.min(980, measureWith(font)(text) + size * 0.5);
    const h = size * 1.35;
    const cos = Math.abs(Math.cos(tilt));
    const sin = Math.abs(Math.sin(tilt));
    const bw = w * cos + h * sin;
    const bh = w * sin + h * cos;
    this.stampW[i] = bw;
    this.stampH[i] = bh;
    const rgb: [number, number, number] = [0, 0, 0];
    (this.stamps[i] as TextSprite).draw(bw, bh, scale, (ctx) => {
      ctx.translate(bw / 2, bh / 2);
      ctx.rotate(tilt);
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = size * 0.17;
      ctx.strokeStyle = "#0B0420";
      ctx.strokeText(text, 0, 0, w - size * 0.3);
      const rainbow = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
      for (let k = 0; k <= 6; k++) {
        hueRgb(hue + k / 6, rgb);
        rainbow.addColorStop(k / 6, `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`);
      }
      ctx.shadowColor = "rgba(255,255,255,0.55)";
      ctx.shadowBlur = size * 0.2;
      ctx.fillStyle = rainbow;
      ctx.fillText(text, 0, 0, w - size * 0.3);
    });
  }

  private paintGlasses(scale: number): void {
    // Drawn at their largest (a big orb), so scaling down keeps the pixels crisp.
    this.glasses.draw(GLASSES_WIDTH, GLASSES_HEIGHT, scale * 1.6, (ctx) => {
      for (let row = 0; row < GLASSES.length; row++) {
        const line = GLASSES[row] as string;
        for (let col = 0; col < line.length; col++) {
          const pixel = line[col];
          if (pixel === ".") continue;
          ctx.fillStyle = pixel === "W" ? "#FFFFFF" : "#000000";
          ctx.fillRect(col * GLASSES_PIXEL, row * GLASSES_PIXEL, GLASSES_PIXEL + 0.5, GLASSES_PIXEL + 0.5);
        }
      }
    });
  }
}
