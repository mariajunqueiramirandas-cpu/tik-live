import { GAME_LABELS, OPTION_LETTERS, type GameScene } from "@tik-live/shared";
import { Spring, SpringVector, SPRINGS } from "../anim/spring";
import { hexToRgb } from "../color";
import { NONE, rgba, ShapeDrawer, type Rgba } from "../gl/shapes";
import type { Frame, Layer, StageContext } from "../stage/layer";
import type { Measure } from "../text/layout";
import { FONT_FAMILY, HAZE, INK, measureWith, TextSprite, withAlpha } from "../text/sprites";
import {
  deadlineFor,
  easeOutBack,
  ellipsize,
  fitText,
  formatCount,
  formatSeconds,
  isRound,
  leader,
  letterList,
  PALETTES,
  percentages,
  sceneChange,
  secondsLeft,
  shares,
  staticKey,
  tileGrid,
  timerFraction,
  trackPosition,
  type FittedText,
  type RoundScene,
} from "./model";

/**
 * Game scenes (ADR-0023). The board is a list of elements laid out once per
 * content change: GPU shapes (cards, bars, tiles, the timer) and pieces of
 * one text atlas painted with Canvas2D at the same time. Every frame only
 * moves, scales and fades those elements (entrances, springs, the
 * countdown), so the frame loop never repaints text or allocates. A few
 * live labels (counts, percentages, the range) repaint when their text
 * changes, at most a few times a second.
 */

// Board geometry, stage px. Keep key text left of TikTok's right rail and
// above its bottom bar; the character sits above the board.
const L = 84;
const R = 996;
const W = R - L;
const CX = 540;
const HEAD_Y = 622;
const TOP = 708;
const FOOT_Y = 1460;
const ATLAS_Y = 560;
const ATLAS_H = 940;

const DARK = "#120A2E";
const GREEN = "#4DFF9A";
const WARN = "#FF5C6C";
const OPTION_COLORS = ["#FF6B8B", "#4FC3FF", "#FFC84F", "#B98CFF"] as const;
const TF_COLORS = ["#36E0B0", "#FF5C7A"] as const;
const PODIUM = ["#FFD15C", "#CFD8F5", "#E8A06A"] as const;

const PANEL = rgba("#0C0622", 0.82);
const TRACK = rgba("#FFFFFF", 0.1);
const WHITE = rgba("#FFFFFF");
const GREEN_RGBA = rgba(GREEN);
const WARN_RGBA = rgba(WARN);

// Groups animate together (entrance, dimming).
const G_HEAD = 0;
const G_MAIN = 1;
const G_OPT = 2; // 2..5: one per option, tile set, podium place
const G_FOOT = 6;
const G_EXTRA = 7;
const G_EXTRA2 = 8;
const GROUPS = 9;

// Element kinds and bindings.
const SHAPE = 0;
const PIECE = 1;
const LABEL = 2;
const B_NONE = 0;
const B_BAR_X = 1; // grows from the left with vals[arg]
const B_BAR_Y = 2; // grows from the bottom with vals[arg]
const B_FOLLOW = 3; // moves with the top of element `arg`
const B_RANGE = 4; // the number window: vals[4]..vals[5] along its own rect
const B_MARK = 5; // the last guess: vals[6] along element `arg`
const B_TIMER = 6; // width = time left
const B_GROW = 7; // grows from the bottom with its group's entrance
const B_TILE = 8; // letter tile `arg`: staggered pop and bob

const F_TIMER = 1; // hidden once the round is revealed
const F_PULSE = 2; // glow breathes
const F_SHINE = 4; // a highlight sweeps across

const MAX_ELEMENTS = 128;
const LABELS = 8;
const L_TIMER = 0;
const L_FOOT = 1;
const L_VALUE = 2; // 2..5
const L_BIG = 6;
const L_SUB = 7;

interface Element {
  type: number;
  x: number;
  y: number;
  w: number;
  h: number;
  group: number;
  bind: number;
  arg: number;
  radius: number;
  reach: number;
  border: number;
  flags: number;
  fill: Rgba;
  line: Rgba;
  glow: Rgba;
  /** Smallest size a bar shrinks to (B_BAR_X width, B_BAR_Y height). */
  min: number;
  /** This frame's top edge, after its binding (for B_FOLLOW). */
  top: number;
}

interface TextOptions {
  align?: 0 | 0.5 | 1;
  color?: string;
  weight?: number;
  glow?: string | null;
  lineHeight?: number;
  bind?: number;
  arg?: number;
  /** One-line text wider than this shrinks (to 3/4 size at most), then ellipsizes. Default: the board width. */
  maxWidth?: number;
}

/** One line of live text in its own small texture, repainted only when it changes. */
class Label {
  readonly sprite: TextSprite;
  textWidth = 0;
  pad = 16;
  private key = "";
  private parts: [string, string] = ["", ""];
  private style: [number, number, string, string, string | null, number] = [40, 700, INK, HAZE, null, W];

  constructor(ctx: StageContext) {
    this.sprite = new TextSprite(ctx.gl);
  }

  get empty(): boolean {
    return !this.parts[0] && !this.parts[1];
  }

  /** `strong` in `colorA`, then `rest` in `colorB`, shrunk then ellipsized to `maxWidth`. */
  set(strong: string, rest: string, size: number, weight: number, colorA: string, colorB: string, glow: string | null, maxWidth: number, scale: number): void {
    const key = `${strong}\u0000${rest}\u0000${size}${weight}${colorA}${colorB}${glow}${maxWidth}`;
    if (key === this.key) return;
    this.key = key;
    this.parts = [strong, rest];
    this.style = [size, weight, colorA, colorB, glow, maxWidth];
    this.paint(scale);
  }

  paint(scale: number): void {
    let [a, b] = this.parts;
    let [size] = this.style;
    const [, weight, colorA, colorB, glow, maxWidth] = this.style;
    let m = measureWith(`${weight} ${size}px ${FONT_FAMILY}`);
    const total = m(a) + m(b);
    if (total > maxWidth) {
      size = Math.max(Math.round(size * 0.78), Math.floor((size * maxWidth) / total));
      m = measureWith(`${weight} ${size}px ${FONT_FAMILY}`);
      if (m(a) + m(b) > maxWidth) [a, b] = cutLonger(a, b, maxWidth, m);
    }
    const wa = m(a);
    this.textWidth = wa + m(b);
    this.pad = glow ? 56 : 16;
    const pad = this.pad;
    const height = size * 1.3 + pad * 2;
    this.sprite.opacity.snap(1);
    this.sprite.draw(this.textWidth + pad * 2, height, scale, (ctx) => {
      ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
      ctx.textBaseline = "middle";
      const y = height / 2 + size * 0.04;
      ctx.shadowColor = glow ? withAlpha(glow, 0.7) : "rgba(5,2,18,0.6)";
      ctx.shadowBlur = glow ? 24 : 10;
      ctx.fillStyle = colorA;
      ctx.fillText(a, pad, y);
      ctx.fillStyle = colorB;
      ctx.fillText(b, pad + wa, y);
    });
  }
}

export class GameLayer implements Layer {
  /** The scene palette (primary, secondary, background) the atmosphere blends toward. */
  readonly colors = new SpringVector([0, 0, 0, 0, 0, 0, 0, 0, 0], SPRINGS.gentle);
  private readonly shapes: ShapeDrawer;
  private readonly atlas: TextSprite;
  private readonly labels: Label[] = [];
  private readonly elements: Element[] = [];
  private count = 0;

