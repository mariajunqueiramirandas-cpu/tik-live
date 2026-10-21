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
  highlight: "com.tiktok.livestudio.highlight",
  recording: "com.tiktok.livestudio.recording",
  scene: "com.tiktok.livestudio.scene",
  source: "com.tiktok.livestudio.source",
  vibe: "com.tiktok.livestudio.vibe",
  cameraEffects: "com.tiktok.livestudio.cameraeffects",
} as const;

export const LIVE_STUDIO_STREAM_STATUSES = ["stopped", "paused", "live"] as const;
export type LiveStudioStreamStatus = (typeof LIVE_STUDIO_STREAM_STATUSES)[number];

export const liveStudioSceneSourceSchema = z.object({
  id: z.string().max(200),
  label: z.string().max(200),
  visible: z.boolean(),
});
export type LiveStudioSceneSource = z.infer<typeof liveStudioSceneSourceSchema>;

export const liveStudioSceneItemSchema = z.object({
  name: z.string().max(200),
  sources: z.array(liveStudioSceneSourceSchema).max(60),
});
export type LiveStudioSceneItem = z.infer<typeof liveStudioSceneItemSchema>;

export const liveStudioVibeItemSchema = z.object({
  id: z.string().max(200),
  name: z.string().max(200),
});
export type LiveStudioVibeItem = z.infer<typeof liveStudioVibeItemSchema>;

export const liveStudioCameraEffectsSchema = z.object({
  sources: z
    .array(
      z.object({
        id: z.string().max(200),
        label: z.string().max(200),
        isDefault: z.boolean().optional(),
        effectId: z.string().max(200).nullable().optional(),
      }),
    )
    .max(20),
  types: z.array(z.string().max(100)).max(20),
  categories: z
    .array(
      z.object({
        key: z.string().max(100),
        name: z.string().max(200),
        effects: z.array(z.object({ id: z.string().max(200), label: z.string().max(200) })).max(100),
      }),
    )
    .max(20),
});
export type LiveStudioCameraEffects = z.infer<typeof liveStudioCameraEffectsSchema>;

export const liveStudioProbeSchema = z.object({
  connected: z.boolean(),
  port: z.number().int().nullable(),
  streamStatus: z.enum(LIVE_STUDIO_STREAM_STATUSES).nullable(),
  scene: z.string().max(200).nullable(),
  installed: z.boolean(),
  executablePath: z.string().max(500).nullable(),
  recording: z.boolean().optional(),
  highlightAble: z.boolean().optional(),
  sceneList: z.array(liveStudioSceneItemSchema).max(50).optional(),
  vibeList: z.array(liveStudioVibeItemSchema).max(50).optional(),
  playingVibe: z.string().max(200).nullable().optional(),
  cameraEffects: liveStudioCameraEffectsSchema.nullable().optional(),
  tiktokUsername: z.string().max(100).nullable().optional(),
  stageInjected: z.boolean().optional(),
  /** The URL our stage source points at in Studio's saved scenes, so the dashboard can tell a stale one. */
  stageSourceUrl: z.string().max(500).nullable().optional(),
  /** A stage source is waiting to be saved: Studio overwrites its scene file while open, so it's written once Studio closes. */
  stagePending: z.boolean().optional(),
  /** Studio is open (its process or its control port), even when it isn't answering yet. */
  running: z.boolean().optional(),
  /** Studio refused our connection: it asks for Stream Deck token auth, which the agent can't provide. */
  authRequired: z.boolean().optional(),
});
export type LiveStudioProbe = z.infer<typeof liveStudioProbeSchema>;

const PROBE_BUDGET_CHARS = 12_000;

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/**
 * Trims a probe to the schema's limits and to a size that fits a bridge
 * message (16 KB), so a creator with a big Studio setup gets a shorter list
 * instead of a status the server throws away.
 */
