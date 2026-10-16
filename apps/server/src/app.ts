import { Hono } from "hono";
import type { AppDeps } from "./deps";
import type { AppEnv } from "./http/env";
import { errorHandler, problem } from "./http/errors";
import { clientIp, configureProxyTrust, csrfGuard, devGate, rateLimit, requestLog, securityHeaders } from "./http/middleware";
import { mountRealtime } from "./http/realtime";
import { configRoutes, meRoutes } from "./http/routes/account";
import { billingRoutes, billingWebhookRoutes, voiceRoutes } from "./http/routes/billing";
import { channelRoutes } from "./http/routes/channels";
import { stageApiRoutes } from "./http/routes/stage";
import { mountStatic } from "./http/static";

/** The typed API surface the dashboard calls through `hc<AppType>` (ADR-0003). */
export function buildApi(deps: AppDeps) {
  return new Hono<AppEnv>()
    .route("/api/config", configRoutes(deps))
    .route("/api/me", meRoutes(deps))
    .route("/api/channels", channelRoutes(deps))
    .route("/api/voices", voiceRoutes(deps))
    .route("/api/billing/webhook", billingWebhookRoutes(deps))
    .route("/api/billing", billingRoutes(deps))
    .route("/api/stage", stageApiRoutes(deps));
}

export type AppType = ReturnType<typeof buildApi>;

export function createApp(deps: AppDeps): Hono<AppEnv> {
  configureProxyTrust(deps.config.TRUST_PROXY);
  const app = new Hono<AppEnv>();
  app.onError(errorHandler(deps.log));

  app.use("*", requestLog(deps));
  app.use("*", securityHeaders(deps));
  if (deps.config.AUTH_MODE === "dev" && deps.config.DEV_GATE_PASSWORD) app.use("*", devGate(deps.config.DEV_GATE_PASSWORD));
  app.use("/api/*", csrfGuard(deps));
  app.use("/api/*", rateLimit({ windowMs: 60_000, max: 600, key: (c) => `api:${clientIp(c) ?? "unknown"}` }));

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    try {
      await deps.database.ping();
      return c.json({ ok: true, database: deps.database.kind });
    } catch {
      return problem(c, 503, "not_ready", "Database unreachable.");
    }
  });

  app.route("/", buildApi(deps));
  // Sign-in callbacks and identity webhooks, when the provider has them.
  const identityRoutes = deps.identity.routes?.();
  if (identityRoutes) app.route("/", identityRoutes);
  mountRealtime(app, deps);
  app.notFound((c) => (c.req.path.startsWith("/api/") ? problem(c, 404, "not_found", "No such endpoint.") : c.text("Not found", 404)));
  mountStatic(app, deps);
  return app;
}