  private scene: GameScene | null = null;
  private next: GameScene | null = null;
  private leaving = false;
  private key = "";
  private enterAt = 0;
  private revealAt = -1;
  private deadline: number | null = null;
  private lastSecond = -1;
  private accent = "#FFFFFF";
  private accentRgba: Rgba = WHITE;
  private painted = false;
  /** Podium places already on screen (bit per place), so only a new one makes an entrance; -1 before the first paint. */
  private podiumShown = -1;
  private scale = 1;
  private time = 0;

  private readonly vis = new Spring(0, SPRINGS.snappy);
  private readonly timerVis = new Spring(0, SPRINGS.gentle);
  /** Bars 0-3, number window low (4) and high (5), last guess (6). */
  private readonly vals: Spring[] = [];
  private readonly dim: Spring[] = [];
  private readonly delay = new Float32Array(GROUPS);
  private readonly punch = new Uint8Array(GROUPS);
  // Per-frame group state (scratch).
  private readonly gAlpha = new Float32Array(GROUPS);
  private readonly gDy = new Float32Array(GROUPS);
  private readonly gScale = new Float32Array(GROUPS);
  private readonly gGrow = new Float32Array(GROUPS);

  constructor(private readonly ctx: StageContext) {
    this.shapes = new ShapeDrawer(ctx);
    this.atlas = new TextSprite(ctx.gl);
    for (let i = 0; i < LABELS; i++) this.labels.push(new Label(ctx));
    for (let i = 0; i < MAX_ELEMENTS; i++) {
      this.elements.push({ type: 0, x: 0, y: 0, w: 0, h: 0, group: 0, bind: 0, arg: 0, radius: 0, reach: 0, border: 3, flags: 0, fill: NONE, line: NONE, glow: NONE, min: 0, top: 0 });
    }
    for (let i = 0; i < 7; i++) this.vals.push(new Spring(0, { stiffness: 90, damping: 14 }));
    for (let i = 0; i < GROUPS; i++) this.dim.push(new Spring(1, SPRINGS.gentle));
  }

  /** Shows a scene, updates the one on screen in place, or (null) leaves. */
  set(scene: GameScene | null, now: number, scale: number): void {
    this.scale = scale;
    this.time = now;
    const change = sceneChange(this.leaving ? this.next : this.scene, scene);
    if (change === "none") return;
    if (change === "exit") {
      this.next = null;
      this.leaving = true;
      this.vis.target = 0;
      return;
    }
    if (change === "enter" && !this.leaving) {
      this.show(scene as GameScene, now, true);
      return;
    }
    if (change === "update" && !this.leaving) {
      this.show(scene as GameScene, now, false);
      return;
    }
    // A new round or game: the current board leaves first.
    this.next = scene;
    if (this.scene) {
      this.leaving = true;
      this.vis.target = 0;
    } else this.show(scene as GameScene, now, true);
  }

  update(dt: number, f: Frame): void {
    const t = f.t;
    this.time = t;
    this.colors.step(dt);
    this.vis.step(dt);
    if (this.leaving && this.vis.value < 0.02) {
      this.leaving = false;
      const next = this.next;
      this.next = null;
      if (next) this.show(next, t, true);
      else this.scene = null;
    }
    const scene = this.scene;
    if (!scene) return;
    const open = isRound(scene) && scene.phase === "open";
    this.timerVis.target = open && scene.durationMs > 0 ? 1 : 0;
    this.timerVis.step(dt);
    for (let i = 0; i < this.vals.length; i++) (this.vals[i] as Spring).step(dt);
    for (let i = 0; i < GROUPS; i++) (this.dim[i] as Spring).step(dt);
    if (open && this.deadline !== null) {
      const second = secondsLeft(t, this.deadline);
      if (second !== this.lastSecond) {
        this.lastSecond = second;
        const warn = second <= 5;
        (this.labels[L_TIMER] as Label).set(String(second), " s", 46, 800, warn ? WARN : INK, warn ? WARN : HAZE, null, 200, this.scale);
      }
    }
    // Entrances: each group rises (or punches in) after its delay.
    for (let g = 0; g < GROUPS; g++) {
      const p = (t - this.enterAt - (this.delay[g] as number)) / 0.5;
      const e = easeOutBack(p);
      const clamped = Math.max(0, Math.min(1, p));
      this.gGrow[g] = p <= 0 ? 0 : easeOutBack(p * 0.9);
      if (this.punch[g]) {
        const q = Math.max(0, Math.min(1, p * 1.5));
        this.gScale[g] = 2.3 - 1.3 * easeOutBack(q);
        this.gAlpha[g] = Math.min(1, clamped * 3);
        this.gDy[g] = 0;
      } else {
        this.gScale[g] = 1;
        this.gAlpha[g] = clamped * clamped * (3 - 2 * clamped);
        this.gDy[g] = (1 - e) * 60;
      }
    }
  }

  draw(f: Frame): void {
    const scene = this.scene;
    const vis = this.vis.value;
    if (!scene || vis < 0.004 || !this.painted) return;
    const t = f.t;
    const exitDy = (1 - Math.min(1, vis)) * 40;
    const timerFrac = isRound(scene) && this.deadline !== null ? timerFraction(t, this.deadline, scene.durationMs) : 0;
    const warn = this.lastSecond >= 0 && this.lastSecond <= 5;
    const lo = this.v(4);
    const hi = this.v(5);
    // Two passes, shapes then text: text always sits on its shapes, and
    // software rasterizers pay for every program switch.
    const count = this.count;
    for (let k = 0; k < count * 2; k++) {
      const e = this.elements[k % count] as Element;
      if ((e.type === SHAPE) !== k < count) continue;
      const g = e.group;
      let alpha = Math.min(1, vis) * (this.gAlpha[g] as number) * Math.max(0, (this.dim[g] as Spring).value);
      if (e.flags & F_TIMER) alpha *= this.timerVis.value;
      if (alpha <= 0.004) {
        e.top = e.y;
        continue;
      }
      let x = e.x;
      let y = e.y;
      let w = e.w;
      let h = e.h;
      let s = this.gScale[g] as number;
      switch (e.bind) {
        case B_BAR_X: {
          const base = Math.max(h, e.min);
          w = base + (e.w - base) * Math.max(0, this.v(e.arg));
          break;
        }
        case B_BAR_Y: {
          const base = Math.max(Math.min(e.w, e.radius * 2), e.min);
          h = base + (e.h - base) * Math.max(0, this.v(e.arg));
          y = e.y + e.h - h;
          break;
        }
        case B_FOLLOW: {
          // Labels keep their slot in `arg` and the followed element in `radius`.
          const ref = this.elements[e.type === LABEL ? e.radius : e.arg] as Element;
          y += ref.top - ref.y;
          break;
        }
        case B_RANGE: {
          const a = e.x + Math.min(lo, hi) * e.w;
          const span = Math.abs(hi - lo) * e.w;
          w = Math.max(e.h, span);
          x = a + span / 2 - w / 2;
          break;
        }
        case B_MARK: {
          const track = this.elements[e.arg] as Element;
          x = track.x + this.v(6) * track.w - e.w / 2;
          break;
        }
        case B_TIMER:
          w = e.w * timerFrac;
          if (w < 1) alpha = 0;
          break;
        case B_GROW:
          h = e.h * (this.gGrow[g] as number);
          y = e.y + e.h - h;
          break;
        case B_TILE: {
          const p = (t - this.enterAt - 0.25 - e.arg * 0.05) / 0.45;
          s = easeOutBack(p);
          alpha *= Math.max(0, Math.min(1, p * 3));
          if (this.revealAt >= 0) {
            const q = Math.max(0, Math.min(1, (t - this.revealAt - e.arg * 0.06) / 0.35));
            s *= 1 + 0.2 * Math.sin(Math.PI * q);
          } else y += Math.sin(t * 2.2 + e.arg * 0.8) * 5;
          break;
        }
      }
      e.top = y;
      y += (this.gDy[g] as number) + exitDy;
      if (s !== 1) {
        const cx = x + w / 2;
        const cy = y + h / 2;
        w *= s;
        h *= s;
        x = cx - w / 2;
        y = cy - h / 2;
      }
      if (e.type === SHAPE) {
        let glow = e.glow;
        let fill = e.fill;
        let glowAlpha = 1;
        if (e.bind === B_TIMER && warn) {
          fill = WARN_RGBA;
          glow = WARN_RGBA;
          glowAlpha = 0.6 + 0.4 * Math.sin(t * 9);
        }
        if (e.flags & F_PULSE) glowAlpha = 0.6 + 0.4 * Math.sin(t * 4.5);
        const shine = e.flags & F_SHINE ? (((t - this.enterAt) * 0.45) % 1.6) - 0.3 : -1;
        this.shapes.box(x, y, w, h, e.radius * s, fill, alpha, e.line, glowAlpha === 1 ? glow : this.fade(glow, glowAlpha), e.reach, e.border, shine, f.scale);
      } else if (e.type === PIECE) {
        const tex = this.atlas.textures[this.atlas.mix >= 0.5 ? 1 : 0];
        this.shapes.texture(tex, e.x / 1080, (e.y - ATLAS_Y) / ATLAS_H, e.w / 1080, e.h / ATLAS_H, x, y, w, h, alpha);
      } else {
        const label = this.labels[e.arg] as Label;
        if (label.empty) continue;
        const sprite = label.sprite;
        const lw = sprite.width * s;
        const lh = sprite.height * s;
        let cy = y;
        if (e.bind === B_FOLLOW) cy = Math.max(e.h, cy);
        const lx = e.x - label.pad * s - label.textWidth * s * e.w;
        this.shapes.texture(sprite.textures[sprite.mix >= 0.5 ? 1 : 0], 0, 0, 1, 1, lx, cy - lh / 2, lw, lh, alpha);
      }
    }
  }

