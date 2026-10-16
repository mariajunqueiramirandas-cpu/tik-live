import type { Context, Hono } from "hono";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AppDeps } from "../deps";
import { compressBody, pickEncoding, type CompressedBody, type Encoding } from "./encoding";
import type { AppEnv } from "./env";
import { publicPrices } from "./pricing";
import { publicConfig } from "./routes/account";
import { channelForStageKey } from "./routes/stage";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serves the built dashboard, landing page and stage page (ADR-0010):
 * hashed assets are immutable; HTML is never cached so deploys show up
 * immediately; unknown app routes fall back to the SPA.
 */
export function mountStatic(app: Hono<AppEnv>, deps: AppDeps): void {
  const dist = deps.config.WEB_DIST ? path.resolve(deps.config.WEB_DIST) : null;
  if (!dist || !existsSync(dist)) {
    app.get("/s/:stageKey", (c) =>
      c.text("The stage page is served by Vite in development. Open it through the dashboard dev server instead.", 404),
    );
    return;
  }

  const file = (relative: string) => {
    const full = path.resolve(dist, "." + relative);
    if (!full.startsWith(dist + path.sep)) return null;
    const handle = Bun.file(full);
    return handle;
  };

  // The web build writes .br/.gz copies next to text assets; index them once (dist never changes at runtime).
  const precompressed = new Set<string>();
  for (const entry of readdirSync(dist, { recursive: true, encoding: "utf8" })) {
    if (entry.endsWith(".br") || entry.endsWith(".gz")) precompressed.add(path.join(dist, entry));
  }

  const sendFile = async (c: Context<AppEnv>, relative: string, cache: string) => {
    const handle = file(relative);
    if (!handle || !(await handle.exists())) return null;
    const headers: Record<string, string> = { "content-type": MIME[path.extname(relative)] ?? "application/octet-stream", "cache-control": cache };
    const available = (["br", "gzip"] as const).filter((enc) => precompressed.has(`${handle.name}.${enc === "br" ? "br" : "gz"}`));
    if (available.length === 0) return new Response(handle, { headers });
    headers.vary = "Accept-Encoding";
    const encoding = pickEncoding(c.req.header("accept-encoding"), available);
    if (!encoding) return new Response(handle, { headers });
    headers["content-encoding"] = encoding;
    return new Response(Bun.file(`${handle.name}.${encoding === "br" ? "br" : "gz"}`), { headers });
  };

  /** HTML rendered once at startup, kept compressed. */
  const sendHtml = (c: Context<AppEnv>, body: CompressedBody) => {
    const encoding: Encoding | null = pickEncoding(c.req.header("accept-encoding"));
    const headers: Record<string, string> = { "content-type": MIME[".html"] as string, "cache-control": "no-cache", vary: "Accept-Encoding" };
    if (encoding) headers["content-encoding"] = encoding;
    return c.body(encoding ? body[encoding] : body.identity, 200, headers);
  };

  app.get("/s/:stageKey", async (c) => {
    const channel = await channelForStageKey(deps, c.req.param("stageKey"));
    if (!channel) return c.text("This stage link doesn't exist or was replaced. Copy the current link from the dashboard.", 404);
    const res = await sendFile(c, "/stage.html", "no-cache");
    return res ?? c.text("Stage page missing from this build.", 500);
  });

  app.get("/assets/*", async (c) => (await sendFile(c, c.req.path, "public, max-age=31536000, immutable")) ?? c.body(null, 404));
  app.get("/fonts/*", async (c) => (await sendFile(c, c.req.path, "public, max-age=31536000, immutable")) ?? c.body(null, 404));

  // The landing page is prerendered at build time; prices are server config,
  // so they're filled in here (and repeated as JSON for hydration).
  let landing: CompressedBody | null = null;
  const landingHtml = async (): Promise<CompressedBody | null> => {
    if (landing) return landing;
    const handle = file("/landing.html");
    if (!handle || !(await handle.exists())) return null;
    const prices = publicPrices(deps);
    const json = JSON.stringify(prices).replace(/</g, "\\u003c");
    let html = await handle.text();
    for (const [id, text] of Object.entries(prices)) html = html.replaceAll(`{{price:${id}}}`, escapeHtml(text));
    html = html.replace("<!--lantern:head-->", `<script type="application/json" id="lantern-prices">${json}</script>`);
    landing = compressBody(html);
    return landing;
  };

  let dashboard: CompressedBody | null = null;
  const dashboardHtml = async (): Promise<CompressedBody | null> => {
    if (dashboard) return dashboard;
    const handle = file("/index.html");
    if (!handle || !(await handle.exists())) return null;
    const json = JSON.stringify(publicConfig(deps)).replace(/</g, "\\u003c");
    dashboard = compressBody((await handle.text()).replace("</head>", `<script type="application/json" id="lantern-config">${json}</script></head>`));
    return dashboard;
  };

  app.get("/", async (c, next) => {
    const html = await landingHtml();
    if (!html) return next();
    return sendHtml(c, html);
  });

  app.get("*", async (c) => {
    const pathname = c.req.path;
    if (pathname.startsWith("/api/") || pathname.startsWith("/ws/")) return c.notFound();
    if (pathname !== "/" && path.extname(pathname)) {
      const res = await sendFile(c, pathname, "public, max-age=3600");
      if (res) return res;
      return c.body(null, 404);
    }
    // Everything else is the dashboard, with its public config inlined so the
    // first render knows the sign-in mode without another round trip.
    const html = await dashboardHtml();
    return html ? sendHtml(c, html) : c.text("Dashboard missing from this build.", 500);
  });
}
