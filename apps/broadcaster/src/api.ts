import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { BroadcastError, type BroadcastManager } from "./manager";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const problem = (code: string, message: string) => ({ error: { code, message } });

/** The internal control API the app server calls (ADR-0014). */
export function createApi(manager: BroadcastManager, token: string) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, ...manager.list().capacity }));

  app.use("/broadcasts/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ") || !safeEqual(header.slice(7), token)) return c.json(problem("unauthorized", "Bad token."), 401);
    return next();
  });
  app.use("/broadcasts", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ") || !safeEqual(header.slice(7), token)) return c.json(problem("unauthorized", "Bad token."), 401);
    return next();
  });

  app.get("/broadcasts", (c) => c.json(manager.list()));

  app.post("/broadcasts", async (c) => {
    const body = await c.req.json().catch(() => null);
    try {
      return c.json({ broadcast: await manager.ensure(body) }, 202);
    } catch (err) {
      if (err instanceof BroadcastError) return c.json(problem(err.code, err.message), err.status);
      throw err;
    }
  });

  app.post("/broadcasts/check", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { rtmpUrl?: unknown } | null;
    if (typeof body?.rtmpUrl !== "string") return c.json(problem("invalid_input", "rtmpUrl is required."), 400);
    return c.json(await manager.check(body.rtmpUrl));
  });

  app.get("/broadcasts/:channelId", (c) => {
    const status = manager.get(c.req.param("channelId"));
    return status ? c.json({ broadcast: status }) : c.json(problem("not_found", "No broadcast for that channel."), 404);
  });

  app.delete("/broadcasts/:channelId", async (c) => {
    await manager.stop(c.req.param("channelId"));
    return c.body(null, 204);
  });

  app.onError((err, c) => c.json(problem("internal", err.message.slice(0, 200)), 500));
  return app;
}