  repaint(scale: number): void {
    this.scale = scale;
    if (this.scene) this.paint(this.scene);
    for (const label of this.labels) if (!label.empty) label.paint(scale);
  }

  // ---- state ------------------------------------------------------------------

  private v(i: number): number {
    return (this.vals[i] as Spring).value;
  }

  /** A glow color at reduced strength, from a small cache (no per-frame allocation). */
  private readonly faded: [number, number, number, number] = [0, 0, 0, 0];
  private fade(color: Rgba, k: number): Rgba {
    this.faded[0] = color[0];
    this.faded[1] = color[1];
    this.faded[2] = color[2];
    this.faded[3] = color[3] * k;
    return this.faded;
  }

  private show(scene: GameScene, now: number, fresh: boolean): void {
    const previous = this.scene;
    this.scene = scene;
    const palette = PALETTES[scene.kind];
    const target = [...hexToRgb(palette.primary), ...hexToRgb(palette.secondary), ...hexToRgb(palette.background)];
    if (!previous && !this.painted) this.colors.snap(target);
    else this.colors.setTarget(target);
    this.accent = palette.accent;
    this.accentRgba = rgba(palette.accent);
    if (fresh) {
      this.enterAt = now;
      this.revealAt = -1;
      this.deadline = null;
      this.lastSecond = -1;
      this.key = "";
      this.podiumShown = -1;
      this.vis.snap(1);
      for (const spring of this.vals) spring.snap(0);
      for (const spring of this.dim) spring.snap(1);
      for (const label of this.labels) label.set("", "", 40, 700, INK, INK, null, W, this.scale);
    }
    if (isRound(scene)) {
      const wasOpen = previous && isRound(previous) ? previous.phase === "open" : true;
      if (scene.phase === "reveal" && (fresh || wasOpen)) this.revealAt = fresh ? -1 : now;
      this.deadline = scene.phase === "open" ? deadlineFor(this.deadline, now, scene.remainingMs) : null;
      if (scene.phase === "reveal") this.lastSecond = -1;
    }
    const key = staticKey(scene) + (scene.kind === "number" ? String(scene.last !== null) : "");
    if (key !== this.key) {
      this.key = key;
      this.paint(scene);
    }
    this.live(scene);
  }

  /** Live values: labels and spring targets, no repaint of the board. */
  private live(scene: GameScene): void {
    const sc = this.scale;
    const foot = this.labels[L_FOOT] as Label;
    const footer = (strong: string, rest: string) => foot.set(strong, rest, 40, 700, this.accent, HAZE, null, W, sc);
    if (isRound(scene) && scene.phase === "reveal") (this.labels[L_TIMER] as Label).set("Tempo esgotado", "", 34, 700, HAZE, HAZE, null, 300, sc);
    switch (scene.kind) {
      case "trivia":
      case "truefalse": {
        // The server takes T, V or F for true/false; the board shows the Portuguese V.
        const letters = scene.kind === "trivia" ? letterList(OPTION_LETTERS.slice(0, scene.options.length)) : "V ou F";
        if (scene.phase === "open") footer(formatCount(scene.answers), ` ${noun(scene.answers, "resposta")} · digite ${letters}`);
        else if (scene.winners.length === 1) footer(scene.winners[0] as string, " acertou!");
        else if (scene.winners.length) footer("Mais rápidos: ", this.winnerList(scene.winners));
        else footer("", "Ninguém acertou");
        const tally = scene.tally ?? [];
        const share = shares(tally);
        share.forEach((value, i) => ((this.vals[i] as Spring).target = value));
        break;
      }
      case "poll": {
        const total = scene.tally.reduce((sum, n) => sum + n, 0);
        const pct = percentages(scene.tally);
        const share = shares(scene.tally);
        const lead = leader(scene.tally);
        scene.options.forEach((_, i) => {
          (this.vals[i] as Spring).target = share[i] ?? 0;
          const big = scene.options.length === 2;
          (this.labels[L_VALUE + i] as Label).set(`${pct[i] ?? 0}%`, "", big ? 84 : 52, 800, INK, INK, i === lead && scene.phase === "reveal" ? "#FFD15C" : null, 260, sc);
        });
        const letters = letterList(OPTION_LETTERS.slice(0, scene.options.length));
        if (scene.phase === "reveal" && lead >= 0) footer(`O chat escolheu ${OPTION_LETTERS[lead]}`, ` · ${formatCount(total)} ${noun(total, "voto")}`);
        else footer(formatCount(total), ` ${noun(total, "voto")} · digite ${letters}`);
        break;
      }
      case "scramble":
        footer(formatCount(scene.guesses), ` ${noun(scene.guesses, "palpite")}${scene.phase === "open" ? " · digite a palavra" : ""}`);
        break;
      case "math":
      case "riddle":
        footer(formatCount(scene.guesses), ` ${noun(scene.guesses, "palpite")}${scene.phase === "open" ? " · digite a resposta" : ""}`);
        break;
      case "number": {
        const reveal = scene.phase === "reveal" && scene.answer !== null;
        const low = reveal ? (scene.answer as number) : scene.low;
        const high = reveal ? (scene.answer as number) : scene.high;
        (this.vals[4] as Spring).target = trackPosition(low, scene.min, scene.max);
        (this.vals[5] as Spring).target = trackPosition(high, scene.min, scene.max);
        if (scene.last) (this.vals[6] as Spring).target = trackPosition(scene.last.value, scene.min, scene.max);
        const big = this.labels[L_BIG] as Label;
        if (reveal) big.set(String(scene.answer), "", 170, 800, "#FFD15C", "#FFD15C", "#FFD15C", W, sc);
        else big.set(low === high ? `${low}` : `${low} – ${high}`, "", 132, 800, INK, INK, this.accent, W, sc);
        const sub = this.labels[L_SUB] as Label;
        if (scene.phase === "reveal") {
          if (scene.winner) sub.set(scene.winner, " acertou!", 56, 800, this.accent, INK, null, W, sc);
          else sub.set("", "Ninguém acertou desta vez", 48, 700, HAZE, HAZE, null, W, sc);
        } else if (scene.last) {
          // The hint is about the secret: "maior" means it's higher than this guess.
          const arrow = scene.last.hint === "higher" ? "  ↑ maior" : scene.last.hint === "lower" ? "  ↓ menor" : "  na mosca!";
          sub.set(`${scene.last.name}: ${scene.last.value}`, arrow, 48, 800, INK, scene.last.hint === "lower" ? "#FF8A6B" : "#7CFFB2", null, W, sc);
        } else sub.set("", "", 48, 700, INK, INK, null, W, sc);
        footer(formatCount(scene.guesses), ` ${noun(scene.guesses, "palpite")}${scene.phase === "open" ? " · digite o número" : ""}`);
        break;
      }
      case "fastest":
        footer("", scene.phase === "open" ? "Digite igualzinho · quem for primeiro ganha" : "");
        break;
      case "scoreboard":
        footer("", "");
        break;
      case "podium": {
        const shown = scene.places.filter((place) => place !== null).length;
        if (scene.suspense !== null) footer(`${scene.suspense}º lugar`, " · rufem os tambores…");
        else if (shown === scene.places.length) footer("Parabéns!", " O placar geral começa do zero");
        else footer("", "Somando os pontos de todos os jogos");
        // The place being built up to stays bright; the rest step back.
        for (let i = 0; i < 3; i++) (this.dim[G_OPT + i] as Spring).target = scene.suspense === null || scene.suspense === i + 1 ? 1 : 0.55;
        break;
      }
    }
    // Reveals dim the wrong answers.
    if ((scene.kind === "trivia" || scene.kind === "truefalse") && scene.phase === "reveal" && scene.correct !== null) {
      const correct = scene.kind === "trivia" ? scene.correct : scene.correct ? 0 : 1;
      const n = scene.kind === "trivia" ? scene.options.length : 2;
      for (let i = 0; i < n; i++) (this.dim[G_OPT + i] as Spring).target = i === correct ? 1 : 0.38;
    }
  }

