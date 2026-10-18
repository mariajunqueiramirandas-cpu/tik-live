import { GAME_KINDS, type GameKind } from "./game";
import type { Persona, Segment } from "./persona";

/**
 * The automatic run of show (ADR-0035). With `persona.autoShow` on, the
 * director ignores the creator's segments and plans each loop itself: talk
 * segments and minigames in turn, drawn from the pools below, ending on a
 * game so the loop closes on its podium (and chat can vote on it). Every
 * loop is planned again, so a long stream doesn't repeat the same order.
 */

/** Segments in one automatic loop: talk and games in turn, the last one a game. */
export const AUTO_SHOW_SEGMENTS = 6;

/** Talk segments the automatic run of show draws from. Titles are shown on stage and in the studio. */
const TALK: ReadonlyArray<{ title: string; minutes: number; prompt: string }> = [
  {
    title: "Resenha",
    minutes: 8,
    prompt: "Converse com o chat do seu jeito: comente o que está rolando na live, puxe assunto com quem acabou de chegar e faça perguntas fáceis que dá pra responder com uma palavra.",
  },
  {
    title: "Opinião polêmica",
    minutes: 6,
    prompt: "Solte uma opinião boba e inofensiva (comida, bichos, dia a dia; nunca política, religião ou pessoas reais), defenda com humor e pergunte se o chat concorda.",
  },
  {
    title: "História do chat",
    minutes: 7,
    prompt: "Comece uma história curta e maluca em uma frase e peça para o chat continuar. Junte as melhores ideias, dê os créditos pelo nome e siga contando.",
  },
  {
    title: "Pergunte ao apresentador",
    minutes: 6,
    prompt: "Convide o chat a fazer qualquer pergunta sobre você, sua história ou suas manias. Quando ninguém perguntar, conte uma curiosidade sobre você mesmo.",
  },
  {
    title: "Top 3 do chat",
    minutes: 6,
    prompt: "Escolha um tema leve (lanche da madrugada, pior desenho da infância, melhor cheiro do mundo), peça o top 3 de cada um e monte o ranking da live com as respostas.",
  },
  {
    title: "Desafio relâmpago",
    minutes: 5,
    prompt: "Proponha desafios rápidos que dá pra fazer pelo chat: descrever o dia em três emojis, inventar um nome para algo, completar uma frase. Comente as respostas mais criativas.",
  },
  {
    title: "Conselhos duvidosos",
    minutes: 6,
    prompt: "Peça para o chat contar um probleminha do dia a dia e dê conselhos engraçados e exagerados, sempre leves e gentis. Nada de saúde, dinheiro ou assuntos sérios.",
  },
  {
    title: "Isso me lembra",
    minutes: 6,
    prompt: "Pegue uma palavra que alguém do chat escreveu e conte uma lembrança inventada e divertida sobre ela, do seu jeito. Depois peça outra palavra.",
  },
];

/** Between rounds of an automatic game, the host keeps the room playing. */
const GAME_PROMPT = "Entre as rodadas, anime quem está jogando, comemore quem acertou pelo nome e chame quem chegou agora para entrar no jogo.";

const GAME_MINUTES = 7;
const GAME_ROUNDS = 5;

/** A small seeded random (mulberry32), so one stream plans the same loop the same way everywhere it asks. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * One loop of the automatic run of show: talk, game, talk, game… ending on a
 * game. `loop` counts loops in this stream (it goes into the segment ids, so
 * a new loop never looks like the one before); `seed` varies the draw
 * between streams.
 */
export function autoShow(loop: number, seed: number): Segment[] {
  const random = seededRandom(seed + Math.imul(loop + 1, 0x9e3779b1));
  const talks = shuffled(TALK, random);
  // "poll" has no winners, so it never closes a loop: the podium wants points.
  const games = shuffled(GAME_KINDS, random);
  const scored = games.filter((kind) => kind !== "poll");
  const segments: Segment[] = [];
  let talk = 0;
  let game = 0;
  for (let i = 0; i < AUTO_SHOW_SEGMENTS; i++) {
    const id = `auto-${loop + 1}-${i + 1}`;
    if (i % 2 === 0) {
      const pick = talks[talk++ % talks.length] as (typeof TALK)[number];
      segments.push({ id, ...pick });
    } else {
      const last = i === AUTO_SHOW_SEGMENTS - 1;
      const kind: GameKind = last ? (scored.find((k) => !segments.some((s) => s.game?.kind === k)) ?? "trivia") : (games[game++ % games.length] as GameKind);
      segments.push({ id, title: GAME_TITLES[kind], minutes: GAME_MINUTES, prompt: GAME_PROMPT, game: { kind, rounds: GAME_ROUNDS } });
    }
  }
  return segments;
}

/** Segment titles for the automatic games: the stage shows them, so they read as show names. */
const GAME_TITLES: Record<GameKind, string> = {
  trivia: "Quiz da live",
  poll: "Isso ou aquilo",
  scramble: "Palavra embaralhada",
  number: "Adivinhe o número",
  truefalse: "Verdadeiro ou falso",
  math: "Conta rápida",
  riddle: "Charadas da live",
  fastest: "Dedo mais rápido",
};

/** The run of show a loop plays: the automatic one when it's on, otherwise the creator's segments. */
export function runOfShow(persona: Pick<Persona, "segments" | "autoShow">, loop: number, seed: number): Segment[] {
  return persona.autoShow ? autoShow(loop, seed) : persona.segments;
}
