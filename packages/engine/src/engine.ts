import { disclosureText, type Emotion, type Look, type StageServerPayload } from "@tik-live/shared";
import { QualityGovernor } from "./anim/governor";
import { createRandom } from "./anim/random";
import { Spring, SpringVector, SPRINGS } from "./anim/spring";
import { AudioEngine, type PlaybackHandle } from "./audio/audio";
import type { MouthShape } from "./audio/envelope";
import { FaceController } from "./character/face";
import { hexToRgb, type Rgb } from "./color";
import { Gl, ShaderError, type Program, type QuadGeometry } from "./gl/gl";
import {
  ATMOSPHERE_FRAGMENT,
  GLOW_DOT_FRAGMENT,
  MOTES_VERTEX,
  OFFERINGS_VERTEX,
  ORB_FRAGMENT,
  RECT_VERTEX,
  SPRITE_FRAGMENT,
  VOICE_LINE_FRAGMENT,
} from "./gl/shaders";
import { Alerts, Caption, Chrome, FONT_FAMILY, type TextSprite } from "./text/sprites";

export const ENGINE_VERSION = "1.0.0";
export const STAGE_WIDTH = 1080;
export const STAGE_HEIGHT = 1920;

export type EngineMode = "program" | "preview" | "broadcast" | "demo";
export type QualitySetting = "auto" | "high" | "balanced" | "low";

export interface Telemetry {
  fps: number;
  frameP95: number;
  quality: number;
  renderer: string | null;
  error: string | null;
}

export interface EngineOptions {
  mode: EngineMode;
  /** "auto" lets the governor adapt; anything else locks that level. */
  quality?: QualitySetting;
  seed?: number;
  /** Tests: no animation loop; call `renderAt(t)` to draw a frame at time t. */
  manualClock?: boolean;
  muted?: boolean;
  /** Caps the frame rate (cloud broadcast renders at 30). */
  maxFps?: number;
  /** Injected for tests. */
  fetch?: (url: string) => Promise<Response>;
}

export interface EngineEvents {
  /** A line finished playing (program, broadcast and demo modes). */
  spoken: (cueId: string) => void;
  /** Every 10 s, and immediately on errors. */
  telemetry: (telemetry: Telemetry) => void;
}

/** What every renderer (WebGL2 or the no-GPU fallback) offers its host page. */
export interface StageEngine {
  readonly audio: AudioEngine;
  readonly mode: EngineMode;
  apply(message: StageServerPayload): void;
  setLook(name: string, look: Look): void;
  setEmotion(emotion: Emotion, holdSeconds?: number): void;
  renderAt(t: number): void;
  telemetry(): Telemetry;
  readonly failed: string | null;
  on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): () => void;
  resize(): void;
  destroy(): void;
}

const QUALITY_LEVEL: Record<Exclude<QualitySetting, "auto">, number> = { high: 0, balanced: 1, low: 2 };

const ORB = { x: 540, y: 720, r: 165, extent: 2.4 };
const MOTES = 96;
const OFFERING_SLOTS = 192;
const GOLD: Rgb = hexToRgb("#FFD15C");
const INK_DARK: Rgb = hexToRgb("#0B0420");
const DEFAULT_LOOK: Look = { character: "orb", primary: "#7CF5FF", secondary: "#FF5FD2", background: "#0B0420" };

interface Cue {
  id: string;
  handle: PlaybackHandle | null;
  cancelled: boolean;
}

class Emitter {
  private readonly listeners: { [K in keyof EngineEvents]: Set<EngineEvents[K]> } = { spoken: new Set(), telemetry: new Set() };

  on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): () => void {
    const set = this.listeners[event] as Set<EngineEvents[K]>;
    set.add(listener);
    return () => set.delete(listener);
  }

  emit<K extends keyof EngineEvents>(event: K, ...args: Parameters<EngineEvents[K]>): void {
    for (const listener of this.listeners[event] as Set<(...a: Parameters<EngineEvents[K]>) => void>) {
      try {
        listener(...args);
      } catch {
        // A listener's failure must never stop the stage.
      }
    }
  }

  clear(): void {
    this.listeners.spoken.clear();
    this.listeners.telemetry.clear();
  }
}

