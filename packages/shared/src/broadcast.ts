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

// ---------------------------------------------------------------------------
// Pairing the Local Bridge Agent with a channel (ADR-0047)

/** No 0/O, 1/I/L: a code read off a screen and typed into a terminal. */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 8;
/** How long a pairing code works, and how long a downloaded agent pairs by itself. */
export const PAIRING_CODE_TTL_MS = 15 * 60_000;

/** `ABCD2345` → `ABCD-2345`, the way the dashboard shows it. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Accepts what people type (`abcd 2345`, `ABCD-2345`) and returns the bare code, or null. */
export function normalizePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of code) if (!PAIRING_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export const bridgePairRequestSchema = z.object({
  code: z.string().min(1).max(32),
  /** The PC's name, so the dashboard can list it. */
  device: z.string().trim().min(1).max(64).optional(),
});
export type BridgePairRequest = z.infer<typeof bridgePairRequestSchema>;

export interface BridgePairResponse {
  token: string;
  deviceId: string;
  channelId: string;
  channelName: string;
}

/** WebSocket close codes the agent acts on. */
export const BRIDGE_CLOSE = {
  /** The stage key changed (legacy stage-link agents). */
  stageKeyRotated: 4001,
  /** The device was removed from the dashboard, or its token is unknown: pair again. */
  unpaired: 4003,
  channelDeleted: 4004,
  /** Another paired PC is already connected for this host: retry later. */
  busy: 4009,
} as const;

/** Converts the app's address (`https://host`) into the agent's paired WebSocket endpoint. */
export function bridgeDeviceWsUrl(server: string): string {
  const parsed = new URL(server.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Use um endereço http:// ou https://");
  return `${parsed.origin.replace(/^http/, "ws")}/ws/bridge`;
}

/**
 * The dashboard's download stamps each copy of `lantern-bridge.exe` with the
 * app's address and a fresh pairing code, appended after the last PE section
 * (where Windows ignores it): `<json><u32 LE json length><magic>`. One build
 * serves every account, and a copy pairs itself on first run.
 */
export const BRIDGE_STAMP_MAGIC = "LANTERN-BRIDGE-STAMP/1";

const bridgeStampSchema = z.object({
  server: z.string().url().max(500),
  code: z.string().max(32),
});
export type BridgeStamp = z.infer<typeof bridgeStampSchema>;

export function encodeBridgeStamp(stamp: BridgeStamp): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(stamp));
  const magic = new TextEncoder().encode(BRIDGE_STAMP_MAGIC);
  const out = new Uint8Array(json.length + 4 + magic.length);
  out.set(json, 0);
  new DataView(out.buffer).setUint32(json.length, json.length, true);
  out.set(magic, json.length + 4);
  return out;
}

/** Reads a stamp from the end of a file (pass at least its last few KB); null when there is none. */
export function decodeBridgeStamp(tail: Uint8Array): BridgeStamp | null {
  const magic = new TextEncoder().encode(BRIDGE_STAMP_MAGIC);
  if (tail.length < magic.length + 4) return null;
  const magicAt = tail.length - magic.length;
  for (let i = 0; i < magic.length; i++) if (tail[magicAt + i] !== magic[i]) return null;
  const length = new DataView(tail.buffer, tail.byteOffset, tail.byteLength).getUint32(magicAt - 4, true);
  const start = magicAt - 4 - length;
  if (length > 4096 || start < 0) return null;
  try {
    const parsed = bridgeStampSchema.safeParse(JSON.parse(new TextDecoder().decode(tail.subarray(start, magicAt - 4))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
