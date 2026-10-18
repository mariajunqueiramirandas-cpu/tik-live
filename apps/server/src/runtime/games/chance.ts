import { normalize } from "./answers";
import { shuffle, type RoundContent } from "./content";

/**
 * Games of chance and parties (ADR-0038), made up in code: a race and a
 * wheel chat bets on, a tug of war, and a hot potato. Everything random is
 * drawn when the round is made, with the round's own random source, so a
 * round is the same however often it's looked at and tests can fix it.
 */

export type RaceContent = Extract<RoundContent, { kind: "race" }>;
export type WheelContent = Extract<RoundContent, { kind: "wheel" }>;
export type TugContent = Extract<RoundContent, { kind: "tug" }>;
export type PotatoContent = Extract<RoundContent, { kind: "potato" }>;

/** Racers' names: silly, easy to read out and to type. */
const RACERS = [
  "Pé de Pano", "Relâmpago", "Pangaré", "Tornado", "Faísca", "Trovão", "Pipoca", "Ventania",
  "Paçoca", "Furacão", "Cometa", "Sabugo", "Turbo", "Biscoito", "Muvuca", "Catapimba",
  "Rabo de Foguete", "Sem Freio", "Chuchu", "Tropeço",
];
/** Each racer's chance to win, shuffled among them every race. What a bet pays follows from it. */
const RACE_CHANCES = [0.32, 0.25, 0.19, 0.14, 0.1];
/** How long the winner takes to cross the line; the others come in behind. */
export const RACE_MS = 15_000;
const CHECKPOINTS = 8;
/** A bet on the winner pays this many points per unit of its multiplier. */
export const RACE_POINTS = 3;

/** What a racer with this chance pays: 1 in 3 pays ×3, a long shot ×10. */
export function raceOdds(chance: number): number {
  return Math.max(2, Math.round(1 / chance));
}

export function makeRace(random: () => number): RaceContent {
  const names = shuffle(RACERS, random).slice(0, RACE_CHANCES.length);
  const chances = shuffle(RACE_CHANCES, random);
  let roll = random();
  let winner = chances.length - 1;
  for (let i = 0; i < chances.length; i++) {
    roll -= chances[i] as number;
    if (roll < 0) {
      winner = i;
      break;
    }
  }
  const splits = names.map((_, i) => {
    const finish = i === winner ? RACE_MS : RACE_MS + 400 + random() * 2_600;
    // Uneven checkpoints make the lead change hands; a winner that starts slow comes from behind.
    const comeback = i === winner && random() < 0.6;
    const weights = Array.from({ length: CHECKPOINTS }, (_, k) => {
      const base = 0.6 + random() * 0.8;
      if (!comeback) return base;
      return k < CHECKPOINTS / 2 ? base * 1.35 : base * 0.7;
    });
    const total = weights.reduce((sum, w) => sum + w, 0);
    let at = 0;
    const splits = weights.map((w) => (at += (w / total) * finish));
    splits[splits.length - 1] = finish;
    return splits;
  });
  return { kind: "race", racers: names.map((name, i) => ({ name, odds: raceOdds(chances[i] as number) })), winner, splits };
}

/** How far along a racer is, 0 to 1, `elapsed` ms after the start. */
export function raceProgress(splits: readonly number[], elapsed: number): number {
  if (elapsed <= 0) return 0;
  let previous = 0;
  for (let k = 0; k < splits.length; k++) {
    const at = splits[k] as number;
    if (elapsed < at) return (k + (elapsed - previous) / Math.max(1, at - previous)) / splits.length;
    previous = at;
  }
  return 1;
}

/** The racer in front, `elapsed` ms after the start (the first one listed on a tie). */
export function raceLeader(content: RaceContent, elapsed: number): number {
  let best = 0;
  let lead = -1;
  content.splits.forEach((splits, i) => {
    const progress = raceProgress(splits, elapsed);
    if (progress > lead) {
      lead = progress;
      best = i;
    }
  });
  return best;
}

/**
 * The wheel's colors, how many of the strip's 20 tiles each one has, and
 * what a bet on it pays. Every tile is equally likely, so the odds are the
 * strip's own: nine blue tiles in twenty pay ×2, the one gold tile ×20.
 */
const WHEEL = [
  { label: "Azul", tiles: 9, odds: 2 },
  { label: "Verde", tiles: 6, odds: 3 },
  { label: "Roxo", tiles: 4, odds: 5 },
  { label: "Ouro", tiles: 1, odds: 20 },
] as const;
/** How long the strip spins. */
export const SPIN_MS = 6_500;
/** A right bet pays this many points per unit of its multiplier. */
export const WHEEL_POINTS = 4;

export function makeWheel(random: () => number): WheelContent {
  const tiles = WHEEL.flatMap((sector, index) => Array.from({ length: sector.tiles }, () => index));
  const strip = shuffle(tiles, random);
  return {
    kind: "wheel",
    sectors: WHEEL.map(({ label, odds }) => ({ label, odds })),
    strip,
    landing: Math.floor(random() * strip.length),
  };
}

