import { bridgePairRequestSchema } from "@tik-live/shared";
import { Hono } from "hono";
import { pairDevice } from "../../broadcast/bridge-pairing";
import type { AppDeps } from "../../deps";
import { audit } from "../../repos/audit";
import type { AppEnv } from "../env";
import { problem } from "../errors";
import { clientIp, rateLimit } from "../middleware";
import { valid } from "../validate";

/**
 * Unauthenticated: the Local Bridge Agent trades a pairing code from the
 * dashboard for its device token (ADR-0047). The code is the credential, so
 * attempts are rate limited per address.
 */
export function bridgeRoutes(deps: AppDeps) {
  return new Hono<AppEnv>().post(
    "/pair",
    rateLimit({ windowMs: 10 * 60_000, max: 20, key: (c) => `bridge-pair:${clientIp(c) ?? "unknown"}` }),
    valid("json", bridgePairRequestSchema),
    async (c) => {
      const paired = await pairDevice(deps, c.req.valid("json"));
      if (!paired) return problem(c, 400, "bad_pairing_code", "Código de pareamento inválido ou vencido. Gere um novo no painel.");
      await audit(deps.db, {
        userId: paired.channel.ownerId,
        action: "channel.bridge_paired",
        target: paired.channel.id,
        meta: { deviceId: paired.response.deviceId },
        ip: clientIp(c),
      });
      return c.json(paired.response);
    },
  );
}
