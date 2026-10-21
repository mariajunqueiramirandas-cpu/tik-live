import { createEngine, startDemo, type StageEngine } from "@tik-live/engine";
import { EFFECTS, EMOTIONS, MUSIC_LIBRARY, musicTrackSchema, SOUNDS, type Challenge, type Effect, type Emotion, type GameScene, type Look, type PerksCard, type Sound, type StageServerPayload, type Ticker } from "@tik-live/shared";
import "../stage/stage.css";
import { HUD, SCENES, tick } from "./samples";

/**
 * Dev and test harness for the engine (not part of the production build).
 * `?clock=manual` renders deterministic frames for screenshot tests through
 * `window.__lab`; `?demo` plays the scripted show. Also:
 * `?scene=trivia|trivia-reveal|poll|...` (see samples.ts), `?fx=confetti`,
 * `?gift=galaxy`, `?emotion=shy`, `?music=lofi-night`, `?caption=0` (no
 * sample caption with scenes), `?hud` (up next and the kings), `?support`
 * (the "apoie a live" card), `?goals` (the stream's goals), `?hook` (the call
 * to people scrolling past), `?perks` (the gift showcase), `?ticker` (the
 * always-on support ticker), `?boss` (the "dono
 * da live"), `?pick` (one viewer's choice), `?challenge=likes|chat|raffle|
 * likes-won|likes-lost|raffle-won` (a challenge or the raffle), `?bare` (no
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

/** The gift powers on offer (ADR-0039). */
const PERKS: PerksCard = {
  title: "O que seu presente faz",
  rows: [
    { diamonds: 5, text: "fura-fila no chat" },
    { diamonds: 30, text: "escolhe o próximo jogo" },
    { diamonds: 99, text: "ganha um hino da IA" },
    { diamonds: 199, text: "dono da live por 5 min" },
  ],
  every: "Todo presente: seu nome na live + Top Doadores",
};

/** The always-on support ticker (ADR-0041), as a channel with gift powers sends it. */
const TICKER: Ticker = {
  title: "APOIE A LIVE",
  lines: [
    { way: "gift", text: "Presentes pagam as contas da IA" },
    { way: "like", text: "Toque na tela pra curtir" },
    { way: "gift", text: "Todo presente: seu nome na live" },
    { way: "follow", text: "Siga pra não perder a próxima" },
    { way: "gift", text: "fura-fila no chat", diamonds: 5 },
    { way: "share", text: "Compartilhe com um amigo" },
    { way: "gift", text: "escolhe o próximo jogo", diamonds: 30 },
    { way: "gift", text: "ganha um hino da IA", diamonds: 99 },
    { way: "gift", text: "dono da live por 5 min", diamonds: 199 },
  ],
};

