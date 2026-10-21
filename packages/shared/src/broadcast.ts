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

// ---------------------------------------------------------------------------
// Local TikTok LIVE Studio Bridge Agent protocol

/**
 * Ports TikTok LIVE Studio's built-in local Socket.IO server (`StreamDeckService`)
 * listens on (`127.0.0.1`), in order of preference.
 */
export const LIVE_STUDIO_PORTS = [28189, 39728, 34246, 42205, 38534, 40825, 40622] as const;
export const LIVE_STUDIO_SUBPROTOCOL = "streamdeck_ttls_v1";

export const LIVE_STUDIO_ACTIONS = {
  liveStartEnd: "com.tiktok.livestudio.livestartend",
  livePauseResume: "com.tiktok.livestudio.livepauseresume",
} as const;

export const LIVE_STUDIO_STREAM_STATUSES = ["stopped", "paused", "live"] as const;
export type LiveStudioStreamStatus = (typeof LIVE_STUDIO_STREAM_STATUSES)[number];

export const liveStudioProbeSchema = z.object({
  connected: z.boolean(),
  port: z.number().int().nullable(),
  streamStatus: z.enum(LIVE_STUDIO_STREAM_STATUSES).nullable(),
  scene: z.string().max(200).nullable(),
  installed: z.boolean(),
  executablePath: z.string().max(500).nullable(),
});
export type LiveStudioProbe = z.infer<typeof liveStudioProbeSchema>;

export const BRIDGE_ACTIONS = ["probe", "start", "stop", "launch"] as const;
export type BridgeAction = (typeof BRIDGE_ACTIONS)[number];

export const bridgeServerMessageSchema = z.discriminatedUnion("t", [
  z.object({
    v: z.literal(1),
    t: z.literal("hello"),
    channelId: z.string(),
    channelName: z.string(),
  }),
  z.object({
    v: z.literal(1),
    t: z.literal("request"),
    id: z.string().min(1).max(64),
    action: z.enum(BRIDGE_ACTIONS),
  }),
]);
export type BridgeServerMessage = z.infer<typeof bridgeServerMessageSchema>;

export const bridgeClientMessageSchema = z.discriminatedUnion("t", [
  z.object({
    v: z.literal(1),
    t: z.literal("status"),
    probe: liveStudioProbeSchema,
  }),
  z.object({
    v: z.literal(1),
    t: z.literal("response"),
    id: z.string().min(1).max(64),
    probe: liveStudioProbeSchema.optional(),
    result: z
      .object({
        ok: z.boolean(),
        detail: z.string().max(500),
      })
      .optional(),
  }),
]);
export type BridgeClientMessage = z.infer<typeof bridgeClientMessageSchema>;

/**
 * Converts a channel Stage URL (`https://host/s/<stageKey>`) or bridge URL
 * (`ws://host/ws/bridge/<stageKey>`) into the WebSocket endpoint the local
 * bridge agent connects to.
 */
export function toBridgeWsUrl(inputUrl: string): string {
  const trimmed = inputUrl.trim();
  const parsed = new URL(trimmed);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "https:") parsed.protocol = "wss:";
  else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Use um endereço http://, https://, ws:// ou wss://");
  }
  const stageMatch = parsed.pathname.match(/\/s\/([A-Za-z0-9_-]{16,64})\/?$/);
  if (stageMatch) {
    parsed.pathname = `/ws/bridge/${stageMatch[1]}`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }
  const bridgeMatch = parsed.pathname.match(/\/ws\/bridge\/([A-Za-z0-9_-]{16,64})\/?$/);
  if (bridgeMatch) {
    parsed.pathname = `/ws/bridge/${bridgeMatch[1]}`;
    return parsed.toString();
  }
  throw new Error("Use o link do palco do apresentador (ex: https://.../s/...)");
}
