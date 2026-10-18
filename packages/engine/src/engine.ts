import { disclosureText, type Effect, type Emotion, type Look, type StageServerPayload } from "@tik-live/shared";
import { QualityGovernor } from "./anim/governor";
import { createRandom } from "./anim/random";
import { Spring, SpringVector, SPRINGS } from "./anim/spring";
import { AudioEngine, type PlaybackHandle } from "./audio/audio";
import type { MusicPlayer } from "./audio/music";
import { FrameCapture, type CaptureOptions, type CaptureStats } from "./capture";
import { hexToRgb } from "./color";
import type { GameLayer } from "./game/scene";
import { Gl, ShaderError, type Program, type QuadGeometry, type RenderTarget } from "./gl/gl";
import { FULLSCREEN_VERTEX, RECT_VERTEX, SPRITE_FRAGMENT, SPRITE_SINGLE_FRAGMENT, YUV_CHROMA_FRAGMENT, YUV_LUMA_FRAGMENT } from "./gl/shaders";
import { AtmosphereLayer, STAGE_HEIGHT, STAGE_WIDTH } from "./stage/atmosphere";
import { CharacterLayer } from "./stage/character";
import type { FxLayer } from "./stage/fx";
import { Frame, type Layer, type StageContext } from "./stage/layer";
import { TextLayer } from "./stage/text";
import { FONT_FAMILY, type TextSprite } from "./text/sprites";

export const ENGINE_VERSION = "1.2.0";
/** Cloud broadcast audio rate; the broadcaster's encoder reads PCM at this rate. */
export const BROADCAST_SAMPLE_RATE = 48_000;
export { STAGE_HEIGHT, STAGE_WIDTH };

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
  /** A line's audio started; `durationMs` is its real length (program, broadcast and demo modes). */
  started: (cueId: string, durationMs: number) => void;
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
  /**
   * Cloud broadcast only: draw frames offscreen at a fixed size and hand
   * them over as I420 (ADR-0020). Returns a function that stops capturing.
   * Absent on the no-WebGL fallback.
   */
  startCapture?(options: CaptureOptions): () => void;
  captureStats?(): CaptureStats | null;
}

const QUALITY_LEVEL: Record<Exclude<QualitySetting, "auto">, number> = { high: 0, balanced: 1, low: 2 };
const DEFAULT_LOOK: Look = { character: "orb", primary: "#7CF5FF", secondary: "#FF5FD2", background: "#0B0420" };
/** How far the atmosphere moves toward a game's palette (the rest stays the host's). */
const GAME_TINT = 0.85;

/** One line to perform, as the server sent it. */
export interface Line {
  id: string;
  text: string;
  emotion: Emotion;
  audioUrl: string | null;
  durationMs: number;
  /** Reactions to play when the line starts. */
  fx?: Effect[];
}

interface Cue {
  line: Line;
  handle: PlaybackHandle | null;
  cancelled: boolean;
}

export class Emitter {
  private readonly listeners: { [K in keyof EngineEvents]: Set<EngineEvents[K]> } = {
    started: new Set(),
    spoken: new Set(),
    telemetry: new Set(),
  };

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
    this.listeners.started.clear();
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

export interface SpeakerHooks {
  /** A line takes the stage: show its caption and expression. */
  begin?(line: Line): void;
  /** Its audio (or silent envelope) started and lasts `durationS`. */
  started?(line: Line, durationS: number): void;
  finished?(line: Line): void;
}

/** Lines that may wait behind the one playing; past this the oldest waiting line is skipped. */
const MAX_WAITING_LINES = 3;

/**
 * Plays lines one after another and reports when each started and finished
 * (ADR-0022). A line that arrives while another is playing waits for it to
 * end instead of cutting it off, so a sentence is never chopped because the
 * server moved on early; only `stop` cuts.
 */
export class Speaker {
  private cue: Cue | null = null;
  private waiting: Line[] = [];

