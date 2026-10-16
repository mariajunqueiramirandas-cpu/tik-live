import type { ChannelDto } from "@tik-live/shared";
import type { AppDeps } from "../deps";
import type { ChannelRow } from "../repos/channels";

export async function stageUrlFor(deps: AppDeps, row: ChannelRow): Promise<string> {
  const key = await deps.secrets.decrypt("stage-key", row.stageKeyCiphertext);
  return `${deps.config.PUBLIC_URL.replace(/\/$/, "")}/s/${key}`;
}

export async function toChannelDto(deps: AppDeps, row: ChannelRow): Promise<ChannelDto> {
  return {
    id: row.id,
    name: row.name,
    tiktokUsername: row.tiktokUsername,
    source: row.source,
    persona: row.persona,
    voice: row.voice,
    safety: row.safety,
    broadcast: {
      enabled: row.broadcast.enabled,
      rtmpUrl: row.broadcast.rtmpUrl,
      hasStreamKey: Boolean(row.broadcast.streamKeyCiphertext),
      streamKeyLast4: row.broadcast.streamKeyLast4,
    },
    desiredState: row.desiredState,
    runtime: deps.manager.summary(row),
    stageUrl: await stageUrlFor(deps, row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
