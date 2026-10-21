import { djTrack } from "@tik-live/shared";
import { Hono } from "hono";
import type { AppDeps } from "../../deps";
import { parseRange } from "../../runtime/dj-cache";
import { getChannelByStageLookup, type ChannelRow } from "../../repos/channels";
import type { AppEnv } from "../env";

/** Resolves a stage key to its channel (HMAC lookup, ADR-0016). */
export async function channelForStageKey(deps: AppDeps, stageKey: string): Promise<ChannelRow | undefined> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(stageKey)) return undefined;
  return getChannelByStageLookup(deps.db, await deps.secrets.lookup(stageKey));
}

/** Speech audio and the DJ's tracks for stage clients. The stage key scopes access to one channel. */
export function stageApiRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .get("/:stageKey/audio/:cueId", async (c) => {
      const channel = await channelForStageKey(deps, c.req.param("stageKey"));
      if (!channel) return c.body(null, 404);
      const clip = deps.audio.get(channel.id, c.req.param("cueId"));
      if (!clip) return c.body(null, 404);
      return c.body(new Uint8Array(clip.data), 200, { "content-type": clip.mime, "cache-control": "private, max-age=120, immutable" });
    })
    // The automatic DJ's tracks (ADR-0045), with byte ranges: the stage streams them and seeks to catch up.
    .get("/:stageKey/dj/:trackId", async (c) => {
      const track = djTrack(c.req.param("trackId"));
      if (!track) return c.body(null, 404);
      const channel = await channelForStageKey(deps, c.req.param("stageKey"));
      if (!channel) return c.body(null, 404);
      const path = await deps.djCache.file(track);
      if (!path) return c.body(null, 503, { "retry-after": "60" });
      const file = Bun.file(path);
      const size = file.size;
      const headers: Record<string, string> = { "content-type": "audio/mpeg", "accept-ranges": "bytes", "cache-control": "private, max-age=86400" };
      const range = parseRange(c.req.header("range"), size);
      if (range === "invalid") return c.body(null, 416, { ...headers, "content-range": `bytes */${size}` });
      if (!range) return new Response(file, { status: 200, headers: { ...headers, "content-length": String(size) } });
      return new Response(file.slice(range.start, range.end + 1), {
        status: 206,
        headers: { ...headers, "content-length": String(range.end - range.start + 1), "content-range": `bytes ${range.start}-${range.end}/${size}` },
      });
    });
}