export function wheelResult(content: WheelContent): number {
  return content.strip[content.landing] as number;
}

/** Things chat has strong feelings about, two sides each. */
const TEAMS: ReadonlyArray<[string, string]> = [
  ["Coxinha", "Pastel"],
  ["Biscoito", "Bolacha"],
  ["Gato", "Cachorro"],
  ["Praia", "Piscina"],
  ["Café", "Chá"],
  ["Doce", "Salgado"],
  ["Dia", "Noite"],
  ["Frio", "Calor"],
  ["Pizza", "Hambúrguer"],
  ["Funk", "Sertanejo"],
  ["Açaí", "Sorvete"],
  ["Pão de queijo", "Pão de batata"],
  ["Feijão por cima", "Feijão por baixo"],
  ["Time do banho de manhã", "Time do banho de noite"],
  ["Série", "Filme"],
  ["Inverno", "Verão"],
];
/** A right team's members each get this, and whoever pulled most for it gets as much again. */
export const TUG_POINTS = 10;
/** Pulls: one per like, a few for typing "puxa", and many per diamond (the gifter's team). */
export const PULL = { like: 1, message: 5, diamond: 10 };
/** Likes come in bursts; one event pulls at most this much, so a like bot can't win alone. */
export const PULL_LIKES_MAX = 30;

export function makeTug(random: () => number, played: (content: TugContent) => boolean = () => false): TugContent {
  const pairs = shuffle(TEAMS, random).map((pair): TugContent => ({ kind: "tug", teams: random() < 0.5 ? [pair[0], pair[1]] : [pair[1], pair[0]] }));
  return pairs.find((pair) => !played(pair)) ?? (pairs[0] as TugContent);
}

/** Where the rope is: -1 when team 1 pulled it all the way, 1 for team 2, 0 even. */
export function ropePosition(pulls: readonly [number, number]): number {
  const [a, b] = pulls;
  return Math.max(-1, Math.min(1, (b - a) / Math.max(20, a + b)));
}

/** The fuse is somewhere in here, and the board's heat climbs over the longest one. */
export const FUSE_MIN_MS = 25_000;
export const FUSE_MAX_MS = 60_000;
/** Whoever didn't blow up gets a point a second they held it, up to this many a round. */
export const POTATO_MAX_POINTS = 30;
/** A viewer who just grabbed waits this long to grab again (it's the others' turn). */
export const GRAB_COOLDOWN_MS = 3_000;

export function makePotato(random: () => number): PotatoContent {
  return { kind: "potato", fuseMs: Math.round(FUSE_MIN_MS + random() * (FUSE_MAX_MS - FUSE_MIN_MS)) };
}

// ---- reading chat -----------------------------------------------------------------

const PICK_WORDS = /^(?:(?:eu )?(?:aposto|apostei|vou|vai|bora|boto|voto|fico|entro|time|no|na|o|a|cavalo|corredor|cor|numero|n|equipe|team|de|do|da|com|pro|pra)\s+)*/;

/**
 * A pick from a numbered list: "2", "#2", "no 2", "aposto no 3", "time 1",
 * or an option's own name ("relâmpago", "time coxinha"). Undefined for
 * anything else, so ordinary chat stays chat.
 */
export function readPick(text: string, labels: readonly string[]): number | undefined {
  const plain = normalize(text);
  if (!plain || plain.split(" ").length > 5) return undefined;
  const rest = plain.replace(PICK_WORDS, "");
  if (/^[1-9]$/.test(rest)) {
    const index = Number(rest) - 1;
    return index < labels.length ? index : undefined;
  }
  const names = labels.map(normalize);
  const exact = names.indexOf(rest);
  if (exact !== -1) return exact;
  const index = names.findIndex((name) => name.length >= 4 && plain === `time ${name}`);
  return index === -1 ? undefined : index;
}

/** Repeated letters as one, so "PEGUEIII" reads as "peguei" (and "passa" as "pasa", both sides alike). */
function squash(text: string): string {
  return text.replace(/(\p{L})\1+/gu, "$1");
}

const GRABS = new Set(
  ["pega", "peguei", "pego", "pegar", "pegou", "minha", "eu", "eu pego", "batata", "quero", "me da", "passa", "passa pra mim", "da aqui", "e minha", "pega pega"].map(squash),
);

/** "pega", "PEGUEI!!", "é minha", "passa pra mim": grabbing the hot potato. */
export function readGrab(text: string): boolean {
  const plain = squash(normalize(text));
  if (!plain) return false;
  if (GRABS.has(plain)) return true;
  const words = plain.split(" ");
  return words.length <= 4 && (words[0] === "pega" || words[0] === "peguei" || plain.endsWith(" batata"));
}

/** "puxa", "PUXAAAA", "força time!", "vai vai": a pull in the tug of war. */
export function readPull(text: string): boolean {
  const plain = normalize(text);
  if (!plain || plain.split(" ").length > 4) return false;
  return /^(?:p+u+x+a+|p+u+x+e+m+|f+o+r+c+a+|v+a+i+|b+o+r+a+|v+a+m+o+s*)(?: |$)/.test(plain);
}
