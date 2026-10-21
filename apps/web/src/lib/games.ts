import type { GameKind, GameStatus } from "@tik-live/shared";

/** One line on how viewers play each game, for pickers and hints. */
export const GAME_HOW: Record<GameKind, string> = {
  trivia: "Uma pergunta com até quatro opções. O chat responde com a letra.",
  poll: "O chat vota entre duas e quatro opções. Sem vencedor, só opinião.",
  scramble: "Desembaralhe a palavra. Ganha quem digitar primeiro.",
  number: "Adivinhe o número secreto. A cada palpite, o palco diminui o intervalo.",
  truefalse: "Verdadeiro ou falso? O chat digita V ou F.",
  math: "Resolva a conta. Ganha a primeira resposta certa.",
  riddle: "Responda a charada. Ganha a primeira resposta certa.",
  fastest: "Digite a palavra que aparece na tela. Ganha quem for mais rápido.",
  tug: "Dois times. O chat entra digitando 1 ou 2, e curtidas, PUXA e presentes puxam a corda.",
  potato: "Digite PEGA pra pegar a batata: cada segundo vale ponto, mas quem estiver com ela quando explodir perde tudo.",
};

/** The hint for a segment set to "random": one of the games, drawn each time the segment comes around. */
export const RANDOM_GAME_HOW = "Sorteia um dos jogos toda vez que o quadro entra, em cada volta.";

/** What one entry from chat is called, per game: "12 votos", "3 palpites". */
export const ANSWER_WORD: Record<GameKind, [one: string, many: string]> = {
  trivia: ["resposta", "respostas"],
  poll: ["voto", "votos"],
  scramble: ["palpite", "palpites"],
  number: ["palpite", "palpites"],
  truefalse: ["resposta", "respostas"],
  math: ["resposta", "respostas"],
  riddle: ["palpite", "palpites"],
  fastest: ["tentativa", "tentativas"],
  tug: ["jogador", "jogadores"],
  potato: ["pegada", "pegadas"],
};

export const TOPIC_PLACEHOLDER = "Ex.: desenhos dos anos 90";

/** "Rodada 2/5", or "Escrevendo as perguntas…" before the first one. */
export function gamePhase(game: GameStatus): string {
  switch (game.phase) {
    case "preparing":
      return "Escrevendo as perguntas…";
    case "open":
      return `Rodada ${game.round}/${game.rounds}`;
    case "reveal":
      return "Revelando a resposta";
    case "results":
      return "Placar final";
  }
}
