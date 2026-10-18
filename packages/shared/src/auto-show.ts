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
    prompt: "Solte opiniões polêmicas de verdade sobre o que o povo adora brigar (futebol, comida, música, famosos, relacionamentos, tretas da internet), defenda com convicção e humor e desafie o chat a discordar. Política e religião só do jeito que as regras do canal deixam.",
  },
  {
    title: "Pergunta sem filtro",
    minutes: 6,
    prompt: "Convide o chat a perguntar QUALQUER coisa e responda com a sua opinião sincera, sem enrolar e sem ficar em cima do muro. Quanto mais polêmica a pergunta, mais firme a resposta. Quando ninguém perguntar, solte uma opinião forte e pergunte quem discorda.",
  },
  {
    title: "Tribunal do chat",
    minutes: 6,
    prompt: "Peça pra alguém do chat confessar uma mania ou treta do dia a dia e julgue como um juiz dramático: culpado ou inocente, com uma sentença engraçada. Depois peça pro chat dizer se concorda com o veredito.",
  },
  {
    title: "Red flag ou green flag",
    minutes: 6,
    prompt: "Leia hábitos e situações de relacionamento e do dia a dia que o chat mandar (ou invente) e decrete na hora: red flag ou green flag, com uma opinião forte e engraçada. Peça pro chat mandar mais.",
  },
  {
    title: "Ranking sem dó",
    minutes: 6,
    prompt: "Monte rankings polêmicos ao vivo (comida de rua, modinhas da internet, cantores, novelas, times) com opinião forte, sem dó, e peça pro chat brigar com a sua ordem.",
  },
  {
    title: "Previsões da IA",
    minutes: 5,
    prompt: "Vire uma vidente exagerada: faça previsões malucas e engraçadas sobre quem está no chat, pelo nome, e sobre o futuro do mundo. Peça pra pessoa dizer o signo ou uma palavra e preveja o destino dela.",
  },
  {
    title: "Teorias da conspiração",
    minutes: 5,
    prompt: "Invente teorias da conspiração absurdas e inofensivas sobre coisas do dia a dia (o pombo é um drone, o miojo nunca fica pronto em 3 minutos) e peça pro chat criar as suas. Julgue a mais criativa.",
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
  race: "Corrida maluca",
  wheel: "Roleta da sorte",
  tug: "Cabo de guerra",
  potato: "Batata quente",
};

/** The run of show a loop plays: the automatic one when it's on, otherwise the creator's segments. */
export function runOfShow(persona: Pick<Persona, "segments" | "autoShow">, loop: number, seed: number): Segment[] {
  return persona.autoShow ? autoShow(loop, seed) : persona.segments;
}