  /** As many winners as fit on the footer, then "e mais 2". */
  private winnerList(names: readonly string[]): string {
    const m = this.measure(34, 700);
    const room = W - m("Mais rápidos: ");
    for (let k = names.length; k > 1; k--) {
      const line = names.slice(0, k).join(", ") + (k < names.length ? ` e mais ${names.length - k}` : "");
      if (m(line) <= room) return line;
    }
    return names.length > 1 ? `${names[0]} e mais ${names.length - 1}` : (names[0] ?? "");
  }

  // ---- layout and painting ------------------------------------------------------

  private paint(scene: GameScene): void {
    this.count = 0;
    this.delay.fill(0);
    this.punch.fill(0);
    this.delay[G_MAIN] = 0.08;
    for (let i = 0; i < 4; i++) this.delay[G_OPT + i] = 0.2 + i * 0.08;
    this.delay[G_EXTRA] = 0.45;
    this.delay[G_EXTRA2] = 0.55;
    this.delay[G_FOOT] = 0.5;
    this.atlas.draw(1080, ATLAS_H, this.scale, (ctx) => {
      ctx.translate(0, -ATLAS_Y);
      this.ctx2d = ctx;
      if (isRound(scene)) this.header(scene);
      switch (scene.kind) {
        case "trivia":
          this.trivia(scene);
          break;
        case "poll":
          this.poll(scene);
          break;
        case "scramble":
          this.scramble(scene);
          break;
        case "number":
          this.number(scene);
          break;
        case "truefalse":
          this.trueFalse(scene);
          break;
        case "math":
          this.math(scene);
          break;
        case "riddle":
          this.riddle(scene);
          break;
        case "fastest":
          this.fastest(scene);
          break;
        case "scoreboard":
          this.scoreboard(scene);
          break;
        case "podium":
          this.podium(scene);
          break;
      }
      this.ctx2d = null;
    });
    this.painted = true;
    this.label(L_FOOT, CX, FOOT_Y, 0.5, G_FOOT);
  }

  private ctx2d: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  private add(type: number, x: number, y: number, w: number, h: number, group: number): Element {
    const e = this.elements[Math.min(this.count, MAX_ELEMENTS - 1)] as Element;
    if (this.count < MAX_ELEMENTS) this.count++;
    e.type = type;
    e.x = x;
    e.y = y;
    e.w = w;
    e.h = h;
    e.group = group;
    e.bind = B_NONE;
    e.arg = 0;
    e.radius = 0;
    e.reach = 0;
    e.border = 3;
    e.flags = 0;
    e.fill = NONE;
    e.line = NONE;
    e.glow = NONE;
    e.min = 0;
    e.top = y;
    return e;
  }

  private box(x: number, y: number, w: number, h: number, radius: number, group: number, fill: Rgba, line: Rgba = NONE, glow: Rgba = NONE, reach = 0): Element {
    const e = this.add(SHAPE, x, y, w, h, group);
    e.radius = radius;
    e.fill = fill;
    e.line = line;
    e.glow = glow;
    e.reach = reach;
    return e;
  }

  private get index(): number {
    return this.count - 1;
  }

  /** A live label element, anchored at (x, center y) with `align` 0 left .. 1 right. */
  private label(slot: number, x: number, y: number, align: number, group: number, bind = B_NONE, arg = 0, minY = 0): Element {
    const e = this.add(LABEL, x, y, align, minY, group);
    e.arg = slot;
    if (bind === B_FOLLOW) {
      e.bind = B_FOLLOW;
      // Labels keep their slot in `arg`; the followed element goes in `radius`.
      e.radius = arg;
    }
    return e;
  }

  private fit(text: string, maxWidth: number, maxLines: number, sizes: readonly number[], weight = 760): FittedText {
    return fitText(text, maxWidth, maxLines, sizes, (size) => measureWith(`${weight} ${size}px ${FONT_FAMILY}`));
  }

  private measure(size: number, weight: number): Measure {
    return measureWith(`${weight} ${size}px ${FONT_FAMILY}`);
  }

  /** Paints lines into the atlas and adds the piece that shows them. Returns the block's bottom. */
  private text(fitted: FittedText, x: number, top: number, group: number, options: TextOptions = {}): number {
    const ctx = this.ctx2d;
    const align = options.align ?? 0.5;
    const weight = options.weight ?? 760;
    const size = fitted.size;
    const lineHeight = size * (options.lineHeight ?? 1.16);
    const height = fitted.lines.length * lineHeight;
    if (ctx && fitted.lines.length) {
      ctx.save();
      ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = align === 0 ? "left" : align === 1 ? "right" : "center";
      ctx.fillStyle = options.color ?? INK;
      ctx.shadowColor = options.glow ? withAlpha(options.glow, 0.75) : "rgba(5,2,18,0.6)";
      ctx.shadowBlur = options.glow ? 24 : 10;
      fitted.lines.forEach((line, i) => ctx.fillText(line, x, top + (i + 0.5) * lineHeight + size * 0.04));
      ctx.restore();
      const width = Math.max(...fitted.widths);
      // Room for the whole glow, so its edge never shows as a box.
      const pad = options.glow ? 60 : 18;
      const e = this.add(PIECE, x - width * align - pad, top - pad, width + pad * 2, height + pad * 2, group);
      if (options.bind) {
        e.bind = options.bind;
        e.arg = options.arg ?? 0;
      }
    }
    return top + height;
  }