export class WebGLUnavailableError extends Error {
  constructor() {
    super("WebGL2 is not available");
  }
}

/** Creates the WebGL2 engine, or the no-GPU fallback when WebGL2 is unavailable. */
export function createEngine(canvas: HTMLCanvasElement, options: EngineOptions): StageEngine {
  try {
    return new Engine(canvas, options);
  } catch (err) {
    if (err instanceof WebGLUnavailableError) return new FallbackEngine(canvas, options);
    throw err;
  }
}

/** Plays one line at a time and reports when it finished. */
class Speaker {
  private cue: Cue | null = null;

  constructor(
    private readonly audio: AudioEngine,
    private readonly mode: EngineMode,
    private readonly events: Emitter,
  ) {}

  get current(): Cue | null {
    return this.cue;
  }

  async speak(
    id: string,
    text: string,
    audioUrl: string | null,
    durationMs: number,
    hooks: { started?: (durationS: number) => void; finished?: () => void } = {},
  ): Promise<void> {
    this.stop();
    const cue: Cue = { id, handle: null, cancelled: false };
    this.cue = cue;
    const handle = await this.audio.play(text, audioUrl, durationMs);
    if (cue.cancelled) {
      handle.stop();
      return;
    }
    cue.handle = handle;
    hooks.started?.(handle.duration);
    await handle.done;
    if (cue.cancelled || this.cue !== cue) return;
    this.cue = null;
    hooks.finished?.();
    // Previews never pace the host; only on-air stages (and the demo) report.
    if (this.mode !== "preview") this.events.emit("spoken", id);
  }

  stop(): void {
    if (this.cue) {
      this.cue.cancelled = true;
      this.cue.handle?.stop();
      this.cue = null;
    }
    this.audio.stop();
  }
}

/**
 * The stage engine (ADR-0009). One WebGL2 canvas renders the atmosphere,
 * motes, gift offerings, the character and the text sprites; everything
 * animates on one clock with springs.
 */
export class Engine implements StageEngine {
  readonly audio: AudioEngine;
  readonly mode: EngineMode;
  private readonly gl: Gl;
  private readonly governor: QualityGovernor;
  private readonly random: () => number;
  private readonly face: FaceController;
  private readonly events = new Emitter();
  private readonly speaker: Speaker;

  private atmosphere: Program | null = null;
  private motes: Program | null = null;
  private offerings: Program | null = null;
  private orb: Program | null = null;
  private voiceLine: Program | null = null;
  private sprite: Program | null = null;
  private quad!: QuadGeometry;
  private moteQuad!: QuadGeometry;
  private offeringQuad!: QuadGeometry;
  private readonly offeringA = new Float32Array(OFFERING_SLOTS * 4);
  private readonly offeringB = new Float32Array(OFFERING_SLOTS * 4);
  private offeringCursor = 0;
  private readonly arrivals: Array<{ at: number; big: boolean }> = [];

  private readonly caption: Caption;
  private readonly alerts: Alerts;
  private readonly chrome: Chrome;

  private name = "Host";
  private look: Look = DEFAULT_LOOK;
  private readonly colors = new SpringVector(
    [...hexToRgb(DEFAULT_LOOK.primary), ...hexToRgb(DEFAULT_LOOK.secondary), ...hexToRgb(DEFAULT_LOOK.background)],
    SPRINGS.gentle,
  );
  private readonly characterMix = new Spring(1, SPRINGS.gentle); // 1 = orb, 0 = voice line
  private readonly bounce = new Spring(0, SPRINGS.bouncy);
  private readonly glow = new Spring(0.6, SPRINGS.gentle);
  private flash = 0;
  private emotionUntil = Infinity;
  private amplitude = 0;
  private readonly vowel: MouthShape = { round: 0, wide: 0 };
  // Per-frame scratch, reused so the frame loop never allocates.
  private readonly primary: Rgb = [0, 0, 0];
  private readonly secondary: Rgb = [0, 0, 0];
  private readonly background: Rgb = [0, 0, 0];

