import type { GameScene, StageServerPayload } from "@tik-live/shared";

/**
 * Sample game scenes for the engine lab (`/lab.html?scene=trivia`), with
 * long Portuguese text where wrapping matters. Each open round has 20 s of
 * a 30 s timer left when it's applied.
 */
const open = { round: 2, rounds: 5, phase: "open" as const, remainingMs: 20_000, durationMs: 30_000 };
const reveal = { round: 2, rounds: 5, phase: "reveal" as const, remainingMs: 0, durationMs: 30_000 };

export const SCENES: Record<string, GameScene> = {
  trivia: {
    kind: "trivia",
    ...open,
    question: "Qual é o maior planeta do sistema solar?",
    options: ["Saturno", "Júpiter, o gigante gasoso com a Grande Mancha Vermelha", "Netuno", "Terra"],
    answers: 37,
    tally: null,
    correct: null,
    winners: [],
  },
  "trivia-reveal": {
    kind: "trivia",
    ...reveal,
    question: "Qual é o maior planeta do sistema solar?",
    options: ["Saturno", "Júpiter, o gigante gasoso com a Grande Mancha Vermelha", "Netuno", "Terra"],
    answers: 52,
    tally: [9, 31, 7, 5],
    correct: 1,
    winners: ["mari.souza", "lu.desenha", "thiago_k", "duda", "joão.pedro"],
  },
  poll: {
    kind: "poll",
    ...open,
    question: "Pizza com abacaxi: sim ou não?",
    options: ["Sim, doce e salgado combinam", "Nunca, isso é um crime"],
    tally: [42, 58],
  },
  "poll-reveal": {
    kind: "poll",
    ...reveal,
    question: "Pizza com abacaxi: sim ou não?",
    options: ["Sim, doce e salgado combinam", "Nunca, isso é um crime"],
    tally: [61, 87],
  },
  poll4: {
    kind: "poll",
    ...open,
    question: "Qual é o melhor lanche da madrugada?",
    options: ["Pão de queijo", "Miojo com ovo", "Brigadeiro de panela", "Pizza fria de ontem"],
    tally: [18, 25, 31, 9],
  },
  scramble: {
    kind: "scramble",
    ...open,
    letters: "AIBACAX",
    hint: "Fruta tropical com coroa",
    guesses: 14,
    word: null,
    winner: null,
  },
  "scramble-reveal": {
    kind: "scramble",
    ...reveal,
    letters: "AIBACAX",
    hint: "Fruta tropical com coroa",
    guesses: 23,
    word: "ABACAXI",
    winner: "lu.desenha",
  },
  number: {
    kind: "number",
    ...open,
    min: 1,
    max: 100,
    low: 23,
    high: 61,
    guesses: 9,
    last: { name: "mari.souza", value: 61, hint: "lower" },
    answer: null,
    winner: null,
  },
  "number-reveal": {
    kind: "number",
    ...reveal,
    min: 1,
    max: 100,
    low: 42,
    high: 42,
    guesses: 17,
    last: { name: "thiago_k", value: 42, hint: "exact" },
    answer: 42,
    winner: "thiago_k",
  },
  truefalse: {
    kind: "truefalse",
    ...open,
    statement: "O polvo tem três corações e sangue azul.",
    answers: 64,
    tally: null,
    correct: null,
    winners: [],
  },
  "truefalse-reveal": {
    kind: "truefalse",
    ...reveal,
    statement: "O polvo tem três corações e sangue azul.",
    answers: 88,
    tally: [61, 27],
    correct: true,
    winners: ["duda", "marina.v", "caio"],
  },
  math: { kind: "math", ...open, expression: "7 × 8 + 3", guesses: 21, answer: null, winner: null },
  "math-reveal": { kind: "math", ...reveal, expression: "7 × 8 + 3", guesses: 34, answer: 59, winner: "caio" },
  riddle: {
    kind: "riddle",
    ...open,
    riddle: "Quanto mais você tira de mim, maior eu fico. O que eu sou?",
    hint: "Você cava para me fazer",
    guesses: 12,
    answer: null,
    winner: null,
  },
  "riddle-reveal": {
    kind: "riddle",
    ...reveal,
    riddle: "Quanto mais você tira de mim, maior eu fico. O que eu sou?",
    hint: "Você cava para me fazer",
    guesses: 30,
    answer: "Um buraco",
    winner: "marina.v",
  },
  fastest: { kind: "fastest", ...open, remainingMs: 9_500, durationMs: 12_000, word: "PARALELEPÍPEDO", winner: null, winnerMs: null },
  "fastest-reveal": { kind: "fastest", ...reveal, word: "PARALELEPÍPEDO", winner: "lucas", winnerMs: 1420 },
  tug: {
    kind: "tug",
    ...open,
    remainingMs: 28_000,
    durationMs: 40_000,
    teams: [
      { name: "Time Coxinha", members: 18, pulls: 1_240 },
      { name: "Time Pastel de Feira", members: 23, pulls: 980 },
    ],
    rope: -0.21,
    winner: null,
    mvp: null,
  },
  "tug-reveal": {
    kind: "tug",
    ...reveal,
    durationMs: 40_000,
    teams: [
      { name: "Time Coxinha", members: 21, pulls: 3_410 },
      { name: "Time Pastel de Feira", members: 25, pulls: 2_655 },
    ],
    rope: -0.63,
    winner: 0,
    mvp: "lu.desenha",
  },
  potato: {
    kind: "potato",
    ...open,
    remainingMs: 0,
    durationMs: 0,
    holder: "joão.pedro.silva",
    heldMs: 4_200,
    heat: 0.55,
    grabs: 31,
    leaders: [
      { name: "duda", seconds: 14 },
      { name: "mari.souza", seconds: 9 },
      { name: "caio", seconds: 6 },
    ],
    exploded: null,
  },
  "potato-boom": {
    kind: "potato",
    ...reveal,
    durationMs: 0,
    holder: "joão.pedro.silva",
    heldMs: 0,
    heat: 1,
    grabs: 44,
    leaders: [
      { name: "duda", seconds: 14 },
      { name: "mari.souza", seconds: 11 },
      { name: "caio", seconds: 6 },
    ],
    exploded: { name: "joão.pedro.silva", lost: 18 },
  },
  scoreboard: {
    kind: "scoreboard",
    title: "Placar final",
    rows: [
      { name: "mari.souza", points: 420 },
      { name: "lu.desenha", points: 380 },
      { name: "thiago_k", points: 255 },
      { name: "duda", points: 140 },
      { name: "joão.pedro.silva", points: 90 },
    ],
  },
  /** The loop's podium, before anyone is revealed: the drumroll for third place. */
  podium: { kind: "podium", title: "Pódio geral", places: [null, null, null], suspense: 3 },
  "podium-reveal": {
    kind: "podium",
    title: "Pódio geral",
    places: [
      { name: "mari.souza", points: 1240 },
      { name: "lu.desenha", points: 985 },
      { name: "joão.pedro.silva", points: 610 },
    ],
    suspense: null,
  },
};

