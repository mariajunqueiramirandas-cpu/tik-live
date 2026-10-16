import { z } from "zod";

/**
 * The broadcaster's internal API (ADR-0014), shared by the app server and
 * apps/broadcaster.
 * Every request carries `Authorization: Bearer <BROADCASTER_TOKEN>`.
 */
export const videoSchema = z.object({
  width: z.number().int().min(360).max(1080).default(720),
  height: z.number().int().min(640).max(1920).default(1280),
  fps: z.number().int().min(15).max(60).default(30),
  bitrateKbps: z.number().int().min(800).max(8000).default(3000),
});
export type VideoSettings = z.infer<typeof videoSchema>;

export const startBroadcastSchema = z.object({
  channelId: z.string().min(1).max(64),
  /** The stage page for this channel; must be on the configured app origin. */
  stageUrl: z.string().url().max(500),
  rtmpUrl: z.string().max(300),
  streamKey: z.string().min(4).max(300),
  video: videoSchema.default({ width: 720, height: 1280, fps: 30, bitrateKbps: 3000 }),
});
export type StartBroadcast = z.input<typeof startBroadcastSchema>;

export const BROADCAST_STATES = ["starting", "live", "retrying", "failed", "stopped"] as const;
export type BroadcastState = (typeof BROADCAST_STATES)[number];

export interface BroadcastStatus {
  channelId: string;
  state: BroadcastState;
  /** Human-readable, never contains the stream key. */
  detail: string;
  since: string;
  restarts: number;
  stats: { fps: number | null; bitrateKbps: number | null; droppedFrames: number | null; speed: number | null } | null;
}

export interface BroadcasterList {
  broadcasts: BroadcastStatus[];
  capacity: { max: number; used: number };
}
