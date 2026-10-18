import { BOOST_LABELS, type AlertKind, type BoostKind, type Effect } from "@tik-live/shared";
import type { MusicPlayer } from "../audio/music";
import { Spring, SPRINGS } from "../anim/spring";
import { hexToRgb, type Rgb } from "../color";
import type { Program, QuadGeometry } from "../gl/gl";
import { GLOW_DOT_FRAGMENT } from "../gl/shaders";
import { rgba, ShapeDrawer, type Rgba } from "../gl/shapes";
import { FONT_FAMILY, GOLD as GOLD_HEX, INK, measureWith, roundRect, TextSprite, truncate, withAlpha } from "../text/sprites";
import { GOLD, STAGE_HEIGHT, STAGE_WIDTH } from "./atmosphere";
import type { CharacterLayer } from "./character";
import { OFFERINGS_VERTEX, PARTICLE_FRAGMENT, PARTICLE_VERTEX } from "./fx-shaders";
import type { Frame, Layer, StageContext } from "./layer";

/** Particle kinds, as the particle shader knows them. */
export const KIND = { dot: 0, confetti: 1, heart: 2, star: 3, sparkle: 4, note: 5, bubble: 6, streak: 7, petal: 8 } as const;

const POOL = 720;
const OFFERING_SLOTS = 192;
const TAU = Math.PI * 2;

const palette = (...hex: string[]): Rgb[] => hex.map(hexToRgb);
const CONFETTI = palette("#FF5FA2", "#FFD15C", "#7CF5FF", "#8CFF7A", "#B98CFF", "#FF8A4C");
const HEARTS = palette("#FF4F8B", "#FF7AB6", "#FF2D55", "#FFB3D1");
const ROSES = palette("#FF2D55", "#E0123F", "#FF6F91", "#FFC2D1");
const STARS = palette("#FFD15C", "#FFF3C4", "#7CF5FF", "#FFFFFF");
const WARM = palette("#FFD15C", "#FFFFFF", "#FFB347");
const FIREWORKS = palette("#FF5FA2", "#FFD15C", "#7CF5FF", "#8CFF7A", "#FF6B5C", "#B98CFF");
const WATER = palette("#BFF6FF", "#9BD8FF", "#E8FBFF");
const NOTES = palette("#7CF5FF", "#FF5FD2", "#FFFFFF", "#FFD15C");
const BOOST_HEX = "#7CF5FF";
/** Gifts this close together build a combo. */
const COMBO_GAP_S = 5;

/** The combo after a gift at `now`: it grows while gifts keep coming, and starts over after a pause. */
export function nextCombo(count: number, lastAt: number, now: number): number {
  return now - lastAt <= COMBO_GAP_S ? count + 1 : 1;
}

/** Gift tiers by diamonds (TikTok's own coin value). */
export function giftTier(diamonds: number): 0 | 1 | 2 | 3 {
  return diamonds >= 1000 ? 3 : diamonds >= 100 ? 2 : diamonds >= 10 ? 1 : 0;
}

/** A gift's own flavor from its name: roses and hearts, or space. */
export function giftFlavor(giftName: string): "love" | "space" | null {
  if (/ros[ea]|flower|flor|heart|cora[cç]|love|kiss|beij|amor/i.test(giftName)) return "love";
  if (/galax|univers|planet|star|estrel|cosm|rocket|foguet|moon|meteor|comet/i.test(giftName)) return "space";
  return null;
}

/**
 * Reactions (ADR-0023): particle bursts from a fixed pool, the character's
 * moves, spotlight and rain, gift tiers with their banner, like hearts and
 * the "now playing" chip. Drawn in two passes: `behind` the character (rain,
 * bubbles, gift offerings) and `ahead` of it (everything else, over the game
 * board, under the text).
 */
export class FxLayer {
  readonly behind: Layer;
  readonly ahead: Layer;
  private readonly particles: Program | null;
  private readonly offeringsProgram: Program | null;
  private readonly pool: QuadGeometry;
  private readonly a = new Float32Array(POOL * 4);
  private readonly b = new Float32Array(POOL * 4);
  private readonly c = new Float32Array(POOL * 4);
  private cursor = 0;
  private dirty = false;
  private readonly offerings: QuadGeometry;
  private readonly offeringA = new Float32Array(OFFERING_SLOTS * 4);
  private readonly offeringB = new Float32Array(OFFERING_SLOTS * 4);
  private offeringCursor = 0;
  private readonly arrivals: Array<{ at: number; big: boolean }> = [];
  private readonly shapes: ShapeDrawer;