  private time = 0;
  private lastFrame = 0;
  private raf = 0;
  private running = false;
  private visible = true;
  private scale = 1;
  private lastTelemetryAt = 0;
  private error: string | null = null;
  private renderer: string | null = null;
  private destroyed = false;
  private readonly observers: Array<() => void> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: EngineOptions,
  ) {
    this.mode = options.mode;
    this.random = createRandom(options.seed ?? 0x7a11);
    this.face = new FaceController(this.random);
    const quality = options.quality ?? "auto";
    this.governor = new QualityGovernor(quality === "auto" ? 0 : QUALITY_LEVEL[quality], quality !== "auto");
    const gl = (() => {
      try {
        return new Gl(canvas, {
          alpha: false,
          antialias: false,
          depth: false,
          stencil: false,
          premultipliedAlpha: true,
          powerPreference: "high-performance",
          preserveDrawingBuffer: options.mode === "broadcast" || options.manualClock === true,
        });
      } catch {
        throw new WebGLUnavailableError();
      }
    })();
    this.gl = gl;
    this.audio = new AudioEngine({
      muted: options.muted ?? options.mode === "preview",
      capture: options.mode === "broadcast",
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.speaker = new Speaker(this.audio, this.mode, this.events);
    this.detectRenderer();
    this.build();
    this.caption = new Caption(this.gl);
    this.alerts = new Alerts(this.gl);
    this.chrome = new Chrome(this.gl);
    this.listen();
    this.resize();
    this.chrome.setBadge(disclosureText(this.name), this.scale);
    void this.loadFonts();
    if (!options.manualClock) this.start();
  }

  // ---- public API ---------------------------------------------------------

  /** Applies a protocol message from the server (or the demo driver). */
  apply(message: StageServerPayload): void {
    switch (message.t) {
      case "hello":
      case "look":
        this.setLook(message.name, message.look);
        break;
      case "speak":
        void this.speak(message.id, message.text, message.emotion, message.audioUrl, message.durationMs);
        break;
      case "prefetch":
        this.audio.prefetch(message.audioUrl);
        break;
      case "stop":
        this.speaker.stop();
        this.caption.hide();
        break;
      case "alert":
        this.alert(message.kind, message.name, alertDetail(message), message.diamonds ?? 0);
        break;
      case "segment":
        this.chrome.setTitle(message.title, this.scale);
        break;
      case "stats":
      case "hold":
        break;
    }
  }

  setLook(name: string, look: Look): void {
    const nameChanged = name !== this.name;
    this.name = name;
    this.look = look;
    this.colors.setTarget([...hexToRgb(look.primary), ...hexToRgb(look.secondary), ...hexToRgb(look.background)]);
    this.characterMix.target = look.character === "orb" ? 1 : 0;
    this.caption.setGlow(look.primary);
    this.alerts.setGlow(look.primary);
    this.chrome.setGlow(look.primary, this.scale);
    if (nameChanged) this.chrome.setBadge(disclosureText(name), this.scale);
  }

  /** The current look (for editors that need to diff). */
  get currentLook(): Look {
    return this.look;
  }

  /** Makes the character react without speaking (editor previews). */
  setEmotion(emotion: Emotion, holdSeconds = 2.5): void {
    this.face.setEmotion(emotion);
    this.emotionUntil = this.time + holdSeconds;
  }

  /** Renders one frame at time `t` seconds (manual clock, for tests and thumbnails). */
  renderAt(t: number): void {
    while (this.time < t - 1e-6) {
      const dt = Math.min(1 / 60, t - this.time);
      this.time += dt;
      this.update(dt);
    }
    this.draw();
  }

  telemetry(): Telemetry {
    return {
      fps: Math.round(this.governor.fps() * 10) / 10,
      frameP95: Math.round(this.governor.frameP95() * 100) / 100,
      quality: this.governor.level,
      renderer: this.renderer,
      error: this.error,
    };
  }

  get failed(): string | null {
    return this.error;
  }

  on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): () => void {
    return this.events.on(event, listener);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = rect.width || STAGE_WIDTH;
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const renderScale = this.governor.settings.renderScale;
    const width = Math.max(64, Math.min(STAGE_WIDTH * 2, Math.round(cssWidth * dpr * renderScale)));
    const height = Math.round((width * STAGE_HEIGHT) / STAGE_WIDTH);
    let changed = false;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      changed = true;
    }
    const nextScale = Math.max(0.25, Math.min(2, width / STAGE_WIDTH));
    if (Math.abs(nextScale - this.scale) > 0.01) {
      this.scale = nextScale;
      this.repaintText();
    }
    // A resized canvas is cleared; redraw now so there's never a blank frame.
    if (changed && !this.running && this.caption) this.draw();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    for (const off of this.observers) off();
    this.speaker.stop();
    this.audio.destroy();
    this.events.clear();
  }

  // ---- speech -------------------------------------------------------------

  private async speak(id: string, text: string, emotion: Emotion, audioUrl: string | null, durationMs: number): Promise<void> {
    this.face.setEmotion(emotion);
    this.emotionUntil = Infinity;
    this.caption.show(text);
    await this.speaker.speak(id, text, audioUrl, durationMs, {
      started: (durationS) => this.caption.start(this.time, durationS),
      finished: () => {
        this.caption.finish(this.time);
        this.emotionUntil = this.time + 2.5;
      },
    });
  }

  private alert(kind: "gift" | "follow" | "share", name: string, detail: string, diamonds: number): void {
    this.alerts.push(kind, name, detail, this.time, this.scale);
    if (kind === "gift") {
      const count = Math.min(36, 4 + Math.round(Math.log10(diamonds + 1) * 7));
      const big = diamonds >= 1000;
      for (let i = 0; i < count; i++) this.spawnOffering(i * 0.045, big);
      this.face.lookAt(0.7, -0.4, this.time + 2.2);
    } else {
      this.bounce.impulse(-4);
    }
  }

  private spawnOffering(delay: number, big: boolean): void {
    const slot = this.offeringCursor;
    this.offeringCursor = (this.offeringCursor + 1) % OFFERING_SLOTS;
    const start = this.time + delay;
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
    this.offeringQuad.updateInstances(1, a, 4);
    this.offeringQuad.updateInstances(2, a, 4);
    this.arrivals.push({ at: start + duration, big });
  }

  // ---- frame loop -----------------------------------------------------------

  private start(): void {
    if (this.running || this.destroyed || !this.visible || this.gl.lost) return;
    this.running = true;
    this.lastFrame = performance.now();
    const minInterval = this.options.maxFps ? 1000 / this.options.maxFps - 1 : 0;
    const frame = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(frame);
      const interval = now - this.lastFrame;
      if (interval < minInterval) return;
      this.lastFrame = now;
      const workStart = performance.now();
      const dt = Math.min(0.05, interval / 1000);
      this.time += dt;
      this.update(dt);
      this.draw();
      const work = performance.now() - workStart;
      if (this.governor.record(interval, work, now)) this.resize();
      if (now - this.lastTelemetryAt > 10_000) {
        this.lastTelemetryAt = now;
        this.events.emit("telemetry", this.telemetry());
      }
    };
    this.raf = requestAnimationFrame(frame);
  }

  private stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private update(dt: number): void {
    const t = this.time;
    this.colors.step(dt);
    this.characterMix.step(dt);
    this.bounce.step(dt);
    this.amplitude += (this.audio.amplitude() - this.amplitude) * Math.min(1, dt * 20);
    this.audio.mouthShape(this.vowel);
    this.glow.target = 0.55 + this.amplitude * 0.6;
    this.glow.step(dt);
    this.flash = Math.max(0, this.flash - dt * 0.9);
    while (this.arrivals.length && (this.arrivals[0] as { at: number }).at <= t) {
      const arrival = this.arrivals.shift()!;
      this.flash = Math.min(1.4, this.flash + (arrival.big ? 0.25 : 0.12));
      this.bounce.impulse(arrival.big ? -3 : -1.2);
      if (this.arrivals.length === 0 && !this.speaker.current) this.setEmotion("excited", 1.8);
    }
    const speaking = this.speaker.current !== null;
    if (!speaking && t > this.emotionUntil && this.face.current !== "neutral") this.face.setEmotion("neutral");
    this.face.update(dt, t, speaking ? this.amplitude : 0, this.vowel);
    this.caption.update(dt, t, this.scale);
    this.alerts.update(dt, t);
    this.chrome.update(dt, t);
  }

  private draw(): void {
    if (this.gl.lost || !this.atmosphere) return;
    const gl = this.gl.gl;
    const t = this.time;
    const { primary, secondary, background } = this;
    for (let i = 0; i < 3; i++) {
      primary[i] = this.colors.get(i);
      secondary[i] = this.colors.get(3 + i);
      background[i] = this.colors.get(6 + i);
    }
    const orbY = ORB.y + Math.sin(t * 1.3) * 14 + this.bounce.value * 6;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    this.atmosphere
      .use()
      .v2("u_res", STAGE_WIDTH, STAGE_HEIGHT)
      .v4("u_rect", 0, 0, STAGE_WIDTH, STAGE_HEIGHT)
      .f("u_time", t)
      .rgb("u_bg", background)
      .rgb("u_primary", primary)
      .rgb("u_secondary", secondary)
      .rgb("u_gold", GOLD)
      .v2("u_orb", ORB.x, orbY)
      .f("u_glow", this.glow.value)
      .f("u_flash", this.flash);
    this.quad.draw();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if (this.motes) {
      this.motes
        .use()
        .v2("u_res", STAGE_WIDTH, STAGE_HEIGHT)
        .f("u_time", t)
        .v2("u_orb", ORB.x, orbY)
        .f("u_amp", this.amplitude)
        .rgb("u_color", primary);
      this.moteQuad.draw(Math.round(MOTES * this.governor.settings.moteFraction));
    }
    if (this.offerings) {
      this.offerings.use().v2("u_res", STAGE_WIDTH, STAGE_HEIGHT).f("u_time", t).v2("u_orb", ORB.x, orbY).rgb("u_color", GOLD);
      this.offeringQuad.draw(OFFERING_SLOTS);
    }

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const mix = this.characterMix.value;
    if (mix > 0.01) this.drawOrb(t, orbY, primary, secondary, Math.min(1, mix));
    if (mix < 0.99) this.drawVoiceLine(t, primary, secondary, Math.min(1, 1 - mix));

    this.drawSprite(this.chrome.title);
    this.drawSprite(this.chrome.badge);
    this.alerts.forEachSprite(this.drawSprite);
    this.drawSprite(this.caption.sprite);
  }

  private drawOrb(t: number, orbY: number, primary: Rgb, secondary: Rgb, alpha: number): void {
    if (!this.orb) return;
    const face = this.face.state;
    const r = ORB.r * (1 + this.amplitude * 0.05 + this.flash * 0.04) * (0.6 + 0.4 * alpha);
    const half = r * ORB.extent;
    const squash = Math.max(-0.08, Math.min(0.08, this.bounce.velocity * 0.012));
    this.orb
      .use()
      .v2("u_res", STAGE_WIDTH, STAGE_HEIGHT)
      .v4("u_rect", ORB.x - half, orbY - half, half * 2, half * 2)
      .f("u_time", t)
      .f("u_amp", this.amplitude)
      .rgb("u_primary", primary)
      .rgb("u_secondary", secondary)
      .rgb("u_ink", INK_DARK)
      .rgb("u_gold", GOLD)
      .f("u_desat", face.desat)
      .f("u_flash", this.flash)
      .f("u_squash", squash)
      .f("u_extent", ORB.extent)
      .f("u_px", 1 / (r * this.scale))
      .v4("u_eye", face.eye[0], face.eye[1], face.eye[2], face.eye[3])
      .v4("u_eye2", face.eye2[0], face.eye2[1], face.eye2[2], face.eye2[3])
      .v2("u_gaze", face.gaze[0], face.gaze[1])
      .v4("u_mouth", face.mouth[0], face.mouth[1], face.mouth[2], face.mouth[3])
      .v2("u_vowel", face.vowel[0], face.vowel[1])
      .f("u_blush", face.blush)
      .f("u_alpha", alpha);
    this.quad.draw();
  }

  private drawVoiceLine(t: number, primary: Rgb, secondary: Rgb, alpha: number): void {
    if (!this.voiceLine) return;
    const height = 400;
    this.voiceLine
      .use()
      .v2("u_res", STAGE_WIDTH, STAGE_HEIGHT)
      .v4("u_rect", 0, ORB.y - height / 2, STAGE_WIDTH, height)
      .f("u_time", t)
      .f("u_amp", this.amplitude * alpha)
      .rgb("u_primary", primary)
      .rgb("u_secondary", secondary)
      .rgb("u_gold", GOLD)
      .f("u_flash", this.flash)
      .f("u_px", 1 / this.scale)
      .f("u_alpha", alpha);
    this.quad.draw();
  }

  private readonly drawSprite = (sprite: TextSprite): void => {
    if (!this.sprite || !sprite.visible()) return;
    sprite.textures[0].bind(0);
    sprite.textures[1].bind(1);
    this.sprite
      .use()
      .v2("u_res", STAGE_WIDTH, STAGE_HEIGHT)
      .v4("u_rect", sprite.x, sprite.y + sprite.offsetY.value, sprite.width, sprite.height)
      .i("u_tex", 0)
      .i("u_tex2", 1)
      .f("u_mix", sprite.mix)
      .f("u_opacity", Math.max(0, Math.min(1, sprite.opacity.value)));
    this.quad.draw();
  };

  // ---- setup ------------------------------------------------------------------

  /**
   * Compiles every program on its own: if the character's shader fails on
   * some driver, the stage still shows the atmosphere and captions, and the
   * error goes to the studio through telemetry.
   */
  private build(): void {
    const tryProgram = (name: string, vertex: string, fragment: string): Program | null => {
      try {
        return this.gl.program(name, vertex, fragment);
      } catch (err) {
        this.error ??= (err instanceof ShaderError ? err.message : String(err)).slice(0, 480);
        return null;
      }
    };
    this.atmosphere = tryProgram("atmosphere", RECT_VERTEX, ATMOSPHERE_FRAGMENT);
    this.sprite = tryProgram("sprite", RECT_VERTEX, SPRITE_FRAGMENT);
    this.motes = tryProgram("motes", MOTES_VERTEX, GLOW_DOT_FRAGMENT);
    this.offerings = tryProgram("offerings", OFFERINGS_VERTEX, GLOW_DOT_FRAGMENT);
    this.orb = tryProgram("orb", RECT_VERTEX, ORB_FRAGMENT);
    this.voiceLine = tryProgram("voice-line", RECT_VERTEX, VOICE_LINE_FRAGMENT);
    if (this.error) queueMicrotask(() => this.events.emit("telemetry", this.telemetry()));

    this.quad = this.gl.quad();
    this.moteQuad = this.gl.quad();
    const seeds = new Float32Array(MOTES * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = this.random();
    this.moteQuad.attachInstances(1, 4, seeds);
    this.offeringQuad = this.gl.quad();
    this.offeringA.fill(0);
    for (let i = 0; i < OFFERING_SLOTS; i++) this.offeringA[i * 4 + 2] = -1000;
    this.offeringB.fill(1);
    this.offeringQuad.attachInstances(1, 4, this.offeringA);
    this.offeringQuad.attachInstances(2, 4, this.offeringB);
  }

  private detectRenderer(): void {
    const gl = this.gl.gl;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    this.renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)).slice(0, 200) : null;
  }

  private listen(): void {
    const onLost = (event: Event) => {
      event.preventDefault();
      this.stop();
    };
    const onRestored = () => {
      if (this.destroyed) return;
      this.gl.rebuildAll();
      this.repaintText();
      if (this.options.manualClock) this.draw();
      else this.start();
    };
    this.canvas.addEventListener("webglcontextlost", onLost);
    this.canvas.addEventListener("webglcontextrestored", onRestored);
    this.observers.push(() => {
      this.canvas.removeEventListener("webglcontextlost", onLost);
      this.canvas.removeEventListener("webglcontextrestored", onRestored);
    });

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => this.resize());
      observer.observe(this.canvas);
      this.observers.push(() => observer.disconnect());
    }

    // Previews pause when hidden or scrolled away; on-air stages never do.
    if ((this.mode === "preview" || this.mode === "demo") && !this.options.manualClock && typeof document !== "undefined") {
      let onScreen = true;
      const sync = () => {
        this.visible = document.visibilityState === "visible" && onScreen;
        if (this.visible) this.start();
        else this.stop();
      };
      document.addEventListener("visibilitychange", sync);
      this.observers.push(() => document.removeEventListener("visibilitychange", sync));
      if (typeof IntersectionObserver !== "undefined") {
        const io = new IntersectionObserver((entries) => {
          onScreen = entries.some((e) => e.isIntersecting);
          sync();
        });
        io.observe(this.canvas);
        this.observers.push(() => io.disconnect());
      }
    }
  }

  private async loadFonts(): Promise<void> {
    if (typeof document === "undefined" || !document.fonts) return;
    try {
      await Promise.all([
        document.fonts.load(`720 64px ${FONT_FAMILY}`),
        document.fonts.load(`800 32px ${FONT_FAMILY}`),
        document.fonts.load(`560 26px ${FONT_FAMILY}`),
      ]);
    } catch {
      // Fall back to system fonts; text still renders.
    }
    if (!this.destroyed) this.repaintText();
  }

  private repaintText(): void {
    if (!this.caption) return;
    this.caption.invalidate();
    this.alerts.repaint(this.scale);
    this.chrome.repaint(this.scale);
  }
}

