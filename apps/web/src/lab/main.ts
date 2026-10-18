import { createEngine, startDemo, type StageEngine } from "@tik-live/engine";
import { EFFECTS, EMOTIONS, MUSIC_LIBRARY, musicTrackSchema, SOUNDS, type Effect, type Emotion, type GameScene, type Look, type Sound, type StageServerPayload } from "@tik-live/shared";
import "../stage/stage.css";
import { HUD, SCENES, tick } from "./samples";

/**
 * Dev and test harness for the engine (not part of the production build).
 * `?clock=manual` renders deterministic frames for screenshot tests through
 * `window.__lab`; `?demo` plays the scripted show. Also:
 * `?scene=trivia|trivia-reveal|poll|...` (see samples.ts), `?fx=confetti`,
 * `?gift=galaxy`, `?emotion=shy`, `?music=lofi-night`, `?caption=0` (no
 * sample caption with scenes), `?hud` (up next and top likers), `?bare` (no
 * control panel).
 */
const params = new URLSearchParams(location.search);
const manual = params.get("clock") === "manual";
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const engine: StageEngine = createEngine(canvas, {
  mode: params.has("demo") ? "demo" : "program",
  manualClock: manual,
  seed: 7,
  quality: "high",
  muted: !params.has("sound"),
});

/** Gift presets by tier (diamonds as TikTok counts them), some with a flavor. */
const GIFTS: Record<string, { giftName: string; diamonds: number }> = {
  rose: { giftName: "Rose", diamonds: 1 },
  doughnut: { giftName: "Doughnut", diamonds: 30 },
  "heart-me": { giftName: "Heart Me", diamonds: 50 },
  perfume: { giftName: "Perfume", diamonds: 200 },
  rocket: { giftName: "Rocket", diamonds: 500 },
  galaxy: { giftName: "Galaxy", diamonds: 1000 },
  lion: { giftName: "Lion", diamonds: 29_999 },
};

const ready = () => ("ready" in engine ? (engine as unknown as { ready(): Promise<void> }).ready() : Promise.resolve());
let live: ReturnType<typeof setInterval> | null = null;
let likes = 1000;

const lab = {
  engine,
  emotions: EMOTIONS,
  effects: EFFECTS,
  scenes: Object.keys(SCENES),
  gifts: Object.keys(GIFTS),
  apply: (message: StageServerPayload) => engine.apply(message),
  look: (name: string, look: Look) => engine.setLook(name, look),
  emotion: (emotion: Emotion, hold = 30) => engine.setEmotion(emotion, hold),
  frame: (t: number) => engine.renderAt(t),
  telemetry: () => engine.telemetry(),
  fontsReady: () => document.fonts.ready.then(() => document.fonts.load('720 64px "Bricolage Grotesque"')),
  /** Resolves when effects, game scenes and music have loaded. */
  ready,
  /** Shows a sample scene (null: back to the show). In live mode, it keeps changing. */
  scene(name: string | null) {
    if (live) clearInterval(live);
    live = null;
    const scene: GameScene | null = name ? (SCENES[name] ?? null) : null;
    engine.apply({ t: "game", scene });
    if (!scene || manual) return;
    let current = scene;
    let step = 0;
    live = setInterval(() => {
      const next = tick(current, ++step, Math.random);
      if (next) engine.apply({ t: "game", scene: (current = next) });
    }, 250);
  },
  fx: (fx: Effect, intensity = 1) => engine.apply({ t: "fx", fx, intensity }),
  gift(name: string, from = "duda") {
    const gift = GIFTS[name] ?? GIFTS.rose!;
    engine.apply({ t: "alert", kind: "gift", name: from, giftName: gift.giftName, count: 1, diamonds: gift.diamonds });
  },
  music: (id: string | null) => engine.apply({ t: "music", track: id && MUSIC_LIBRARY[id] ? musicTrackSchema.parse(MUSIC_LIBRARY[id]) : null }),
  sfx: (sound: Sound) => engine.apply({ t: "sfx", sound }),
  /** Shows (or with false, hides) the up-next pill and the ranking card; "gifts" shows only the gift ranking. */
  hud(on: boolean | "gifts" = true) {
    engine.apply(on ? HUD.schedule : { t: "schedule", items: [] });
    engine.apply(on === true ? HUD.likes : { t: "leaders", board: "likes", windowMin: 15, rows: [] });
    engine.apply(on ? HUD.gifts : { t: "leaders", board: "gifts", windowMin: 60, rows: [] });
  },
  caption(text: string) {
    engine.apply({ t: "speak", id: `lab-${Date.now()}`, text, emotion: "happy", audioUrl: null, durationMs: 2600 });
  },
  loseContext() {
    const gl = canvas.getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_lose_context");
    ext?.loseContext();
    return ext;
  },
};
(window as unknown as { __lab: typeof lab }).__lab = lab;

