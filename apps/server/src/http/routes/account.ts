import { PRODUCT_NAME, limitsToWire } from "@tik-live/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../../deps";
import { DEV_USER_COOKIE } from "../../identity/dev";
import { listChannels } from "../../repos/channels";
import { deleteUser } from "../../repos/users";
import type { AppEnv } from "../env";
import { problem } from "../errors";
import { publicPrices } from "../pricing";
import { requireUser } from "../middleware";
import { valid } from "../validate";

/** Public, unauthenticated settings the dashboard needs before anything else. */
export function configRoutes(deps: AppDeps) {
  return new Hono<AppEnv>().get("/", (c) =>
    c.json({
      productName: PRODUCT_NAME,
      authMode: deps.config.AUTH_MODE,
      clerkPublishableKey: deps.config.AUTH_MODE === "clerk" ? deps.config.CLERK_PUBLISHABLE_KEY ?? null : null,
      billing: { enabled: deps.billing.enabled, currency: deps.config.BILLING_CURRENCY },
      broadcast: { enabled: deps.config.BROADCAST_ENABLED },
      ai: { enabled: deps.config.aiEnabled, hostModel: deps.config.aiEnabled ? deps.config.HOST_MODEL : null },
      voice: { enabled: deps.config.ttsEnabled },
      pricing: publicPrices(deps),
    }),
  );
}

export function meRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .use(requireUser(deps))
    .get("/", async (c) => {
      const user = c.get("user");
      const plan = await deps.entitlements.planFor(user.id);
      return c.json({
        user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt.toISOString() },
        plan: { id: plan.id, name: plan.name, limits: limitsToWire(plan.limits) },
        authMode: deps.config.AUTH_MODE,
        devUser: deps.config.AUTH_MODE === "dev" ? user.externalId.replace(/^dev\|/, "") : null,
      });
    })
    .post("/dev-user", valid("json", z.object({ name: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,31}$/) })), (c) => {
      // Dev-only impersonation switcher (ADR-0018). Unavailable with real sign-in.
      if (deps.config.AUTH_MODE !== "dev") return problem(c, 404, "not_found", "Not available.");
      const { name } = c.req.valid("json");
      c.header("set-cookie", `${DEV_USER_COOKIE}=${encodeURIComponent(name)}; Path=/; SameSite=Lax${deps.config.isProduction ? "; Secure" : ""}`);
      return c.json({ devUser: name });
    })
    .delete("/", async (c) => {
      // Deleting the account removes every channel, memory, session and usage row (cascade).
      const user = c.get("user");
      for (const channel of await listChannels(deps.db, user.id)) await deps.manager.remove(channel.id);
      await deleteUser(deps.db, user.id);
      return c.body(null, 204);
    });
}