  /** One line, two colors (e.g. "Dica: " + the hint), centered at `cx`. */
  private pair(strong: string, rest: string, size: number, cx: number, top: number, group: number, colorA: string, colorB: string, maxWidth = W): number {
    const ctx = this.ctx2d;
    let m = this.measure(size, 740);
    let s = size;
    if (m(strong) + m(rest) > maxWidth) {
      s = Math.max(Math.round(size * 0.8), Math.floor((size * maxWidth) / (m(strong) + m(rest))));
      m = this.measure(s, 740);
    }
    const [a, b] = m(strong) + m(rest) > maxWidth ? cutLonger(strong, rest, maxWidth, m) : [strong, rest];
    const width = m(a) + m(b);
    if (ctx) {
      ctx.save();
      ctx.font = `740 ${s}px ${FONT_FAMILY}`;
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(5,2,18,0.6)";
      ctx.shadowBlur = 10;
      const x = cx - width / 2;
      const y = top + s * 0.6;
      ctx.fillStyle = colorA;
      ctx.fillText(a, x, y);
      ctx.fillStyle = colorB;
      ctx.fillText(b, x + m(a), y);
      ctx.restore();
      this.add(PIECE, cx - width / 2 - 18, top - 18, width + 36, s * 1.2 + 36, group);
    }
    return top + s * 1.2;
  }

  /** "Dica: ..." in up to two lines, "Dica:" in the accent. */
  private fitHint(hint: string): FittedText {
    return this.fit(`Dica: ${hint}`, W, 2, [44, 40, 36], 740);
  }

  private hint(f: FittedText, top: number, group: number): number {
    const ctx = this.ctx2d;
    const size = f.size;
    const lineHeight = size * 1.2;
    if (ctx && f.lines.length) {
      const m = this.measure(size, 740);
      ctx.save();
      ctx.font = `740 ${size}px ${FONT_FAMILY}`;
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(5,2,18,0.6)";
      ctx.shadowBlur = 10;
      f.lines.forEach((line, i) => {
        const x = CX - (f.widths[i] ?? 0) / 2;
        const y = top + i * lineHeight + size * 0.6;
        const label = i === 0 && line.startsWith("Dica:") ? "Dica:" : "";
        ctx.fillStyle = this.accent;
        if (label) ctx.fillText(label, x, y);
        ctx.fillStyle = INK;
        ctx.fillText(line.slice(label.length), x + (label ? m(label) : 0), y);
      });
      ctx.restore();
      const width = Math.max(...f.widths);
      this.add(PIECE, CX - width / 2 - 18, top - 18, width + 36, f.lines.length * lineHeight + 36, group);
    }
    return top + f.lines.length * lineHeight;
  }

  private single(text: string, size: number, weight: number, x: number, top: number, group: number, options: TextOptions = {}): number {
    const maxWidth = options.maxWidth ?? W;
    let m = this.measure(size, weight);
    let s = size;
    let line = text;
    if (m(line) > maxWidth) {
      // Shrink around the same center line, then cut what still doesn't fit.
      s = Math.max(Math.round(size * 0.75), Math.floor((size * maxWidth) / m(line)));
      m = this.measure(s, weight);
      line = ellipsize(line, maxWidth, m);
      top += (size - s) * 0.62;
    }
    return this.text({ lines: [line], size: s, widths: [m(line)] }, x, top, group, { ...options, weight });
  }

  private header(scene: RoundScene): void {
    const label = GAME_LABELS[scene.kind].toUpperCase();
    const round = `Rodada ${scene.round}/${scene.rounds}`;
    // The right end is the timer's ("Tempo esgotado" at the reveal, up to 300 px).
    const room = W - 300 - 24 - 22 - this.measure(34, 600)(round);
    const labelWidth = Math.min(this.measure(34, 800)(label), room);
    this.single(label, 34, 800, L, HEAD_Y - 20, G_HEAD, { align: 0, color: this.accent, maxWidth: labelWidth });
    this.single(round, 34, 600, L + labelWidth + 22, HEAD_Y - 20, G_HEAD, { align: 0, color: HAZE, weight: 600 });
    this.box(L, 662, W, 14, 7, G_HEAD, TRACK).flags = F_TIMER;
    const fill = this.box(L, 662, W, 14, 7, G_HEAD, this.accentRgba, NONE, rgba(this.accent, 0.5), 16);
    fill.bind = B_TIMER;
    fill.flags = F_TIMER;
    this.label(L_TIMER, R, HEAD_Y, 1, G_HEAD);
  }

  // ---- scenes ---------------------------------------------------------------------

  private trivia(scene: Extract<GameScene, { kind: "trivia" }>): void {
    const n = scene.options.length;
    const avail = FOOT_Y - 40 - TOP;
    // Biggest first; smaller type and more lines before anything is cut
    // (Portuguese questions run long).
    let q = this.fit(scene.question, W - 88, 3, [62, 56, 52]);
    let opts = scene.options.map((o) => this.fit(o, 640, 2, [44, 42, 40], 680));
    let rowMin = 100;
    const rowH = (o: FittedText) => Math.max(rowMin, o.lines.length * o.size * 1.12 + 34);
    const total = () => q.lines.length * q.size * 1.16 + 64 + 22 + opts.reduce((sum, o) => sum + rowH(o), 0) + 14 * (n - 1);
    const steps: Array<[number, number[], number, number[], number]> = [
      [3, [48, 44], 2, [40, 38], 92],
      [4, [44, 42], 2, [38, 36], 84],
      [3, [62, 56, 52, 48], 1, [44, 42, 40], 100],
      [4, [44, 42, 40], 1, [38, 36], 84],
    ];
    for (const [qLines, qSizes, oLines, oSizes, min] of steps) {
      if (total() <= avail && !isCut(q, scene.question) && !opts.some((o, i) => isCut(o, scene.options[i] as string))) break;
      q = this.fit(scene.question, W - 88, qLines, qSizes);
      opts = scene.options.map((o) => this.fit(o, 640, oLines, oSizes, 680));
      rowMin = min;
    }
    let y = TOP + Math.max(0, (avail - total()) * 0.3);
    const cardH = q.lines.length * q.size * 1.16 + 64;
    this.box(L, y, W, cardH, 40, G_MAIN, PANEL, rgba(this.accent, 0.6), rgba(this.accent, 0.22), 36);
    this.text(q, CX, y + 32, G_MAIN);
    y += cardH + 22;
    const reveal = scene.phase === "reveal";
    const pct = scene.tally ? percentages(scene.tally) : null;
    opts.forEach((o, i) => {
      const h = rowH(o);
      const color = OPTION_COLORS[i] as string;
      const correct = reveal && scene.correct === i;
      const g = G_OPT + i;
      const row = this.box(L, y, W, h, 30, g, PANEL, correct ? GREEN_RGBA : rgba(color, 0.5), correct ? rgba(GREEN, 0.6) : NONE, 30);
      if (correct) row.flags = F_PULSE;
      if (reveal && pct) {
        const bar = this.box(L, y, W, h, 30, g, rgba(correct ? GREEN : color, correct ? 0.34 : 0.28));
        bar.bind = B_BAR_X;
        bar.arg = i;
      }
      this.box(L + 16, y + (h - 76) / 2, 76, 76, 22, g, rgba(correct ? GREEN : color));
      this.single(OPTION_LETTERS[i] as string, 44, 800, L + 54, y + h / 2 - 25, g, { color: DARK });
      this.text(o, L + 122, y + (h - o.lines.length * o.size * 1.12) / 2, g, { align: 0, weight: 680, lineHeight: 1.12 });
      if (reveal && pct) this.single(`${pct[i] ?? 0}%`, 42, 800, R - 26, y + h / 2 - 24, g, { align: 1, color: correct ? GREEN : INK });
      y += h + 14;
    });
  }