  private now = 0;
  private scale = 1;
  /** Where the character was last frame: bursts start there. */
  private originX = 540;
  private originY = 720;
  private radius = 165;
  private flash = 0;
  private screenFlash = 0;
  private readonly spotlight = new Spring(0, SPRINGS.gentle);
  private spotlightUntil = -1;
  private rainUntil = -1;
  private rainNext = 0;
  private rainRate = 60;
  private likeQueue = 0;
  private nextLikeAt = 0;

  private readonly banner: TextSprite;
  private bannerText: [string, string] = ["", ""];
  private bannerColor = GOLD_HEX;
  private bannerUntil = -1;
  /** Banners waiting for the one on screen to finish (a power-up, a new top gifter), oldest first. */
  private readonly pendingBanners: Array<{ big: string; small: string; color: string; seconds: number }> = [];
  /** Gifts in quick succession: "COMBO ×5" over the character's head. */
  private readonly combo: TextSprite;
  private comboCount = 0;
  private comboAt = -Infinity;

  private readonly chip: TextSprite;
  private chipTitle = "";
  private readonly eq = new Float32Array(4);
  private readonly chipY = new Spring(600, SPRINGS.snappy);

  constructor(
    private readonly ctx: StageContext,
    private readonly character: CharacterLayer,
    private readonly player: Pick<MusicPlayer, "nowPlaying" | "bands">,
    private readonly random: () => number,
  ) {
    this.particles = ctx.program("particles", PARTICLE_VERTEX, PARTICLE_FRAGMENT);
    this.offeringsProgram = ctx.program("offerings", OFFERINGS_VERTEX, GLOW_DOT_FRAGMENT);
    this.shapes = new ShapeDrawer(ctx);
    this.b.fill(1);
    for (let i = 0; i < POOL; i++) this.b[i * 4] = -1000;
    this.pool = ctx.gl.quad();
    this.pool.attachInstances(1, 4, this.a);
    this.pool.attachInstances(2, 4, this.b);
    this.pool.attachInstances(3, 4, this.c);
    this.offeringB.fill(1);
    for (let i = 0; i < OFFERING_SLOTS; i++) this.offeringA[i * 4 + 2] = -1000;
    this.offerings = ctx.gl.quad();
    this.offerings.attachInstances(1, 4, this.offeringA);
    this.offerings.attachInstances(2, 4, this.offeringB);
    this.banner = new TextSprite(ctx.gl);
    this.combo = new TextSprite(ctx.gl);
    this.chip = new TextSprite(ctx.gl);
    this.behind = { update: (dt, f) => this.update(dt, f), draw: (f) => this.drawBehind(f), repaint: (s) => this.repaint(s) };
    this.ahead = { update: () => {}, draw: (f) => this.drawAhead(f) };
  }

  // ---- triggers -----------------------------------------------------------------

  play(effect: Effect, intensity: number, now: number): void {
    this.now = now;
    const n = Math.max(0.25, Math.min(3, intensity));
    const ox = this.originX;
    const oy = this.originY;
    switch (effect) {
      case "confetti":
        for (let i = 0; i < 70 * n; i++) {
          const angle = -Math.PI / 2 + (this.random() - 0.5) * 2.2;
          const speed = 700 + this.random() * 700;
          this.spawn(KIND.confetti, ox + (this.random() - 0.5) * 120, oy, Math.cos(angle) * speed, Math.sin(angle) * speed, i * 0.004, 2.6 + this.random(), 34 + this.random() * 16, this.pick(CONFETTI));
        }
        break;
      case "hearts":
        this.rise(KIND.heart, 18 * n, HEARTS, 58);
        break;
      case "sparkles":
        for (let i = 0; i < 26 * n; i++) {
          const angle = this.random() * TAU;
          const r = this.radius * (0.9 + this.random() * 1.6);
          this.spawn(KIND.sparkle, ox + Math.cos(angle) * r, oy + Math.sin(angle) * r, 0, -20, this.random() * 0.7, 0.7 + this.random() * 0.6, 44 + this.random() * 26, this.pick(WARM));
        }
        break;
      case "fireworks": {
        const bursts = Math.max(1, Math.min(8, Math.round(3 * n)));
        for (let k = 0; k < bursts; k++) {
          const x = 180 + this.random() * 720;
          const y = 260 + this.random() * 560;
          const color = this.pick(FIREWORKS);
          const delay = k * 0.38;
          for (let i = 0; i < 44; i++) {
            const angle = (i / 44) * TAU + this.random() * 0.1;
            const speed = 380 + this.random() * 160;
            this.spawn(KIND.dot, x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, delay, 1.4 + this.random() * 0.5, 16, i % 5 === 0 ? WARM[1] as Rgb : color);
          }
          this.spawn(KIND.sparkle, x, y, 0, 0, delay, 0.5, 150, WARM[1] as Rgb);
        }
        break;
      }
      case "stars":
        this.burst(KIND.star, 22 * n, STARS, 52);
        break;
      case "notes":
        this.rise(KIND.note, 10 * n, NOTES, 66);
        break;
      case "bubbles":
        for (let i = 0; i < 22 * n; i++) {
          this.spawn(KIND.bubble, 80 + this.random() * 920, 1700 + this.random() * 240, (this.random() - 0.5) * 40, -260 - this.random() * 200, this.random() * 1.2, 3.2 + this.random(), 28 + this.random() * 46, this.pick(WATER));
        }
        break;
      case "spin":
      case "jump":
      case "shake":
        this.character.move(effect, now, n);
        break;
      case "spotlight":
        this.spotlightUntil = now + 4 * n;
        break;
      case "rain":
        this.rainUntil = now + 5 * n;
        this.rainRate = 60 * Math.min(2, n);
        this.rainNext = now;
        break;
    }
  }

