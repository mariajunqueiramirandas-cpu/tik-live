import type { GiftAsks, Ticker } from "@tik-live/shared";
import { PERKS } from "./perks";

type TickerLine = Ticker["lines"][number];

/**
 * The always-on support ticker (ADR-0041): what gifts pay for and what they
 * get on the show, between the free ways to help. Every line is one of the
 * show's own rules, so none of it promises anything the show doesn't do.
 */
export function supportTicker(options: { perks: boolean; asks: GiftAsks }): Ticker {
  const gifts: TickerLine[] = [
    { way: "gift", text: "Presentes pagam as contas da IA" },
    { way: "gift", text: "Todo presente: seu nome na live" },
    ...(options.perks ? PERKS.map((perk) => ({ way: "gift" as const, text: perk.card, diamonds: perk.diamonds })) : []),
    { way: "gift", text: "Top Doadores: coroa pro 1º lugar" },
    { way: "gift", text: "Presente no jogo: power-up pra todos" },
  ];
  const free: TickerLine[] = [
    { way: "like", text: "Toque na tela pra curtir" },
    { way: "follow", text: "Siga pra não perder a próxima" },
    { way: "share", text: "Compartilhe com um amigo" },
  ];
  // Gifts come up most; a channel that asks actively puts two of them between each free way to help.
  const run = options.asks === "active" ? 2 : 1;
  const lines: TickerLine[] = [];
  let nextFree = 0;
  gifts.forEach((line, i) => {
    lines.push(line);
    if ((i + 1) % run === 0 && nextFree < free.length) lines.push(free[nextFree++] as TickerLine);
  });
  while (nextFree < free.length) lines.push(free[nextFree++] as TickerLine);
  return { title: "APOIE A LIVE", lines };
}