  private poll(scene: Extract<GameScene, { kind: "poll" }>): void {
    const n = scene.options.length;
    const reveal = scene.phase === "reveal";
    const lead = reveal ? leader(scene.tally) : -1;
    const q = this.fit(scene.question, W - 40, 3, [62, 56, 52]);
    let y = this.text(q, CX, TOP + 4, G_MAIN, { glow: this.accent }) + 30;
    if (n === 2) {
      // This or that: two columns, the votes rise like a thermometer.
      const colW = (W - 28) / 2;
      const opts = scene.options.map((o) => this.fit(o, colW - 48, 3, [48, 44, 40], 760));
      const textH = Math.max(...opts.map((o) => o.lines.length * o.size * 1.16));
      const trackTop = y + textH + 24;
      const trackBottom = FOOT_Y - 44;
      const trackH = Math.max(240, trackBottom - trackTop);
      opts.forEach((o, i) => {
        const x = i === 0 ? L : CX + 14;
        const g = G_OPT + i;
        const color = OPTION_COLORS[i] as string;
        const leading = i === lead;
        this.text(o, x + colW / 2, y + (textH - o.lines.length * o.size * 1.16) / 2, g);
        this.box(x, trackTop, colW, trackH, 44, g, PANEL, rgba(color, 0.45));
        const bar = this.box(x, trackTop, colW, trackH, 44, g, rgba(color, 0.9), leading ? rgba("#FFD15C") : NONE, leading ? rgba("#FFD15C", 0.6) : rgba(color, 0.35), 30);
        bar.bind = B_BAR_Y;
        bar.arg = i;
        bar.min = 130;
        if (leading) bar.flags = F_PULSE;
        const barIndex = this.index;
        this.box(x + colW / 2 - 46, trackTop + trackH - 112, 92, 92, 46, g, WHITE);
        this.single(OPTION_LETTERS[i] as string, 52, 800, x + colW / 2, trackTop + trackH - 96, g, { color: DARK });
        // The share rides just above the bar's top (inside it near 100%).
        this.label(L_VALUE + i, x + colW / 2, trackTop - 58, 0.5, g, B_FOLLOW, barIndex, trackTop + 64);
      });
      const vy = trackTop + trackH * 0.42;
      this.box(CX - 60, vy - 60, 120, 120, 60, G_EXTRA, rgba("#140A30", 0.96), this.accentRgba, rgba(this.accent, 0.5), 30);
      this.single("OU", 46, 800, CX, vy - 27, G_EXTRA, { color: this.accent });
      return;
    }
    // Three or four options: racing bars.
    let pad = 36;
    let gap = 22;
    const rowH = (o: FittedText) => Math.max(100, o.lines.length * o.size * 1.16 + pad);
    const rows = (lines: number, sizes: number[]) => scene.options.map((o) => this.fit(o, W - 120 - 190, lines, sizes, 700));
    const height = (list: FittedText[]) => list.reduce((sum, o) => sum + rowH(o), 0) + gap * (n - 1);
    let opts = rows(2, [44, 42, 40]);
    if (y + height(opts) > FOOT_Y - 50) {
      // Tighter rows before cutting any option to one line.
      opts = rows(2, [38, 36]);
      pad = 24;
      gap = 14;
    }
    if (y + height(opts) > FOOT_Y - 50) {
      opts = rows(1, [44, 42, 40, 38]);
      pad = 36;
      gap = 22;
    }
    const total = height(opts);
    y += Math.max(0, (FOOT_Y - 50 - y - total) * 0.3);
    opts.forEach((o, i) => {
      const h = rowH(o);
      const g = G_OPT + i;
      const color = OPTION_COLORS[i] as string;
      const leading = i === lead;
      this.box(L, y, W, h, h / 2, g, PANEL, rgba(color, 0.4));
      const bar = this.box(L, y, W, h, h / 2, g, rgba(color, leading ? 0.85 : 0.6), leading ? rgba("#FFD15C") : NONE, leading ? rgba("#FFD15C", 0.55) : NONE, 26);
      bar.bind = B_BAR_X;
      bar.arg = i;
      bar.min = 100;
      if (leading) bar.flags = F_PULSE;
      this.box(L + 14, y + (h - 72) / 2, 72, 72, 36, g, WHITE);
      this.single(OPTION_LETTERS[i] as string, 42, 800, L + 50, y + h / 2 - 24, g, { color: DARK });
      this.text(o, L + 108, y + (h - o.lines.length * o.size * 1.16) / 2, g, { align: 0, weight: 700 });
      this.label(L_VALUE + i, R - 28, y + h / 2, 1, g);
      y += h + gap;
    });
  }

  private scramble(scene: Extract<GameScene, { kind: "scramble" }>): void {
    const reveal = scene.phase === "reveal";
    const letters = [...(reveal && scene.word ? scene.word.toUpperCase() : scene.letters)];
    this.single(reveal ? "A palavra era" : "Desembaralhe a palavra", 44, 700, CX, TOP + 30, G_MAIN, { color: HAZE, weight: 700 });
    const grid = tileGrid(letters.length, W - 40, 132);
    const top = TOP + 120;
    const tile = reveal ? rgba("#D7FFE4") : rgba("#F7F1E3");
    const edge = reveal ? GREEN_RGBA : this.accentRgba;
    letters.forEach((letter, i) => {
      const row = Math.floor(i / grid.perRow);
      const inRow = Math.min(grid.perRow, letters.length - row * grid.perRow);
      const col = i - row * grid.perRow;
      const x = CX - (inRow * grid.size + (inRow - 1) * grid.gap) / 2 + col * (grid.size + grid.gap);
      const y = top + row * (grid.size + grid.gap);
      const box = this.box(x, y, grid.size, grid.size, grid.size * 0.2, G_OPT, tile, edge, rgba(reveal ? GREEN : this.accent, 0.4), 18);
      box.bind = B_TILE;
      box.arg = i;
      box.border = 4;
      box.flags = F_SHINE;
      const size = Math.round(grid.size * 0.62);
      this.single(letter, size, 800, x + grid.size / 2, y + grid.size / 2 - size * 0.6, G_OPT, { color: DARK, bind: B_TILE, arg: i });
    });
    let y = top + grid.rows * (grid.size + grid.gap) + 34;
    if (scene.hint) y = this.hint(this.fitHint(scene.hint), y, G_EXTRA) + 30;
    if (reveal) {
      if (scene.winner) this.pair(scene.winner, " acertou!", 60, CX, y + 10, G_EXTRA2, this.accent, INK);
      else this.single("Ninguém acertou desta vez", 48, 700, CX, y + 10, G_EXTRA2, { color: HAZE, weight: 700 });
    }
  }

  private number(scene: Extract<GameScene, { kind: "number" }>): void {
    const reveal = scene.phase === "reveal";
    this.single(reveal ? "O número era" : "Está entre", 44, 700, CX, TOP + 40, G_MAIN, { color: HAZE, weight: 700 });
    this.label(L_BIG, CX, TOP + 210, 0.5, G_MAIN);
    const trackY = TOP + 390;
    const track = this.box(140, trackY, 800, 32, 16, G_OPT, TRACK, rgba(HAZE, 0.35));
    const trackIndex = this.index;
    track.border = 2;
    const range = this.box(140, trackY, 800, 32, 16, G_OPT, this.accentRgba, NONE, rgba(this.accent, 0.6), 24);
    range.bind = B_RANGE;
    if (scene.last && !reveal) {
      const mark = this.box(0, trackY - 6, 44, 44, 22, G_OPT, WHITE, rgba(DARK, 1), rgba("#FFFFFF", 0.55), 18);
      mark.bind = B_MARK;
      mark.arg = trackIndex;
    }
    this.single(String(scene.min), 38, 700, 140, trackY + 52, G_OPT, { align: 0, color: HAZE, weight: 700 });
    this.single(String(scene.max), 38, 700, 940, trackY + 52, G_OPT, { align: 1, color: HAZE, weight: 700 });
    this.label(L_SUB, CX, TOP + 580, 0.5, G_EXTRA);
  }