  /** Gifts by tier, follows, shares, level-ups, a new top gifter, gift powers and the raffle (the alert text itself is the text layer's). */
  alert(kind: AlertKind, name: string, giftName: string, diamonds: number, now: number): void {
    this.now = now;
    if (kind === "level") {
      this.play("sparkles", 1, now);
      return this.play("stars", 1.1, now);
    }
    if (kind === "crown") {
      // A new top gifter: fireworks, a gold burst, and the crown changing hands on a banner.
      this.play("fireworks", 1.6, now);
      this.burst(KIND.star, 34, WARM, 58);
      this.character.move("jump", now, 1);
      this.flash = Math.min(1.4, this.flash + 0.9);
      this.screenFlash = Math.max(this.screenFlash, 0.45);
      return this.queueBanner("NOVO TOPO!", `${truncate(name, 24)} assumiu a coroa`, GOLD_HEX, 2.4, now);
    }
    if (kind === "perk") {
      this.play("sparkles", 1.3, now);
      this.play("stars", 1.1, now);
      this.flash = Math.min(1.4, this.flash + 0.5);
      return this.character.kick(-3);
    }
    if (kind === "raffle") {
      // The raffle's own banner names the winner; here it's the party.
      this.play("confetti", 1.5, now);
      this.play("sparkles", 0.9, now);
      return this.character.move("jump", now, 1);
    }
    if (kind === "follow") return this.play("stars", 0.8, now);
    if (kind === "share") return this.play("bubbles", 0.8, now);
    const tier = giftTier(diamonds);
    const flavor = giftFlavor(giftName);
    this.bumpCombo(now);
    const count = Math.min(36, 4 + Math.round(Math.log10(diamonds + 1) * 7));
    for (let i = 0; i < count; i++) this.spawnOffering(i * 0.045, tier >= 3);
    if (tier === 0) {
      this.play("sparkles", 0.6, now);
      this.character.kick(-1.5);
    } else if (tier === 1) {
      if (flavor === "love") {
        this.rise(KIND.petal, 20, ROSES, 30);
        this.play("hearts", 0.8, now);
      } else this.play(flavor === "space" || diamonds % 2 ? "stars" : "hearts", 1, now);
    } else if (tier === 2) {
      this.play("confetti", 1.2, now);
      if (flavor) this.play(flavor === "love" ? "hearts" : "stars", 1, now);
      this.character.move("shake", now, 1);
      this.flash = Math.min(1.4, this.flash + 0.7);
    } else {
      this.play("fireworks", 1.5, now);
      this.play(flavor === "love" ? "hearts" : "stars", 1.4, now);
      this.play("confetti", 1.4, now);
      this.character.move("jump", now, 1.2);
      this.screenFlash = 1;
      this.flash = 1.4;
      this.showBanner(truncate((giftName || "Presente").toUpperCase(), 18), `de ${truncate(name, 24)}`, now, GOLD_HEX, 3.2);
    }
  }

