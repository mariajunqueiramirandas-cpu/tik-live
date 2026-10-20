import { normalize } from "./answers";
import { shuffle, type RoundContent } from "./content";

/**
 * Party games (ADR-0038), made up in code: a tug of war and a hot potato.
 * Everything random is drawn when the round is made, with the round's own
 * random source, so a round is the same however often it's looked at and
 * tests can fix it.
 */

export type TugContent = Extract<RoundContent, { kind: "tug" }>;
export type PotatoContent = Extract<RoundContent, { kind: "potato" }>;

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

const PICK_WORDS = /^(?:(?:eu )?(?:vou|vai|bora|boto|voto|fico|entro|time|no|na|o|a|numero|n|equipe|team|de|do|da|com|pro|pra)\s+)*/;

/**
 * A pick from a numbered list: "2", "#2", "no 2", "voto no 3", "time 1",
 * or an option's own name ("coxinha", "time coxinha"). Undefined for
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