  constructor(
    private readonly audio: AudioEngine,
    private readonly mode: EngineMode,
    private readonly events: Emitter,
    private readonly hooks: SpeakerHooks = {},
  ) {}

  get current(): Cue | null {
    return this.cue;
  }

  /** Lines waiting behind the current one. */
  get queued(): number {
    return this.waiting.length;
  }

  speak(line: Line): void {
    if (!this.cue) {
      void this.run(line);
      return;
    }
    this.waiting.push(line);
    if (line.audioUrl) this.audio.prefetch(line.audioUrl);
    while (this.waiting.length > MAX_WAITING_LINES) {
      // Far behind (a stalled decode, a throttled tab): skip the stalest line
      // rather than fall further behind, and release whoever waits on it.
      const skipped = this.waiting.shift() as Line;
      this.report("spoken", skipped.id);
    }
  }

  stop(): void {
    this.waiting = [];
    if (this.cue) {
      this.cue.cancelled = true;
      this.cue.handle?.stop();
      this.cue = null;
    }
    this.audio.stop();
  }

  private async run(line: Line): Promise<void> {
    const cue: Cue = { line, handle: null, cancelled: false };
    this.cue = cue;
    this.hooks.begin?.(line);
    const handle = await this.audio.play(line.text, line.audioUrl, line.durationMs);
    if (cue.cancelled) {
      handle.stop();
      return;
    }
    cue.handle = handle;
    this.hooks.started?.(line, handle.duration);
    this.report("started", line.id, Math.round(handle.duration * 1000));
    await handle.done;
    if (cue.cancelled || this.cue !== cue) return;
    this.cue = null;
    this.hooks.finished?.(line);
    this.report("spoken", line.id);
    const next = this.waiting.shift();
    if (next) void this.run(next);
  }

  private report(event: "started", id: string, durationMs: number): void;
  private report(event: "spoken", id: string): void;
  private report(event: "started" | "spoken", id: string, durationMs = 0): void {
    // Previews never pace the host; only on-air stages (and the demo) report.
    if (this.mode === "preview") return;
    if (event === "started") this.events.emit("started", id, durationMs);
    else this.events.emit("spoken", id);
  }
}

/**
 * The stage engine (ADR-0009): a coordinator over a stack of layers. It owns
 * the GPU context, the clock, the quality governor and capture, applies
 * protocol messages, and updates and draws the layers in order:
 * atmosphere, effects behind, character, game board, effects ahead, text.
 *
 * Effects, game scenes and music load in later chunks right after
 * start-up, so the first frame doesn't wait for them; messages that need
 * them queue until they arrive (a few milliseconds).
 */
export class Engine implements StageEngine {
  readonly audio: AudioEngine;
  readonly mode: EngineMode;
  private readonly gl: Gl;
  private readonly governor: QualityGovernor;
  private readonly random: () => number;
  private readonly events = new Emitter();
  private readonly speaker: Speaker;
  private readonly frame = new Frame();
  private readonly ctx: StageContext;

  private sprite: Program | null = null;
  private spriteSingle: Program | null = null;
  /** Where frames go: the canvas (null) or an offscreen target (cloud broadcast capture). */
  private output: RenderTarget | null = null;
  private capture: FrameCapture | null = null;
  private quad!: QuadGeometry;

  private readonly atmosphere: AtmosphereLayer;
  private readonly character: CharacterLayer;
  private readonly text: TextLayer;
  private fx: FxLayer | null = null;
  private game: GameLayer | null = null;
  /** Update order (the character first: others follow where it is). */
  private updates: Layer[] = [];
  /** Draw order, back to front. */
  private layers: Layer[] = [];
  private extras: Promise<void> | null = null;
  private waiting: Array<() => void> = [];
  /** Music and sound effects (ADR-0024); ducks itself under the voice. Loads with the extras. */
  private music: MusicPlayer | null = null;