  /** A gift powered up the game round for everyone (ADR-0029): a cyan banner, after any gift banner. */
  boost(boost: BoostKind, by: string, now: number): void {
    this.now = now;
    const big = BOOST_LABELS[boost].toUpperCase();
    const small = `presente de ${truncate(by, 24)}`;
    this.play("sparkles", 1.4, now);
    this.character.move("jump", now, 0.8);
    this.queueBanner(big, small, BOOST_HEX, 2, now);
  }

  /** Shows a banner now, or after the ones already up or waiting (at most three wait). */
  private queueBanner(big: string, small: string, color: string, seconds: number, now: number): void {
    if (this.bannerUntil > now || this.pendingBanners.length) {
      if (this.pendingBanners.length < 3) this.pendingBanners.push({ big, small, color, seconds });
    } else this.showBanner(big, small, now, color, seconds);
  }

  /** New likes: hearts float up from the bottom right, at most six a second. */
  likes(delta: number, now: number): void {
    this.likeQueue = Math.min(30, this.likeQueue + Math.max(1, Math.round(Math.sqrt(delta) * 2)));
    if (this.nextLikeAt < now) this.nextLikeAt = now;
  }

  repaint(scale: number): void {
    if (this.bannerText[0]) this.paintBanner(scale);
    if (this.comboCount >= 2) this.paintCombo(scale);
    if (this.chipTitle) this.paintChip(scale);
  }

  // ---- frame ---------------------------------------------------------------------

  private update(dt: number, f: Frame): void {
    const t = f.t;
    this.now = t;
    this.scale = f.scale;
    this.originX = f.orbX;
    this.originY = f.orbY;
    this.radius = f.orbR;
    this.flash = Math.max(0, this.flash - dt * 0.9);
    this.screenFlash = Math.max(0, this.screenFlash - dt * 1.4);
    while (this.arrivals.length && (this.arrivals[0] as { at: number }).at <= t) {
      const arrival = this.arrivals.shift() as { at: number; big: boolean };
      this.flash = Math.min(1.4, this.flash + (arrival.big ? 0.25 : 0.12));
      this.character.kick(arrival.big ? -3 : -1.2);
      if (this.arrivals.length === 0 && !f.speaking) this.character.setEmotion("excited", t, 1.8);
    }
    this.spotlight.target = t < this.spotlightUntil ? 1 : 0;
    this.spotlight.step(dt);
    f.flash = this.flash;
    f.screenFlash = this.screenFlash;
    f.spotlight = Math.max(0, this.spotlight.value);

    // Rain: soft streaks, spawned as time passes.
    while (t < this.rainUntil && this.rainNext <= t) {
      this.rainNext += 1 / this.rainRate;
      this.spawn(KIND.streak, this.random() * 1180, -60 - this.random() * 200, -140, 1500 + this.random() * 400, 0, 1.5, 70 + this.random() * 50, this.pick(WATER));
    }
    if (this.likeQueue > 0 && t >= this.nextLikeAt) {
      this.likeQueue -= 1;
      this.nextLikeAt = t + 1 / 6;
      this.spawn(KIND.heart, 930 + this.random() * 70, 1650, -40 - this.random() * 50, -360 - this.random() * 160, 0, 2.6, 34 + this.random() * 14, this.pick(HEARTS));
    }

    if (this.bannerUntil >= 0 && t > this.bannerUntil) {
      this.banner.opacity.target = 0;
      this.banner.offsetY.target = -30;
      this.bannerUntil = -1;
    }
    if (this.pendingBanners.length && this.bannerUntil < 0 && this.banner.opacity.value < 0.05) {
      const next = this.pendingBanners.shift() as (typeof this.pendingBanners)[number];
      this.showBanner(next.big, next.small, t, next.color, next.seconds);
    }
    this.banner.update(dt, t);
    // The combo floats over the character's head and fades once the gifts stop.
    if (this.comboCount >= 2 && t - this.comboAt > COMBO_GAP_S) {
      this.comboCount = 0;
      this.combo.opacity.target = 0;
    }
    this.combo.x = this.originX - this.combo.width / 2;
    this.combo.y = this.originY - this.radius - this.combo.height - 24;
    this.combo.update(dt, t);
    // "Now playing": the music player knows the track and when it ends.
    const playing = this.player.nowPlaying();
    if (playing && playing.title !== this.chipTitle) {
      this.chipTitle = playing.title;
      this.paintChip(f.scale);
    }
    this.chip.opacity.target = playing ? 1 : 0;
    if (playing) this.player.bands(this.eq);
    // Below the alerts; during games, up beside the badge so the board stays clear.
    this.chipY.target = 600 + (300 - 600) * f.game;
    this.chipY.step(dt);
    this.chip.y = this.chipY.value;
    this.chip.update(dt, t);

    if (this.dirty) {
      this.dirty = false;
      this.pool.updateInstances(1, 0, POOL * 4);
      this.pool.updateInstances(2, 0, POOL * 4);
      this.pool.updateInstances(3, 0, POOL * 4);
    }
  }