/** The heads-up panels: what's up next, and the top likers of the last 15 minutes. */
export const HUD: { schedule: StageServerPayload; likes: StageServerPayload; gifts: StageServerPayload; support: StageServerPayload; goals: StageServerPayload } = {
  goals: {
    t: "goals",
    goals: [
      { kind: "likes", value: 3_240, target: 5_000, level: 2 },
      { kind: "gifts", value: 120, target: 500, level: 1 },
    ],
  },
  support: {
    t: "support",
    card: {
      title: "Blip é uma IA ao vivo",
      lines: [
        { way: "like", text: "Curta a live" },
        { way: "follow", text: "Siga para não perder" },
        { way: "share", text: "Compartilhe com amigos" },
        { way: "gift", text: "Presentes pagam as contas da IA" },
      ],
    },
  },
  schedule: {
    t: "schedule",
    items: [
      { kind: "game", title: "Quiz: futebol", inMs: 154_000 },
      { kind: "segment", title: "Papo da madrugada", inMs: 600_000 },
    ],
  },
  likes: {
    t: "leaders",
    board: "likes",
    windowMin: 15,
    rows: [
      { name: "mari.souza", value: 1834 },
      { name: "thiago_k", value: 960 },
      { name: "joão.pedro.silva.oficial", value: 412 },
    ],
  },
  gifts: {
    t: "leaders",
    board: "gifts",
    windowMin: 60,
    rows: [
      { name: "duda", value: 25_300 },
      { name: "lu.desenha", value: 1_200 },
      { name: "caio", value: 99 },
    ],
  },
};

/**
 * Live-ish changes for a human to eyeball animation (not in manual-clock
 * mode): returns the next version of a scene, or null to leave it.
 */
export function tick(scene: GameScene, step: number, random: () => number): GameScene | null {
  switch (scene.kind) {
    case "poll":
      if (scene.phase !== "open") return null;
      return { ...scene, remainingMs: Math.max(0, 20_000 - step * 250), tally: scene.tally.map((n, i) => n + Math.floor(random() * (i + 2))) };
    case "trivia":
    case "truefalse":
      if (scene.phase !== "open") return null;
      return { ...scene, remainingMs: Math.max(0, 20_000 - step * 250), answers: scene.answers + Math.floor(random() * 3) };
    case "number": {
      if (scene.phase !== "open" || scene.low >= scene.high) return null;
      if (step % 6) return null;
      const value = scene.low + Math.floor(random() * (scene.high - scene.low + 1));
      const secret = 42;
      const hint = value === secret ? "exact" : value < secret ? "higher" : "lower";
      return {
        ...scene,
        remainingMs: Math.max(0, 20_000 - step * 250),
        guesses: scene.guesses + 1,
        low: hint === "higher" ? value + 1 : hint === "exact" ? value : scene.low,
        high: hint === "lower" ? value - 1 : hint === "exact" ? value : scene.high,
        last: { name: ["ana", "bia", "caio", "duda"][step % 4] as string, value, hint },
      };
    }
    case "scramble":
    case "math":
    case "riddle":
      if (scene.phase !== "open" || step % 4) return null;
      return { ...scene, remainingMs: Math.max(0, 20_000 - step * 250), guesses: scene.guesses + 1 };
    case "tug":
      if (scene.phase !== "open") return null;
      return { ...scene, remainingMs: Math.max(0, 28_000 - step * 250), rope: Math.max(-1, Math.min(1, scene.rope + (random() - 0.5) * 0.08)), teams: scene.teams.map((team) => ({ ...team, pulls: team.pulls + Math.floor(random() * 9) })) };
    case "potato":
      if (scene.phase !== "open") return null;
      return step % 4 ? null : { ...scene, heat: Math.min(1, scene.heat + 0.01), grabs: scene.grabs + (step % 20 === 0 ? 1 : 0) };
    default:
      return null;
  }
}
