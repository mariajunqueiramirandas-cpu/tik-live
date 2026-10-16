import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../../deps";
import type { AppEnv } from "../env";
import { problem } from "../errors";
import { clientIp, requireUser } from "../middleware";
import { valid } from "../validate";

export function billingWebhookRoutes(deps: AppDeps) {
  return new Hono<AppEnv>().post("/", async (c) => {
    const body = await c.req.text();
    if (body.length > 1_000_000) return problem(c, 413, "too_large", "Payload too large.");
    const ok = await deps.billing.handleWebhook({
      signature: c.req.header("x-signature") ?? null,
      requestId: c.req.header("x-request-id") ?? null,
      query: new URL(c.req.url).searchParams,
      body,
    });
    if (!ok) return problem(c, 401, "bad_signature", "Invalid signature.");
    return c.json({ received: true });
  });
}

export function billingRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .use(requireUser(deps))
    .get("/", async (c) => c.json(await deps.billing.status(c.get("user").id)))
    .post("/checkout", valid("json", z.object({ plan: z.enum(["creator", "pro"]) })), async (c) => {
      const result = await deps.billing.checkout(c.get("user"), c.req.valid("json").plan, clientIp(c));
      return c.json(result);
    })
    .post("/cancel", async (c) => {
      await deps.billing.cancel(c.get("user"), clientIp(c));
      return c.json(await deps.billing.status(c.get("user").id));
    });
}

export function voiceRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .use(requireUser(deps))
    .get("/", async (c) => {
      const plan = await deps.entitlements.planFor(c.get("user").id);
      return c.json({
        enabled: deps.voices.enabled,
        providers: deps.voices.providers,
        canChoose: plan.limits.voices === "curated",
        defaultVoiceId: deps.config.DEFAULT_VOICE_ID ?? null,
        defaultPocketVoiceId: deps.config.pocketEnabled ? deps.config.POCKET_TTS_VOICE : null,
        voices: await deps.voices.list(),
      });
    })
    .get("/pocket/:voice/sample", async (c) => {
      const voice = c.req.param("voice");
      if (voice.length > 64) return problem(c, 404, "voice_not_found", "No such voice.");
      const sample = await deps.voices.pocketSample(voice).catch((err: unknown) => {
        deps.log.warn("voice sample failed", err);
        return undefined;
      });
      if (sample === null) return problem(c, 404, "voice_not_found", "No such voice.");
      if (!sample) return problem(c, 503, "voice_unavailable", "The voice server is busy. Try again in a moment.");
      return c.body(new Uint8Array(sample.data), 200, { "content-type": sample.mime, "cache-control": "private, max-age=3600" });
    });
}