export function fitLiveStudioProbe(probe: LiveStudioProbe): LiveStudioProbe {
  const fitted: LiveStudioProbe = {
    ...probe,
    scene: probe.scene === null ? null : clip(probe.scene, 200),
    executablePath: probe.executablePath === null ? null : clip(probe.executablePath, 500),
    ...(probe.sceneList
      ? {
          sceneList: probe.sceneList.slice(0, 50).map((scene) => ({
            name: clip(scene.name, 200),
            sources: scene.sources.slice(0, 60).map((source) => ({ id: clip(source.id, 200), label: clip(source.label, 200), visible: source.visible })),
          })),
        }
      : {}),
    ...(probe.vibeList ? { vibeList: probe.vibeList.slice(0, 50).map((vibe) => ({ id: clip(vibe.id, 200), name: clip(vibe.name, 200) })) } : {}),
    ...(probe.playingVibe ? { playingVibe: clip(probe.playingVibe, 200) } : {}),
    ...(probe.cameraEffects
      ? {
          cameraEffects: {
            sources: probe.cameraEffects.sources.slice(0, 20).map((source) => ({
              ...source,
              id: clip(source.id, 200),
              label: clip(source.label, 200),
              ...(source.effectId ? { effectId: clip(source.effectId, 200) } : {}),
            })),
            types: probe.cameraEffects.types.slice(0, 20).map((type) => clip(type, 100)),
            categories: probe.cameraEffects.categories.slice(0, 20).map((category) => ({
              key: clip(category.key, 100),
              name: clip(category.name, 200),
              effects: category.effects.slice(0, 100).map((effect) => ({ id: clip(effect.id, 200), label: clip(effect.label, 200) })),
            })),
          },
        }
      : {}),
    ...(probe.tiktokUsername ? { tiktokUsername: clip(probe.tiktokUsername, 100) } : {}),
    ...(probe.stageSourceUrl && probe.stageSourceUrl.length > 500 ? { stageSourceUrl: null } : {}),
  };
  // Still too big: shed the longest lists, least useful first.
  const size = () => JSON.stringify(fitted).length;
  if (size() > PROBE_BUDGET_CHARS && fitted.cameraEffects) {
    fitted.cameraEffects = {
      ...fitted.cameraEffects,
      categories: fitted.cameraEffects.categories.map((category) => ({ ...category, effects: category.effects.slice(0, 12) })),
    };
  }
  if (size() > PROBE_BUDGET_CHARS && fitted.cameraEffects) fitted.cameraEffects = null;
  if (size() > PROBE_BUDGET_CHARS && fitted.sceneList) {
    // Keep every scene's name, but only the current scene's sources.
    fitted.sceneList = fitted.sceneList.map((scene) => (scene.name === fitted.scene ? scene : { ...scene, sources: [] }));
  }
  if (size() > PROBE_BUDGET_CHARS && fitted.vibeList) fitted.vibeList = fitted.vibeList.slice(0, 10);
  return fitted;
}

export const BRIDGE_ACTIONS = [
  "probe",
  "start",
  "stop",
  "launch",
  "highlight",
  "recording",
  "scene",
  "source",
  "vibe",
  "camera_effect",
  "inject_stage",
] as const;
export type BridgeAction = (typeof BRIDGE_ACTIONS)[number];

export const bridgeActionParamsSchema = z.object({
  scene: z.string().max(200).optional(),
  sourceId: z.string().max(200).optional(),
  vibeId: z.string().max(200).optional(),
  cameraSource: z.string().max(200).optional(),
  cameraEffectType: z.string().max(200).optional(),
  cameraEffectId: z.string().max(200).optional(),
  stageUrl: z.string().url().max(500).optional(),
});
export type BridgeActionParams = z.infer<typeof bridgeActionParamsSchema>;

export const liveStudioActionRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("highlight") }),
  z.object({ action: z.literal("recording") }),
  z.object({ action: z.literal("scene"), scene: z.string().trim().min(1).max(200) }),
  z.object({
    action: z.literal("source"),
    scene: z.string().trim().min(1).max(200).optional(),
    sourceId: z.string().trim().min(1).max(200),
  }),
  z.object({ action: z.literal("vibe"), vibeId: z.string().trim().min(1).max(200) }),
  z.object({
    action: z.literal("camera_effect"),
    cameraSource: z.string().trim().max(200).optional(),
    cameraEffectType: z.string().trim().min(1).max(200),
    cameraEffectId: z.string().trim().min(1).max(200),
  }),
  z.object({ action: z.literal("inject_stage") }),
  z.object({ action: z.literal("sync_handle") }),
]);
export type LiveStudioActionRequest = z.infer<typeof liveStudioActionRequestSchema>;

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
    params: bridgeActionParamsSchema.optional(),
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
  /** Another connection for the same host took this one's place (the same PC opened the agent twice): stop, don't fight it. */
  replaced: 4000,
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
