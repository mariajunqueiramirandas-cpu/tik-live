import "../styles/base.css";
import "./landing.css";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { Landing, PRICE_TOKENS, type Prices } from "./Landing";

/**
 * In production the server fills prices into the prerendered HTML and
 * repeats them in a JSON block, so hydration renders the same text. In
 * development there's no prerender: fetch them from the public config.
 */
function readPrices(): Prices | null {
  const block = document.getElementById("lantern-prices");
  if (!block?.textContent) return null;
  try {
    return JSON.parse(block.textContent) as Prices;
  } catch {
    return null;
  }
}

const container = document.getElementById("landing") as HTMLElement;
const prices = readPrices();

if (container.firstElementChild && prices) {
  hydrateRoot(
    container,
    <StrictMode>
      <Landing prices={prices} />
    </StrictMode>,
  );
} else {
  const root = createRoot(container);
  const render = (p: Prices) =>
    root.render(
      <StrictMode>
        <Landing prices={p} />
      </StrictMode>,
    );
  render({ free: "Grátis", creator: "…", pro: "…" });
  void fetch("/api/config")
    .then((r) => r.json() as Promise<{ pricing?: Prices }>)
    .then((config) => render(config.pricing ?? PRICE_TOKENS))
    .catch(() => undefined);
}