  private drawBehind(f: Frame): void {
    const gl = this.ctx.gl.gl;
    gl.blendFunc(gl.ONE, gl.ONE);
    if (this.offeringsProgram) {
      this.offeringsProgram.use().v2("u_res", STAGE_WIDTH, STAGE_HEIGHT).f("u_time", f.t).v2("u_orb", f.orbX, f.orbY).rgb("u_color", GOLD);
      this.offerings.draw(OFFERING_SLOTS);
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawParticles(f, 1);
  }

  private drawAhead(f: Frame): void {
    this.drawParticles(f, 0);
    this.ctx.drawSprite(this.combo);
    this.ctx.drawSprite(this.banner);
    if (this.chip.visible()) {
      this.ctx.drawSprite(this.chip);
      // The equalizer: four bands of the music's spectrum.
      const alpha = Math.min(1, this.chip.opacity.value);
      for (let i = 0; i < 4; i++) {
        const h = 10 + 26 * Math.min(1, (this.eq[i] as number) * 1.4);
        this.shapes.box(this.chip.x + 30 + i * 11, this.chip.y + 46 - h / 2, 7, h, 3.5, EQ, alpha, undefined, undefined, 0, 0, -1, f.scale);
      }
    }
  }

  private drawParticles(f: Frame, behind: number): void {
    if (!this.particles) return;
    this.particles.use().v2("u_res", STAGE_WIDTH, STAGE_HEIGHT).f("u_time", f.t).f("u_behind", behind);
    this.pool.draw(POOL);
  }

  // ---- helpers -------------------------------------------------------------------


  private rise(kind: number, count: number, colors: Rgb[], size: number): void {
    for (let i = 0; i < count; i++) {
      const side = this.random() - 0.5;
      this.spawn(kind, this.originX + side * this.radius * 2, this.originY + this.radius * 0.4, side * 260, -260 - this.random() * 260, i * 0.06, 2.2 + this.random() * 0.8, size * (0.75 + this.random() * 0.5), this.pick(colors));
    }
  }

  private burst(kind: number, count: number, colors: Rgb[], size: number): void {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * TAU + this.random() * 0.3;
      const speed = 420 + this.random() * 380;
      this.spawn(kind, this.originX + Math.cos(angle) * this.radius * 0.8, this.originY + Math.sin(angle) * this.radius * 0.8, Math.cos(angle) * speed, Math.sin(angle) * speed, this.random() * 0.12, 1.3 + this.random() * 0.5, size * (0.7 + this.random() * 0.6), this.pick(colors));
    }
  }

  private pick(colors: Rgb[]): Rgb {
    return colors[Math.floor(this.random() * colors.length)] as Rgb;
  }

  private spawn(kind: number, x: number, y: number, vx: number, vy: number, delay: number, life: number, size: number, color: Rgb): void {
    const i = this.cursor * 4;
    this.cursor = (this.cursor + 1) % POOL;
    const { a, b, c } = this;
    a[i] = x;
    a[i + 1] = y;
    a[i + 2] = vx;
    a[i + 3] = vy;
    b[i] = this.now + delay;
    b[i + 1] = life;
    b[i + 2] = size;
    b[i + 3] = kind;
    c[i] = color[0];
    c[i + 1] = color[1];
    c[i + 2] = color[2];
    c[i + 3] = this.random();
    this.dirty = true;
  }

  private spawnOffering(delay: number, big: boolean): void {
    const slot = this.offeringCursor;
    this.offeringCursor = (this.offeringCursor + 1) % OFFERING_SLOTS;
    const start = this.now + delay;
    const duration = 1.1 + this.random() * 0.6;
    const a = slot * 4;
    this.offeringA[a] = 820 + this.random() * 140;
    this.offeringA[a + 1] = 420 + this.random() * 120;
    this.offeringA[a + 2] = start;
    this.offeringA[a + 3] = (this.random() - 0.5) * 260;
    this.offeringB[a] = big ? 7 : 5;
    this.offeringB[a + 1] = duration;
    this.offeringB[a + 2] = big ? 1 : 0;
    this.offeringB[a + 3] = 0;
    this.offerings.updateInstances(1, a, 4);
    this.offerings.updateInstances(2, a, 4);
    this.arrivals.push({ at: start + duration, big });
  }

