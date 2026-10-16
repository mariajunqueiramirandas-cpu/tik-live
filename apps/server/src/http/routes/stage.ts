import { Hono } from "hono";
import type { AppDeps } from "../../deps";
import { getChannelByStageLookup, type ChannelRow } from "../../repos/channels";
import type { AppEnv } from "../env";

/** Resolves a stage key to its channel (HMAC lookup, ADR-0016). */
export async function channelForStageKey(deps: AppDeps, stageKey: string): Promise<ChannelRow | undefined> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(stageKey)) return undefined;
  return getChannelByStageLookup(deps.db, await deps.secrets.lookup(stageKey));
}

/** Speech audio for stage clients. The stage key scopes access to one channel. */
export function stageApiRoutes(deps: AppDeps) {
  return new Hono<AppEnv>().get("/:stageKey/audio/:cueId", async (c) => {
    const channel = await channelForStageKey(deps, c.req.param("stageKey"));
    if (!channel) return c.body(null, 404);
    const clip = deps.audio.get(channel.id, c.req.param("cueId"));
    if (!clip) return c.body(null, 404);
    return c.body(new Uint8Array(clip.data), 200, { "content-type": clip.mime, "cache-control": "private, max-age=120, immutable" });
  });
}