  // Until the server says who's hosting: "O apresentador é uma IA".
  private name = "O apresentador";
  private look: Look = DEFAULT_LOOK;
  private readonly colors = new SpringVector(
    [...hexToRgb(DEFAULT_LOOK.primary), ...hexToRgb(DEFAULT_LOOK.secondary), ...hexToRgb(DEFAULT_LOOK.background)],
    SPRINGS.gentle,
  );
  /** 0 = normal show layout, 1 = game layout. */
  private readonly gameMix = new Spring(0, { stiffness: 150, damping: 19 });
  private likes = -1;

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
    // A broadcast's output size is fixed: never trade resolution for frame rate there.
    const quality = options.quality ?? (options.mode === "broadcast" ? "high" : "auto");
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
          // Tests read the canvas back after renderAt(); everyone else lets the browser swap buffers.
          preserveDrawingBuffer: options.manualClock === true,
        });
      } catch {
        throw new WebGLUnavailableError();
      }
    })();
    this.gl = gl;
    this.audio = new AudioEngine({
      muted: options.muted ?? options.mode === "preview",
      ...(options.mode === "broadcast" ? { sampleRate: BROADCAST_SAMPLE_RATE } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.detectRenderer();
    this.quad = gl.quad();
    this.sprite = this.tryProgram("sprite", RECT_VERTEX, SPRITE_FRAGMENT);
    this.spriteSingle = this.tryProgram("sprite-single", RECT_VERTEX, SPRITE_SINGLE_FRAGMENT);
    this.ctx = {
      gl,
      quad: this.quad,
      program: (name, vertex, fragment) => this.tryProgram(name, vertex, fragment),
      drawSprite: this.drawSprite,
      bindOutput: () => this.bindOutput(),
    };
    this.atmosphere = new AtmosphereLayer(this.ctx, this.random);
    this.character = new CharacterLayer(this.ctx, this.audio, this.random);
    this.text = new TextLayer(this.ctx);
    this.stack();
    if (this.error) queueMicrotask(() => this.events.emit("telemetry", this.telemetry()));

    this.speaker = new Speaker(this.audio, this.mode, this.events, {
      begin: (line) => {
        this.character.setEmotion(line.emotion, this.time, null);
        this.text.caption.show(line.text);
        for (const effect of line.fx ?? []) this.play(effect, 1);
      },
      started: (_line, durationS) => this.text.caption.start(this.time, durationS),
      finished: () => {
        this.text.caption.finish(this.time);
        this.character.relax(this.time);
      },
    });
    this.listen();
    this.resize();
    this.text.chrome.setBadge(disclosureText(this.name), this.scale);
    void this.loadFonts();
    if (!options.manualClock) {
      this.start();
      // Effects and games: right after the first frames, never before them.
      setTimeout(() => void this.ready(), 0);
    }
  }

  // ---- public API ---------------------------------------------------------

  /** Applies a protocol message from the server (or the demo driver). */
  apply(message: StageServerPayload): void {
    // `music` and `sfx` go to the music player.
    if (message.t === "music" || message.t === "sfx") {
      this.whenLoaded(() => this.music?.handle(message));
      return;
    }
    switch (message.t) {
      case "hello":
      case "look":
        this.setLook(message.name, message.look);
        break;
      case "speak": {
        const { t: _t, ...line } = message;
        this.speaker.speak(line);
        break;
      }
      case "prefetch":
        this.audio.prefetch(message.audioUrl);
        break;
      case "stop":
        this.speaker.stop();
        this.text.caption.hide();
        break;
      case "alert": {
        const { kind, name } = message;
        this.text.alerts.push(kind, name, alertDetail(message), this.time, this.scale);
        if (kind === "gift") this.character.face.lookAt(0.7, -0.4, this.time + 2.2);
        else this.character.kick(-4);
        this.whenLoaded(() => this.fx?.alert(kind, name, message.giftName ?? "", message.diamonds ?? 0, this.time));
        break;
      }
      case "segment":
        this.text.chrome.setTitle(message.title, this.scale);
        break;
      case "stats": {
        // Likes since the last update float up as hearts (not the backlog on connect).
        const delta = this.likes < 0 ? 0 : message.likes - this.likes;
        this.likes = message.likes;
        if (delta > 0) this.whenLoaded(() => this.fx?.likes(delta, this.time));
        break;
      }
      case "fx":
        this.play(message.fx, message.intensity ?? 1);
        break;
      case "boost": {
        const { boost, by } = message;
        this.whenLoaded(() => this.fx?.boost(boost, by, this.time));
        break;
      }
      case "vote":
        this.text.card.setVote(message.vote, this.time, this.scale);
        break;
      case "support":
        this.text.card.setSupport(message.card, this.time, this.scale);
        break;
      case "schedule":
        this.text.upNext.set(message.items, this.time, this.scale);
        break;
      case "leaders":
        this.text.card.set(message.board, message.rows, message.windowMin, this.time, this.scale);
        break;
      case "game": {
        const { scene } = message;
        this.gameMix.target = scene ? 1 : 0;
        if (scene || this.game) this.whenLoaded(() => this.game?.set(scene, this.time, this.scale));
        break;
      }
      case "hold":
        break;
    }
  }

  setLook(name: string, look: Look): void {
    const nameChanged = name !== this.name;
    this.name = name;
    this.look = look;
    this.colors.setTarget([...hexToRgb(look.primary), ...hexToRgb(look.secondary), ...hexToRgb(look.background)]);
    this.character.style.target = look.character === "orb" ? 1 : 0;
    this.text.setGlow(look.primary, this.scale);
    this.text.setColors(look.primary, look.secondary, this.scale);
    if (nameChanged) this.text.chrome.setBadge(disclosureText(name), this.scale);
  }

  /** The current look (for editors that need to diff). */
  get currentLook(): Look {
    return this.look;
  }

  /** Makes the character react without speaking (editor previews). */
  setEmotion(emotion: Emotion, holdSeconds = 2.5): void {
    this.character.setEmotion(emotion, this.time, holdSeconds);
  }

  /** Plays a reaction: particles, a character move, the spotlight or rain. */
  play(effect: Effect, intensity = 1): void {
    this.whenLoaded(() => this.fx?.play(effect, intensity, this.time));
  }

  /** Resolves once effects and game scenes are loaded (tests render after it). */
  ready(): Promise<void> {
    this.extras ??= Promise.all([import("./stage/fx"), import("./game/scene"), import("./audio/music")]).then(
      ([fx, game, music]) => {
        if (this.destroyed) return;
        this.music = new music.MusicPlayer(this.audio);
        this.fx = new fx.FxLayer(this.ctx, this.character, this.music, this.random);
        this.game = new game.GameLayer(this.ctx);
        this.stack();
        this.fx.repaint(this.scale);
        const waiting = this.waiting;
        this.waiting = [];
        for (const run of waiting) run();
      },
      (err: unknown) => {
        this.error ??= `extras: ${String(err)}`.slice(0, 480);
        this.waiting = [];
        this.events.emit("telemetry", this.telemetry());
      },
    );
    return this.extras;
  }

  /** Renders one frame at time `t` seconds (manual clock, for tests and thumbnails). */
  renderAt(t: number): void {
    this.capture?.poll();
    while (this.time < t - 1e-6) {
      const dt = Math.min(1 / 60, t - this.time);
      this.time += dt;
      this.update(dt);
    }
    this.draw();
    this.capture?.afterDraw();
  }

  startCapture(options: CaptureOptions): () => void {
    if (this.capture) throw new Error("This engine is already capturing");
    const luma = this.gl.program("yuv-luma", FULLSCREEN_VERTEX, YUV_LUMA_FRAGMENT);
    const chroma = this.gl.program("yuv-chroma", FULLSCREEN_VERTEX, YUV_CHROMA_FRAGMENT);
    const capture = new FrameCapture(this.gl, { luma, chroma, quad: this.quad }, options);
    this.capture = capture;
    this.output = capture.frame;
    this.layout();
    return () => {
      if (this.capture !== capture) return;
      capture.dispose();
      this.gl.untrack(luma);
      this.gl.untrack(chroma);
      this.capture = null;
      this.output = null;
      this.layout();
    };
  }

  captureStats(): CaptureStats | null {
    return this.capture?.counters ?? null;
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
    this.layout();
    // A resized canvas is cleared; redraw now so there's never a blank frame.
    if (changed && !this.running && this.text) this.draw();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    for (const off of this.observers) off();
    this.speaker.stop();
    this.music?.destroy();
    this.audio.destroy();
    this.events.clear();
  }

  // ---- layers -----------------------------------------------------------------

  private stack(): void {
    const { atmosphere, character, text, fx, game } = this;
    this.updates = [character];
    if (fx) this.updates.push(fx.behind, fx.ahead);
    if (game) this.updates.push(game);
    this.updates.push(atmosphere, text);
    this.layers = [atmosphere];
    if (fx) this.layers.push(fx.behind);
    this.layers.push(character);
    if (game) this.layers.push(game);
    if (fx) this.layers.push(fx.ahead);
    this.layers.push(text);
  }

  /** Runs now if effects and games are loaded, otherwise once they are. */
  private whenLoaded(run: () => void): void {
    if (this.fx || this.destroyed) run();
    else {
      this.waiting.push(run);
      void this.ready();
    }
  }

  private tryProgram(name: string, vertex: string, fragment: string): Program | null {
    try {
      return this.gl.program(name, vertex, fragment);
    } catch (err) {
      this.error ??= (err instanceof ShaderError ? err.message : String(err)).slice(0, 480);
      return null;
    }
  }

  /** The size frames are drawn at: the canvas, or the capture target while capturing. */
  private get outputWidth(): number {
    return this.output?.width ?? this.canvas.width;
  }

  private get outputHeight(): number {
    return this.output?.height ?? this.canvas.height;
  }

  /** Sizes what follows the output: the reduced-resolution atmosphere and the text scale. */
  private layout(): void {
    const width = this.outputWidth;
    this.atmosphere?.resize(width, this.outputHeight);
    const nextScale = Math.max(0.25, Math.min(2, width / STAGE_WIDTH));
    if (Math.abs(nextScale - this.scale) > 0.01) {
      this.scale = nextScale;
      this.repaintText();
    }
  }

  /** Binds the output (canvas or capture target) as the draw target. */
  private bindOutput(): void {
    const gl = this.gl.gl;
    if (this.output) this.output.bindForDrawing();
    else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
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
      this.capture?.poll();
      const dt = Math.min(0.05, interval / 1000);
      this.time += dt;
      this.update(dt);
      this.draw();
      this.capture?.afterDraw();
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
    const f = this.frame;
    f.t = this.time;
    f.scale = this.scale;
    f.moteFraction = this.governor.settings.moteFraction;
    f.speaking = this.speaker.current !== null;
    f.amplitude += (this.audio.amplitude() - f.amplitude) * Math.min(1, dt * 20);
    this.colors.step(dt);
    this.gameMix.step(dt);
    f.game = Math.max(0, Math.min(1, this.gameMix.value));
    // The character keeps the host's colors; the water takes on the game's.
    const game = this.game;
    const tint = game ? f.game * GAME_TINT : 0;
    for (let i = 0; i < 3; i++) {
      const p = this.colors.get(i);
      const s = this.colors.get(3 + i);
      const b = this.colors.get(6 + i);
      f.hostPrimary[i] = p;
      f.hostSecondary[i] = s;
      f.primary[i] = game ? p + (game.colors.get(i) - p) * tint : p;
      f.secondary[i] = game ? s + (game.colors.get(3 + i) - s) * tint : s;
      f.background[i] = game ? b + (game.colors.get(6 + i) - b) * tint : b;
    }
    const updates = this.updates;
    for (let i = 0; i < updates.length; i++) (updates[i] as Layer).update(dt, f);
  }

  private draw(): void {
    if (this.gl.lost || !this.atmosphere.ready) return;
    const layers = this.layers;
    for (let i = 0; i < layers.length; i++) (layers[i] as Layer).draw(this.frame);
  }

  private readonly drawSprite = (sprite: TextSprite): void => {
    if (!this.sprite || !sprite.visible()) return;
    const opacity = Math.max(0, Math.min(1, sprite.opacity.value));
    const settled = sprite.mix <= 0.001 || sprite.mix >= 0.999;
    // Outside a cross-fade only one texture shows: sample just that one.
    if (settled && this.spriteSingle) {
      sprite.textures[sprite.mix >= 0.999 ? 1 : 0].bind(0);
      this.spriteSingle
        .use()
        .v2("u_res", STAGE_WIDTH, STAGE_HEIGHT)
        .v4("u_rect", sprite.x, sprite.y + sprite.offsetY.value, sprite.width, sprite.height)
        .i("u_tex", 0)
        .f("u_opacity", opacity);
      this.quad.draw();
      return;
    }
    sprite.textures[0].bind(0);
    sprite.textures[1].bind(1);
    this.sprite
      .use()
      .v2("u_res", STAGE_WIDTH, STAGE_HEIGHT)
      .v4("u_rect", sprite.x, sprite.y + sprite.offsetY.value, sprite.width, sprite.height)
      .i("u_tex", 0)
      .i("u_tex2", 1)
      .f("u_mix", sprite.mix)
      .f("u_opacity", opacity);
    this.quad.draw();
  };

  // ---- setup ------------------------------------------------------------------

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

  /** Text is rasterized once per content and scale; context loss and new fonts need it again. */
  private repaintText(): void {
    const layers = this.layers;
    for (let i = 0; i < layers.length; i++) layers[i]?.repaint?.(this.scale);
  }
}

/** The highlighted end of an alert: "<name> enviou Rose ×5", "<name> começou a seguir". */
export function alertDetail(message: Extract<StageServerPayload, { t: "alert" }>): string {
  if (message.kind === "gift") {
    // TikTok's own convention: the gift's name (as TikTok sends it), then the combo count.
    const count = message.count ?? 1;
    return `${message.giftName || "um presente"}${count > 1 ? ` ×${count}` : ""}`;
  }
  return message.kind === "follow" ? "começou a seguir" : "compartilhou a live";
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
  private name = "O apresentador";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: EngineOptions,
  ) {
    this.mode = options.mode;
    this.audio = new AudioEngine({
      muted: options.muted ?? options.mode === "preview",
      ...(options.mode === "broadcast" ? { sampleRate: BROADCAST_SAMPLE_RATE } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.speaker = new Speaker(this.audio, this.mode, this.events);
    this.ctx = canvas.getContext("2d");
    this.resize();
    queueMicrotask(() => this.events.emit("telemetry", this.telemetry()));
  }

  apply(message: StageServerPayload): void {
    if (message.t === "speak") {
      const { t: _t, ...line } = message;
      this.speaker.speak(line);
    }
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
    // OBS's own pt-BR menu names, so the creator can follow them as written.
    ctx.fillText(`${this.name} ainda não aparece aqui`, w / 2, h / 2 - 20, w - 48);
    ctx.fillStyle = "#A397D6";
    ctx.font = `500 17px ${FONT_FAMILY}`;
    ctx.fillText("Ative a aceleração de hardware no OBS:", w / 2, h / 2 + 18, w - 48);
    ctx.fillText("Configurações > Avançado > Fontes", w / 2, h / 2 + 42, w - 48);
  }
}