function alertDetail(message: Extract<StageServerPayload, { t: "alert" }>): string {
  if (message.kind === "gift") {
    const count = message.count ?? 1;
    return `${count > 1 ? `${count} ` : ""}${message.giftName ?? "gift"}`;
  }
  return message.kind === "follow" ? "followed" : "shared the stream";
}

/**
 * No WebGL2 (hardware acceleration off in OBS): show how to fix it, and keep
 * the voice going so the stream isn't silent while the creator fixes it.
 */
class FallbackEngine implements StageEngine {
  readonly audio: AudioEngine;
  readonly mode: EngineMode;
  private readonly events = new Emitter();
  private readonly speaker: Speaker;
  private readonly ctx: CanvasRenderingContext2D | null;
  private name = "Host";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: EngineOptions,
  ) {
    this.mode = options.mode;
    this.audio = new AudioEngine({
      muted: options.muted ?? options.mode === "preview",
      capture: options.mode === "broadcast",
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.speaker = new Speaker(this.audio, this.mode, this.events);
    this.ctx = canvas.getContext("2d");
    this.resize();
    queueMicrotask(() => this.events.emit("telemetry", this.telemetry()));
  }

  apply(message: StageServerPayload): void {
    if (message.t === "speak") void this.speaker.speak(message.id, message.text, message.audioUrl, message.durationMs);
    else if (message.t === "prefetch") this.audio.prefetch(message.audioUrl);
    else if (message.t === "stop") this.speaker.stop();
    else if (message.t === "hello" || message.t === "look") this.setLook(message.name);
  }

  setLook(name: string): void {
    this.name = name;
    this.paint();
  }

  setEmotion(): void {}

  renderAt(): void {
    this.paint();
  }

  telemetry(): Telemetry {
    return { fps: 0, frameP95: 0, quality: 0, renderer: null, error: "webgl2-unavailable" };
  }

  get failed(): string {
    return "webgl2-unavailable";
  }

  on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): () => void {
    return this.events.on(event, listener);
  }

  resize(): void {
    this.canvas.width = STAGE_WIDTH / 2;
    this.canvas.height = STAGE_HEIGHT / 2;
    this.paint();
  }

  destroy(): void {
    this.speaker.stop();
    this.audio.destroy();
    this.events.clear();
  }

  private paint(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = DEFAULT_LOOK.background;
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = "center";
    ctx.fillStyle = "#F4F0FF";
    ctx.font = `700 26px ${FONT_FAMILY}`;
    ctx.fillText(`${this.name} can't draw here yet`, w / 2, h / 2 - 20);
    ctx.fillStyle = "#A397D6";
    ctx.font = `500 17px ${FONT_FAMILY}`;
    ctx.fillText("Turn on hardware acceleration in OBS:", w / 2, h / 2 + 18);
    ctx.fillText("Settings > Advanced > Sources", w / 2, h / 2 + 42);
  }
}