  /** Counts a gift toward the combo; every fifth gift in a row showers gold, every tenth sets off fireworks. */
  private bumpCombo(now: number): void {
    this.comboCount = nextCombo(this.comboCount, this.comboAt, now);
    this.comboAt = now;
    if (this.comboCount < 2) return;
    this.paintCombo(this.scale);
    this.combo.opacity.target = 1;
    if (this.combo.opacity.value < 0.1) this.combo.opacity.snap(0.2);
    this.combo.offsetY.snap(-26);
    this.combo.offsetY.target = 0;
    if (this.comboCount % 5 === 0) {
      this.rise(KIND.star, 34, WARM, 42);
      this.play("confetti", 1, now);
    }
    if (this.comboCount % 10 === 0) {
      this.play("fireworks", 2, now);
      this.screenFlash = Math.max(this.screenFlash, 0.6);
    }
  }

  private paintCombo(scale: number): void {
    const label = `800 30px ${FONT_FAMILY}`;
    const big = `800 64px ${FONT_FAMILY}`;
    const count = `×${this.comboCount}`;
    const hot = this.comboCount >= 10 ? "#FF5C6C" : this.comboCount >= 5 ? "#FF9F45" : GOLD_HEX;
    const width = measureWith(label)("COMBO ") + measureWith(big)(count) + 60;
    const height = 104;
    this.combo.draw(width, height, scale, (ctx) => {
      ctx.textBaseline = "alphabetic";
      ctx.shadowColor = withAlpha(hot, 0.85);
      ctx.shadowBlur = 26;
      ctx.font = label;
      ctx.fillStyle = INK;
      ctx.fillText("COMBO ", 30, 72);
      ctx.font = big;
      ctx.fillStyle = hot;
      ctx.fillText(count, 30 + measureWith(label)("COMBO "), 76);
    });
  }

  private showBanner(big: string, small: string, now: number, color: string, seconds: number): void {
    this.bannerText = [big, small];
    this.bannerColor = color;
    this.bannerUntil = now + seconds;
    this.paintBanner(this.scale);
    this.banner.opacity.snap(0);
    this.banner.opacity.target = 1;
    this.banner.offsetY.snap(70);
    this.banner.offsetY.target = 0;
  }

  private paintBanner(scale: number): void {
    const [gift, from] = this.bannerText;
    const big = `800 128px ${FONT_FAMILY}`;
    const small = `700 44px ${FONT_FAMILY}`;
    const width = Math.min(940, Math.max(measureWith(big)(gift), measureWith(small)(from)) + 120);
    const height = 270;
    const s = this.banner;
    s.x = 540 - width / 2;
    s.y = 870;
    s.draw(width, height, scale, (ctx) => {
      // Nearly opaque: during games it sits over the board.
      ctx.fillStyle = "rgba(14,6,34,0.95)";
      ctx.strokeStyle = withAlpha(this.bannerColor, 0.9);
      ctx.lineWidth = 4;
      roundRect(ctx, 6, 6, width - 12, height - 12, 40);
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = big;
      ctx.shadowColor = withAlpha(this.bannerColor, 0.85);
      ctx.shadowBlur = 30;
      ctx.fillStyle = this.bannerColor;
      ctx.fillText(gift, width / 2, 112, width - 60);
      ctx.shadowBlur = 0;
      ctx.font = small;
      ctx.fillStyle = INK;
      ctx.fillText(from, width / 2, 206, width - 60);
    });
    s.x = 540 - s.width / 2;
  }

  private paintChip(scale: number): void {
    const font = `700 30px ${FONT_FAMILY}`;
    const text = truncate(this.chipTitle, 28);
    const width = measureWith(font)(text) + 104;
    const height = 92;
    this.chip.x = 1016 - width;
    this.chip.draw(width, height, scale, (ctx) => {
      ctx.fillStyle = "rgba(14,6,34,0.72)";
      ctx.strokeStyle = "rgba(163,151,214,0.55)";
      ctx.lineWidth = 2;
      roundRect(ctx, 2, 20, width - 4, 52, 26);
      ctx.fill();
      ctx.stroke();
      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.fillStyle = INK;
      ctx.fillText(text, 84, 47);
    });
  }
}

const EQ: Rgba = rgba("#7CF5FF");