/** Sample challenges by name (ADR-0040): running, won and lost. */
const CHALLENGES: Record<string, Challenge> = {
  likes: { kind: "likes", title: "DESAFIO DAS CURTIDAS", detail: "toque na tela", value: 640, target: 1_000, remainingMs: 32_000, durationMs: 45_000, result: null, winner: null },
  "likes-won": { kind: "likes", title: "DESAFIO DAS CURTIDAS", detail: "toque na tela", value: 1_084, target: 1_000, remainingMs: 0, durationMs: 45_000, result: "won", winner: null },
  "likes-lost": { kind: "likes", title: "DESAFIO DAS CURTIDAS", detail: "toque na tela", value: 812, target: 1_000, remainingMs: 0, durationMs: 45_000, result: "lost", winner: null },
  chat: { kind: "chat", title: "CHUVA DE COMENTÁRIOS", detail: "digite BORA", value: 37, target: 80, remainingMs: 21_000, durationMs: 30_000, result: null, winner: null },
  raffle: { kind: "raffle", title: "SORTEIO RELÂMPAGO", detail: "digite EU", value: 23, target: 0, remainingMs: 18_000, durationMs: 25_000, result: null, winner: null },
  "raffle-won": { kind: "raffle", title: "SORTEIO RELÂMPAGO", detail: "digite EU", value: 41, target: 0, remainingMs: 0, durationMs: 25_000, result: "won", winner: "lu.desenha" },
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
  /** Shows (or with false, hides) the "how to support the show" card. */
  support: (on = true) => engine.apply(on ? HUD.support : { t: "support", card: null }),
  /** Shows (or with false, hides) the stream's goals. */
  goals: (on = true) => engine.apply(on ? HUD.goals : { t: "goals", goals: [] }),
  /** Shows (or with false, takes down) the call to people scrolling past. */
  hook: (on = true) => engine.apply({ t: "hook", text: on ? "Comenta seu nome e ganha um apelido" : null }),
  /** Shows (or with false, hides) the gift showcase: what each gift unlocks. */
  perks: (on = true) => engine.apply({ t: "perks", card: on ? PERKS : null }),
  /** Shows (or with false, hides) the always-on support ticker; `line` starts it on that line. */
  ticker(on = true, line = 0) {
    engine.apply({ t: "ticker", ticker: on ? { ...TICKER, lines: [...TICKER.lines.slice(line), ...TICKER.lines.slice(0, line)] } : null });
  },
  /** Crowns (or with null, uncrowns) the "dono da live" for five minutes. */
  boss: (name: string | null = "mari.souza", leftMs = 300_000) => engine.apply({ t: "boss", boss: name ? { name, leftMs } : null }),
  /** One viewer picks the next game (or with false, the card goes back to the rankings). */
  pick: (on = true) =>
    engine.apply({ t: "vote", vote: on ? { title: "Próximo jogo", options: ["Cabo de guerra", "Quiz", "Batata quente"], tally: [0, 0, 0], by: "mari.souza" } : null }),
  /** Shows a sample challenge by name (see CHALLENGES), or takes it down with null. */
  challenge: (name: string | null = "likes") => engine.apply({ t: "challenge", challenge: name ? (CHALLENGES[name] ?? null) : null }),
  /** The alerts for a new top gifter, a gift power and a raffle winner. */
  crown: (name = "caio") => engine.apply({ t: "alert", kind: "crown", name }),
  perkAlert: (name = "duda", perk = "Dono da live") => engine.apply({ t: "alert", kind: "perk", name, perk }),
  raffleWinner: (name = "lu.desenha") => engine.apply({ t: "alert", kind: "raffle", name }),
  /** A viewer reaching a new fan level. */
  levelUp: (name = "duda", level = 7) => engine.apply({ t: "alert", kind: "level", name, level }),
  /** Reaches the like goal: the bar celebrates, then the next goal comes up. */
  reachGoal: () =>
    engine.apply({
      t: "goals",
      goals: [
        { kind: "likes", value: 5_020, target: 10_000, level: 3 },
        { kind: "gifts", value: 120, target: 500, level: 1 },
      ],
    }),
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
if (params.has("support")) lab.support();
if (params.has("goals")) lab.goals();
if (params.has("hook")) lab.hook();
if (params.has("perks")) lab.perks();
if (params.has("ticker")) lab.ticker(true, Number(params.get("ticker")) || 0);
if (params.has("boss")) lab.boss();
if (params.has("pick")) lab.pick();
const challenge = params.get("challenge");
if (challenge !== null) lab.challenge(challenge || "likes");

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
  group("Seguir, compartilhar, curtidas", ["follow", "share", "nível de fã", "likes +25"], (k) => {
    if (k === "follow" || k === "share") engine.apply({ t: "alert", kind: k, name: "lu.desenha" });
    else if (k === "nível de fã") lab.levelUp();
    else {
      likes += 25;
      engine.apply({ t: "stats", viewers: 120, likes });
    }
  });
  group("Jogos", ["(none)", ...Object.keys(SCENES)], (s) => lab.scene(s === "(none)" ? null : s));
  group("Painéis", ["a seguir e curtidas", "apoie a live", "faixa de apoio", "metas", "bater a meta", "chamada", "esconder"], (k) => {
    if (k === "apoie a live") lab.support();
    else if (k === "faixa de apoio") lab.ticker();
    else if (k === "chamada") lab.hook();
    else if (k === "metas") lab.goals();
    else if (k === "bater a meta") lab.reachGoal();
    else {
      if (k === "esconder") {
        lab.goals(false);
        lab.hook(false);
        lab.ticker(false);
      }
      lab.support(false);
      lab.hud(k !== "esconder");
    }
  });
  group("Poderes do presente", ["cardápio", "dono da live", "fim do reinado", "escolha de um", "novo topo", "poder desbloqueado", "esconder cardápio"], (k) => {
    if (k === "cardápio") lab.perks();
    else if (k === "esconder cardápio") lab.perks(false);
    else if (k === "dono da live") lab.boss();
    else if (k === "fim do reinado") lab.boss(null);
    else if (k === "escolha de um") lab.pick();
    else if (k === "novo topo") lab.crown();
    else lab.perkAlert();
  });
  group("Desafios e sorteio", [...Object.keys(CHALLENGES), "ganhador do sorteio", "tirar"], (k) => {
    if (k === "tirar") lab.challenge(null);
    else if (k === "ganhador do sorteio") lab.raffleWinner();
    else lab.challenge(k);
  });
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
