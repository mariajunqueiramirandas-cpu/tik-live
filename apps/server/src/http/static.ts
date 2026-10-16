import type { Hono } from "hono";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AppDeps } from "../deps";
import type { AppEnv } from "./env";
import { channelForStageKey } from "./routes/stage";

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

  const sendFile = async (relative: string, cache: string) => {
    const handle = file(relative);
    if (!handle || !(await handle.exists())) return null;
    return new Response(handle, {
      headers: { "content-type": MIME[path.extname(relative)] ?? "application/octet-stream", "cache-control": cache },
    });
  };

  app.get("/s/:stageKey", async (c) => {
    const channel = await channelForStageKey(deps, c.req.param("stageKey"));
    if (!channel) return c.text("This stage link doesn't exist or was replaced. Copy the current link from the dashboard.", 404);
    const res = await sendFile("/stage.html", "no-cache");
    return res ?? c.text("Stage page missing from this build.", 500);
  });

  app.get("/assets/*", async (c) => (await sendFile(c.req.path, "public, max-age=31536000, immutable")) ?? c.body(null, 404));
  app.get("/fonts/*", async (c) => (await sendFile(c.req.path, "public, max-age=31536000, immutable")) ?? c.body(null, 404));

  app.get("*", async (c) => {
    const pathname = c.req.path;
    if (pathname.startsWith("/api/") || pathname.startsWith("/ws/")) return c.notFound();
    if (pathname !== "/" && path.extname(pathname)) {
      const res = await sendFile(pathname, "public, max-age=3600");
      if (res) return res;
      return c.body(null, 404);
    }
    // The landing page is prerendered to its own file; everything else is the SPA.
    const page = pathname === "/" && file("/landing.html") ? "/landing.html" : "/index.html";
    const res = (await sendFile(page, "no-cache")) ?? (await sendFile("/index.html", "no-cache"));
    return res ?? c.text("Dashboard missing from this build.", 500);
  });
}