if (params.has("demo")) startDemo(engine);

const scene = params.get("scene");
if (scene) {
  engine.apply({ t: "segment", title: "Hora do jogo" });
  lab.scene(scene);
  if (params.get("caption") !== "0") void ready().then(() => lab.caption("Valendo! Quem acertar primeiro ganha pontos em dobro nesta rodada."));
}
const fx = params.get("fx");
if (fx && (EFFECTS as readonly string[]).includes(fx)) void ready().then(() => lab.fx(fx as Effect, Number(params.get("intensity")) || 1));
const gift = params.get("gift");
if (gift) lab.gift(gift);
const emotion = params.get("emotion");
if (emotion && (EMOTIONS as readonly string[]).includes(emotion)) lab.emotion(emotion as Emotion);
const music = params.get("music");
if (music) lab.music(music);
if (params.has("hud")) lab.hud();

if (!manual && !params.has("bare")) panel();

/** Buttons for a human: every emotion, effect, gift tier, scene, piece of music and sound. */
function panel(): void {
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;left:8px;top:8px;bottom:8px;width:min(300px,40vw);overflow:auto;padding:8px;background:rgb(12 6 34/0.85);border:1px solid #3a2d6b;border-radius:10px;font:600 12px/1.2 system-ui;color:#f4f0ff;z-index:2";
  const group = (title: string, items: readonly string[], run: (item: string) => void) => {
    const heading = document.createElement("div");
    heading.textContent = title;
    heading.style.cssText = "margin:8px 0 4px;color:#a397d6";
    root.append(heading);
    for (const item of items) {
      const button = document.createElement("button");
      button.textContent = item;
      button.style.cssText = "margin:2px;padding:4px 6px;border-radius:6px;border:1px solid #4b3d85;background:#1e1247;color:inherit;font:inherit;cursor:pointer";
      button.addEventListener("click", () => run(item));
      root.append(button);
    }
  };
  group("Emoções", EMOTIONS, (e) => lab.emotion(e as Emotion, 4));
  group("Efeitos", EFFECTS, (e) => lab.fx(e as Effect));
  group("Presentes", Object.keys(GIFTS), (g) => lab.gift(g));
  group("Seguir, compartilhar, curtidas", ["follow", "share", "likes +25"], (k) => {
    if (k === "follow" || k === "share") engine.apply({ t: "alert", kind: k, name: "lu.desenha" });
    else {
      likes += 25;
      engine.apply({ t: "stats", viewers: 120, likes });
    }
  });
  group("Jogos", ["(none)", ...Object.keys(SCENES)], (s) => lab.scene(s === "(none)" ? null : s));
  group("Painéis", ["a seguir e curtidas", "esconder"], (k) => lab.hud(k !== "esconder"));
  group("Votação", ["abrir votação", "fechar votação"], (k) =>
    lab.apply({ t: "vote", vote: k === "abrir votação" ? { title: "Jogo do quadro final", options: ["Quiz", "Charadas", "Dedo mais rápido"], tally: [4, 1, 9] } : null }),
  );
  group("Poderes e combo", ["+10 segundos", "dica", "pontos em dobro", "combo de presentes"], (k) => {
    if (k === "combo de presentes") {
      let n = 0;
      const timer = setInterval(() => {
        lab.gift(n % 3 ? "rose" : "doughnut", ["duda", "caio", "bia"][n % 3]);
        if (++n >= 10) clearInterval(timer);
      }, 400);
    } else lab.apply({ t: "boost", boost: k === "dica" ? "hint" : k === "pontos em dobro" ? "double" : "time", by: "duda" });
  });
  group("Música", ["(stop)", ...Object.keys(MUSIC_LIBRARY)], (m) => lab.music(m === "(stop)" ? null : m));
  group("Sons", SOUNDS, (s) => lab.sfx(s as Sound));
  group("Voz", ["speak a line", "unmute"], (k) => {
    if (k === "unmute") {
      engine.audio.setMuted(false);
      void engine.audio.unlock();
    } else lab.caption("Chat, vocês estão prontos para a próxima rodada? Valendo!");
  });
  document.body.append(root);
  engine.apply({ t: "stats", viewers: 120, likes });
}
