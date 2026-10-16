import { z } from "zod";
import { RUNTIME_STATUSES } from "./channel";
import { injectEventSchema } from "./events";
import { emotionSchema, lookSchema } from "./persona";

/**
 * Realtime protocol (ADR-0008). Every message carries `v` (protocol version)
 * and `t` (type). The server validates every inbound message and speaks the
 * current and previous version.
 */
export const PROTOCOL_VERSION = 1;

const v = z.literal(PROTOCOL_VERSION);

// ---------------------------------------------------------------------------
// Stage: server -> stage

export const STAGE_ROLES = ["program", "preview", "broadcast"] as const;
export type StageRole = (typeof STAGE_ROLES)[number];

export const stageServerMessageSchema = z.discriminatedUnion("t", [
  z.object({
    v,
    t: z.literal("hello"),
    serverTime: z.number(),
    name: z.string(),
    look: lookSchema,
    disclosure: z.string(),
    /** Set when the client speaks an unsupported version: reload the page. */
    reload: z.boolean().optional(),
  }),
  z.object({
    v,
    t: z.literal("speak"),
    id: z.string(),
    text: z.string(),
    emotion: emotionSchema,
    audioUrl: z.string().nullable(),
    durationMs: z.number(),
  }),
  z.object({ v, t: z.literal("stop") }),
  z.object({
    v,
    t: z.literal("alert"),
    kind: z.enum(["gift", "follow", "share"]),
    name: z.string(),
    giftName: z.string().optional(),
    count: z.number().optional(),
    diamonds: z.number().optional(),
  }),
  z.object({ v, t: z.literal("segment"), title: z.string() }),
  z.object({ v, t: z.literal("stats"), viewers: z.number(), likes: z.number() }),
  z.object({ v, t: z.literal("look"), name: z.string(), look: lookSchema }),
  /** The server is restarting: keep the last frame and reconnect quietly. */
  z.object({ v, t: z.literal("hold") }),
]);

export type StageServerMessage = z.infer<typeof stageServerMessageSchema>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type StageServerPayload = DistributiveOmit<StageServerMessage, "v">;

// ---------------------------------------------------------------------------
// Stage: stage -> server

export const stageClientMessageSchema = z.discriminatedUnion("t", [
  z.object({
    v: z.number(),
    t: z.literal("ready"),
    role: z.enum(STAGE_ROLES),
    engine: z.string().max(40),
    caps: z.object({ webgl2: z.boolean(), audio: z.boolean() }),
  }),
  z.object({ v: z.number(), t: z.literal("spoken"), id: z.string().max(64) }),
  z.object({
    v: z.number(),
    t: z.literal("telemetry"),
    fps: z.number().min(0).max(1000),
    frameP95: z.number().min(0).max(10_000),
    quality: z.number().int().min(0).max(3),
    renderer: z.string().max(200).optional(),
    error: z.string().max(500).optional(),
  }),
]);

export type StageClientMessage = z.infer<typeof stageClientMessageSchema>;

// ---------------------------------------------------------------------------
// Studio state

export interface QueueItemSummary {
  kind: string;
  who: string;
  text: string;
  priority: number;
}

export interface RuntimeSnapshot {
  status: (typeof RUNTIME_STATUSES)[number];
  detail: string;
  paused: boolean;
  /** Waiting for TikTok to report the account live (no AI calls). */
  standby: boolean;
  /** A host turn is being generated right now. */
  thinking: boolean;
  /** The host only reacts to events (budget exhausted or nobody watching). */
  reactOnly: boolean;
  segment: { id: string; title: string; endsInSec: number };
  segments: Array<{ id: string; title: string }>;
  stats: { viewers: number; likes: number; diamonds: number; messages: number; follows: number; uptimeSec: number };
  nowSaying: { text: string; emotion: string } | null;
  queue: QueueItemSummary[];
  filtered: Record<string, number>;
  health: {
    source: { name: string; connected: boolean; detail: string };
    stages: { program: number; preview: number; broadcast: number };
    engine: { fps: number; frameP95: number; quality: number; renderer: string | null; error: string | null } | null;
    brain: { host: string; moderator: string | null; tts: string };
    latency: { p50: number; p95: number; samples: number } | null;
    budget: { usedPct: number; limitTokensPerHour: number | null };
  };
  session: { id: string; startedAt: string } | null;
}

export interface TranscriptLine {
  id: string;
  at: number;
  text: string;
  emotion: string;
  status: "spoken" | "blocked";
  reason?: string;
  operator?: boolean;
}

export interface LiveEventSummary {
  id: string;
  at: number;
  kind: "chat" | "question" | "gift" | "follow" | "share" | "join";
  who: string;
  text?: string;
  giftName?: string;
  count?: number;
  diamonds?: number;
  /** Why triage dropped it, if it did. */
  filtered?: string;
}

// ---------------------------------------------------------------------------
// Studio: server -> studio

export type StudioServerMessage =
  | { v: 1; t: "snapshot"; state: RuntimeSnapshot }
  | { v: 1; t: "patch"; state: Partial<RuntimeSnapshot> }
  | { v: 1; t: "transcript"; line: TranscriptLine }
  | { v: 1; t: "live-event"; event: LiveEventSummary }
  | { v: 1; t: "log"; level: "info" | "warn" | "error"; msg: string; at: number }
  | { v: 1; t: "notice"; level: "info" | "warn" | "error"; code: string; message: string; at: number }
  | { v: 1; t: "ack"; id: string; ok: boolean; error?: string };

type StudioPayloadOf<T> = T extends unknown ? Omit<T, "v"> : never;
export type StudioServerPayload = StudioPayloadOf<StudioServerMessage>;

// ---------------------------------------------------------------------------
// Studio: studio -> server

export const studioCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pause") }),
  z.object({ kind: z.literal("resume") }),
  z.object({ kind: z.literal("skip") }),
  z.object({ kind: z.literal("say"), text: z.string().trim().min(1).max(300) }),
  z.object({ kind: z.literal("segment"), id: z.string().max(40) }),
  z.object({ kind: z.literal("inject"), event: injectEventSchema }),
]);

export type StudioCommand = z.infer<typeof studioCommandSchema>;

export const studioClientMessageSchema = z.object({
  v: z.number(),
  t: z.literal("command"),
  id: z.string().min(1).max(64),
  command: studioCommandSchema,
});

export type StudioClientMessage = z.infer<typeof studioClientMessageSchema>;

/** Parses untrusted JSON text against a schema; never throws. */
export function parseMessage<T>(schema: z.ZodType<T>, raw: unknown): T | undefined {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const result = schema.safeParse(data);
  return result.success ? result.data : undefined;
}
