import type { AppDeps } from "../deps";

export interface PublicPrices {
  free: string;
  creator: string;
  pro: string;
}

/** Display prices for the landing page and public config, formatted once on the server. */
export function publicPrices(deps: AppDeps): PublicPrices {
  const currency = deps.config.BILLING_CURRENCY;
  const format = new Intl.NumberFormat(currency === "BRL" ? "pt-BR" : "en-US", { style: "currency", currency });
  const byId = Object.fromEntries(deps.billing.offers().map((offer) => [offer.id, offer.price]));
  const show = (price: number | null | undefined) => (price ? format.format(price) : "Grátis");
  return { free: "Grátis", creator: show(byId.creator), pro: show(byId.pro) };
}
