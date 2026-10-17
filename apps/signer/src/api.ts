import { Hono, type Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import {
  signerRoomRequestSchema,
  signerWebcastRequestSchema,
  type SignerErrorCode,
  type SignerRoomResponse,
  type SignerWebcastResponse,
} from "@tik-live/shared";
import { SignerError, type SignerBackend } from "./backend";
import type { Logger } from "./log";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const problem = (code: SignerErrorCode, message: string) => ({ error: { code, message } });

/** The internal API the app server calls (ADR-0023). */
export function createApi(backend: SignerBackend, token: string, log?: Logger) {
  const app = new Hono();

  // Liveness, plus whether the browser is ready. Nothing in it is sensitive.
  app.get("/healthz", (c) => c.json({ ok: true, ...backend.health() }));

  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ") || !safeEqual(header.slice(7), token)) return c.json(problem("unauthorized", "Bad token."), 401);
    return next();
  });

  const fail = (c: Context, err: unknown) => {
    if (err instanceof SignerError) {
      if (err.status === 429) c.header("retry-after", "3");
      log?.warn("request failed", { code: err.code, message: err.message });
      return c.json(problem(err.code, err.message), err.status);
    }
    log?.error("unexpected error", { message: err instanceof Error ? err.message : String(err) });
    return c.json(problem("internal", "Unexpected error in the signer."), 500);
  };

  app.post("/v1/webcast-fetch", async (c) => {
    const parsed = signerWebcastRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(problem("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")), 400);
    try {
      const result = await backend.fetchWebcast(parsed.data);
      const body: SignerWebcastResponse = { roomId: result.roomId, cookies: result.cookies, body: Buffer.from(result.body).toString("base64") };
      return c.json(body);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/v1/room", async (c) => {
    const parsed = signerRoomRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(problem("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")), 400);
    try {
      const body: SignerRoomResponse = await backend.lookupRoom(parsed.data.uniqueId);
      return c.json(body);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.onError((err, c) => fail(c, err));
  return app;
}
