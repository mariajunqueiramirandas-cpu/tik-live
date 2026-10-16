/**
 * Prerenders the landing page into dist/landing.html (ADR-0010). Prices
 * stay as tokens; the server fills them in from its configuration.
 */
import path from "node:path";
import { renderToString } from "react-dom/server";
import { Landing, PRICE_TOKENS } from "../src/landing/Landing";

const file = path.resolve(import.meta.dir, "../dist/landing.html");
const html = await Bun.file(file).text();
if (!html.includes("<!--lantern:landing-->")) throw new Error("landing.html has no <!--lantern:landing--> marker");
const markup = renderToString(<Landing prices={PRICE_TOKENS} />);
await Bun.write(file, html.replace("<!--lantern:landing-->", markup));
console.log(`prerendered landing.html (${(markup.length / 1024).toFixed(1)} KB of markup)`);