  private trueFalse(scene: Extract<GameScene, { kind: "truefalse" }>): void {
    const reveal = scene.phase === "reveal";
    let st = this.fit(scene.statement, W - 96, 4, [60, 56, 52]);
    if (isCut(st, scene.statement)) st = this.fit(scene.statement, W - 96, 5, [48, 44]);
    const cardH = st.lines.length * st.size * 1.16 + 72;
    this.box(L, TOP, W, cardH, 28, G_MAIN, PANEL, rgba(this.accent, 0.55), rgba(this.accent, 0.2), 30);
    this.text(st, CX, TOP + 36, G_MAIN);
    const top = TOP + cardH + 28;
    const h = FOOT_Y - 44 - top;
    const half = (W - 24) / 2;
    const pct = scene.tally ? percentages(scene.tally) : null;
    const letterSize = Math.round(Math.min(230, h * 0.5));
    ["VERDADEIRO", "FALSO"].forEach((word, i) => {
      const x = i === 0 ? L : CX + 12;
      const color = TF_COLORS[i] as string;
      const correct = reveal && scene.correct !== null && (scene.correct ? 0 : 1) === i;
      const g = G_OPT + i;
      const tile = this.box(x, top, half, h, 44, g, rgba(color, 0.16), rgba(correct ? GREEN : color, 0.85), rgba(correct ? GREEN : color, correct ? 0.65 : 0.25), 30);
      tile.border = correct ? 6 : 3;
      if (correct) tile.flags = F_PULSE;
      if (reveal && pct) {
        const bar = this.box(x, top, half, h, 44, g, rgba(color, 0.32));
        bar.bind = B_BAR_Y;
        bar.arg = i;
      }
      const cy = top + h * 0.42;
      this.single(word[0] as string, letterSize, 800, x + half / 2, cy - letterSize * 0.62, g, { color, glow: color });
      this.single(word, 52, 800, x + half / 2, cy + letterSize * 0.42, g);
      if (reveal && pct) this.single(`${pct[i] ?? 0}%`, 56, 800, x + half / 2, cy + letterSize * 0.42 + 70, g, { color: correct ? GREEN : INK });
      else this.single(i === 0 ? "digite V" : "digite F", 36, 700, x + half / 2, cy + letterSize * 0.42 + 76, g, { color: HAZE, weight: 700 });
    });
  }

  private math(scene: Extract<GameScene, { kind: "math" }>): void {
    const reveal = scene.phase === "reveal" && scene.answer !== null;
    const boardH = 540;
    // A chalkboard in a wooden frame.
    this.box(L - 4, TOP - 4, W + 8, boardH + 8, 36, G_MAIN, rgba("#7A4E2A"), rgba("#A87445", 0.9), rgba("#000000", 0.4), 30);
    this.box(L + 14, TOP + 14, W - 28, boardH - 28, 22, G_MAIN, rgba("#123326"), rgba("#FFFFFF", 0.08));
    const chalk = "#F2F5EC";
    const expr = this.fit(scene.expression, W - 120, 1, [150, 132, 116, 100, 88, 76], 700);
    this.text(expr, CX, TOP + 120, G_OPT, { weight: 700, color: chalk, glow: "#FFFFFF" });
    const answer = reveal ? `= ${scene.answer}` : "= ?";
    this.single(answer, 124, 700, CX, TOP + 300, G_EXTRA, { color: reveal ? "#FFE58A" : this.accent, glow: reveal ? "#FFD15C" : this.accent, weight: 700 });
    const y = TOP + boardH + 50;
    if (reveal) {
      if (scene.winner) this.pair(scene.winner, " acertou primeiro!", 58, CX, y, G_EXTRA2, this.accent, INK);
      else this.single("Ninguém acertou desta vez", 48, 700, CX, y, G_EXTRA2, { color: HAZE, weight: 700 });
    } else this.single("Responda no chat: o mais rápido ganha", 42, 700, CX, y, G_EXTRA2, { color: HAZE, weight: 700 });
  }

  private riddle(scene: Extract<GameScene, { kind: "riddle" }>): void {
    const reveal = scene.phase === "reveal";
    let hint = scene.hint ? this.fitHint(scene.hint) : null;
    const layout = () => {
      // Room under the card: the hint, and at the reveal the answer and who got it.
      const below = 34 + (hint ? hint.lines.length * hint.size * 1.2 + 30 : 0) + (reveal && scene.answer ? 140 + 62 : 0);
      const maxCard = FOOT_Y - 44 - TOP - below;
      let fitted = this.fit(scene.riddle, W - 150, 5, [58, 54, 52], 700);
      for (const size of [48, 44, 40]) {
        if (fitted.lines.length * fitted.size * 1.2 + 170 <= maxCard && !isCut(fitted, scene.riddle)) break;
        fitted = this.fit(scene.riddle, W - 150, Math.max(2, Math.min(6, Math.floor((maxCard - 170) / (size * 1.2)))), [size], 700);
      }
      return fitted;
    };
    let text = layout();
    // With the answer on screen the hint is spent: drop it before cutting the riddle.
    if (reveal && scene.answer && hint && isCut(text, scene.riddle)) {
      hint = null;
      text = layout();
    }
    const cardH = text.lines.length * text.size * 1.2 + 170;
    this.box(L, TOP, W, cardH, 48, G_MAIN, rgba("#1A0B3A", 0.88), rgba(this.accent, 0.6), rgba(this.accent, 0.3), 36);
    this.single("“", 190, 800, L + 44, TOP - 4, G_MAIN, { align: 0, color: withAlpha(this.accent, 0.75) });
    this.text(text, CX, TOP + 110, G_MAIN, { weight: 700, lineHeight: 1.2 });
    let y = TOP + cardH + 34;
    if (hint) y = this.hint(hint, y, G_EXTRA) + 30;
    if (reveal && scene.answer) {
      const answer = scene.answer.toUpperCase();
      let size = 60;
      while (size > 36 && this.measure(size, 800)(answer) > W - 120) size -= 4;
      const m = this.measure(size, 800);
      const word = ellipsize(answer, W - 120, m);
      const w = Math.min(W, m(word) + 100);
      const pill = this.box(CX - w / 2, y, w, 112, 56, G_EXTRA2, rgba(GREEN, 0.18), GREEN_RGBA, rgba(GREEN, 0.5), 28);
      pill.flags = F_PULSE;
      this.single(word, size, 800, CX, y + 56 - size * 0.58, G_EXTRA2);
      y += 140;
      if (scene.winner) this.pair(scene.winner, " acertou!", 52, CX, y, G_EXTRA2, this.accent, INK);
      else this.single("Ninguém acertou", 44, 700, CX, y, G_EXTRA2, { color: HAZE, weight: 700 });
    }
  }

