import type { GameScene } from "@tik-live/shared";

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
    default:
      return null;
  }
}