  private fastest(scene: Extract<GameScene, { kind: "fastest" }>): void {
    const reveal = scene.phase === "reveal";
    this.single(reveal ? "E o dedo mais rápido é" : "Digite esta palavra primeiro!", 44, 700, CX, TOP + 6, G_MAIN, { color: HAZE, weight: 700 });
    const slabTop = TOP + 90;
    const slab = this.box(L, slabTop, W, 300, 44, G_OPT, this.accentRgba, rgba("#FFFFFF", 0.9), rgba(this.accent, 0.55), 40);
    slab.flags = F_SHINE;
    slab.border = 5;
    this.punch[G_OPT] = 1;
    this.delay[G_OPT] = 0.12;
    const word = this.fit(scene.word, W - 90, 1, [190, 170, 150, 132, 116, 100, 88, 76, 66, 58, 52], 800);
    this.text(word, CX, slabTop + 150 - word.size * 0.58, G_OPT, { weight: 800, color: DARK });
    const y = slabTop + 340;
    if (!reveal) return;
    if (scene.winner) {
      this.single(scene.winner, 84, 800, CX, y, G_EXTRA, { glow: this.accent });
      if (scene.winnerMs !== null) this.single(formatSeconds(scene.winnerMs), 70, 800, CX, y + 112, G_EXTRA2, { color: this.accent });
    } else this.single("Ninguém digitou a tempo", 50, 700, CX, y + 20, G_EXTRA, { color: HAZE, weight: 700 });
  }

  private scoreboard(scene: Extract<GameScene, { kind: "scoreboard" }>): void {
    // Two lines only at a size that stays clear of the first-place name.
    let title = this.fit(scene.title, W, 1, [68, 60, 54], 800);
    if (isCut(title, scene.title)) title = this.fit(scene.title, W, 2, [54, 50, 46], 800);
    this.text(title, CX, 600, G_MAIN, { weight: 800, color: "#FFD15C", glow: "#FFD15C" });
    if (scene.rows.length === 0) {
      this.single("Ninguém pontuou desta vez", 48, 700, CX, 900, G_OPT, { color: HAZE, weight: 700 });
      return;
    }
    const base = 1180;
    const width = 270;
    const heights = [300, 220, 170];
    const columns = [1, 0, 2]; // second, first, third from the left
    const order = [0.75, 0.5, 0.3]; // first place grows last
    for (let place = 0; place < Math.min(3, scene.rows.length); place++) {
      const row = scene.rows[place] as { name: string; points: number };
      const x = CX - 423 + (columns[place] as number) * (width + 18);
      const h = heights[place] as number;
      const g = G_OPT + place;
      this.delay[g] = order[place] as number;
      const color = PODIUM[place] as string;
      const block = this.box(x, base - h, width, h, 26, g, rgba(color, 0.95), rgba("#FFFFFF", 0.5), rgba(color, place === 0 ? 0.6 : 0.35), 34);
      block.bind = B_GROW;
      if (place === 0) block.flags = F_PULSE | F_SHINE;
      const ref = this.index;
      this.single(String(place + 1), 130, 800, x + width / 2, base - h + 14, g, { color: DARK, bind: B_FOLLOW, arg: ref });
      this.single(row.name, 44, 800, x + width / 2, base - h - 134, g, { bind: B_FOLLOW, arg: ref, maxWidth: width + 30 });
      this.single(`${formatCount(row.points)} pts`, 38, 700, x + width / 2, base - h - 74, g, { color, weight: 700, bind: B_FOLLOW, arg: ref });
    }
    scene.rows.slice(3, 5).forEach((row, k) => {
      const y = base + 34 + k * 108;
      const g = k === 0 ? G_EXTRA : G_EXTRA2;
      this.delay[g] = 1 + k * 0.1;
      this.box(L + 50, y, W - 100, 90, 30, g, PANEL, rgba(HAZE, 0.35));
      this.single(String(k + 4), 42, 800, L + 96, y + 20, g, { color: HAZE });
      this.single(row.name, 42, 740, L + 150, y + 20, g, { align: 0, weight: 740, maxWidth: 470 });
      this.single(`${formatCount(row.points)} pts`, 40, 800, R - 84, y + 21, g, { align: 1, color: this.accent });
    });
  }

  /**
   * The loop's podium (ADR-0028): hidden places are question marks, the one
   * the drumroll is for pulses, and each place makes its entrance (the block
   * grows back with the name on it) the moment it's revealed.
   */
  private podium(scene: Extract<GameScene, { kind: "podium" }>): void {
    this.text(this.fit(scene.title, W, 1, [68, 60, 54], 800), CX, 600, G_MAIN, { weight: 800, color: "#FFD15C", glow: "#FFD15C" });
    const base = 1180;
    const width = 270;
    const heights = [300, 220, 170];
    const columns = [1, 0, 2]; // second, first, third from the left
    const order = [0.75, 0.5, 0.3]; // first place grows last
    const first = this.podiumShown < 0;
    const elapsed = this.time - this.enterAt;
    let shown = 0;
    for (let place = 0; place < scene.places.length; place++) {
      const row = scene.places[place];
      const x = CX - 423 + (columns[place] as number) * (width + 18);
      const h = heights[place] as number;
      const g = G_OPT + place;
      const color = PODIUM[place] as string;
      const bit = 1 << place;
      if (row) shown |= bit;
      // A place revealed just now makes its entrance again; the rest stay put.
      if (first) this.delay[g] = order[place] as number;
      else if (row && !(this.podiumShown & bit)) this.delay[g] = elapsed + 0.05;
      else this.delay[g] = elapsed - 1;
      if (!row) {
        const block = this.box(x, base - h, width, h, 26, g, rgba(color, 0.16), rgba(color, 0.55), rgba(color, 0.3), 26);
        block.bind = B_GROW;
        if (scene.suspense === place + 1) block.flags = F_PULSE;
        const ref = this.index;
        this.single("?", 130, 800, x + width / 2, base - h + 14, g, { color, glow: scene.suspense === place + 1 ? color : null, bind: B_FOLLOW, arg: ref });
        this.single(`${place + 1}º lugar`, 40, 700, x + width / 2, base - h - 74, g, { color: HAZE, weight: 700, bind: B_FOLLOW, arg: ref });
        continue;
      }
      const block = this.box(x, base - h, width, h, 26, g, rgba(color, 0.95), rgba("#FFFFFF", 0.5), rgba(color, place === 0 ? 0.6 : 0.35), 34);
      block.bind = B_GROW;
      if (place === 0) block.flags = F_PULSE | F_SHINE;
      const ref = this.index;
      this.single(String(place + 1), 130, 800, x + width / 2, base - h + 14, g, { color: DARK, bind: B_FOLLOW, arg: ref });
      this.single(row.name, 44, 800, x + width / 2, base - h - 134, g, { bind: B_FOLLOW, arg: ref, maxWidth: width + 30, ...(place === 0 ? { glow: color } : {}) });
      this.single(`${formatCount(row.points)} pts`, 38, 700, x + width / 2, base - h - 74, g, { color, weight: 700, bind: B_FOLLOW, arg: ref });
    }
    this.podiumShown = shown;
  }
}

/**
 * Cuts a two-part line to `maxWidth`: a short end ("acertou!", "↓ menor")
 * stays whole and the long part (a name) gives way; otherwise the end is cut.
 */
/** Whether fitting `text` had to cut it. */
function isCut(fitted: FittedText, text: string): boolean {
  const last = fitted.lines[fitted.lines.length - 1] ?? "";
  return last.endsWith("…") && !text.trimEnd().endsWith("…");
}

function cutLonger(a: string, b: string, maxWidth: number, m: Measure): [string, string] {
  if (m(b) <= m(a) && m(b) <= maxWidth / 2) return [ellipsize(a, maxWidth - m(b), m), b];
  if (m(a) > maxWidth) return [ellipsize(a, maxWidth, m), ""];
  return [a, ellipsize(b, maxWidth - m(a), m)];
}

/** "resposta" or "respostas" (the count itself goes in the label's strong part). */
function noun(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}
