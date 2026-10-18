import { z } from "zod";
import { RUNTIME_STATUSES } from "./channel";
import { injectEventSchema } from "./events";
import { BOOST_KINDS, gameConfigSchema, gameSceneSchema, type GameStatus, type LoopRankingStatus, type SegmentGame } from "./game";
import { MUSIC_LIBRARY, musicTrackSchema, SOUNDS } from "./music";
import { effectSchema, emotionSchema, lookSchema } from "./persona";

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

/** What can come up next on the show: a segment, a segment's minigame, or the loop's podium. */
export const UP_NEXT_KINDS = ["segment", "game", "podium"] as const;
export type UpNextKind = (typeof UP_NEXT_KINDS)[number];
export const UP_NEXT_MAX = 4;
/** The stage's rankings: likes over the last 15 minutes, gifts (diamonds) over the last hour. */
export const LEADER_BOARDS = ["likes", "gifts"] as const;
export type LeaderBoard = (typeof LEADER_BOARDS)[number];
export const LEADERS_MAX = 5;
export interface LeaderRow {
  name: string;
  /** Likes, or diamonds for gifts. */
  value: number;
}

export const upNextItemSchema = z.object({
  kind: z.enum(UP_NEXT_KINDS),
  title: z.string().max(60),
  /** How long until it starts, from when the message arrives. 0 means any moment now. */
  inMs: z.number().min(0),
});
export type UpNextItem = z.infer<typeof upNextItemSchema>;
export type StageRole = (typeof STAGE_ROLES)[number];

export const SUPPORT_WAYS = ["like", "follow", "share", "gift"] as const;
export type SupportWay = (typeof SUPPORT_WAYS)[number];

/** How viewers can support the show: a title and one line per way, each with its icon. */
export const supportCardSchema = z.object({
  title: z.string().max(60),
  lines: z.array(z.object({ way: z.enum(SUPPORT_WAYS), text: z.string().max(40) })).min(1).max(4),
});
export type SupportCard = z.infer<typeof supportCardSchema>;

export const GOAL_KINDS = ["likes", "gifts"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/** One of the stream's goals: likes, or diamonds in gifts. `level` counts up each time one is reached (goal 1, goal 2...). */
export const goalViewSchema = z.object({
  kind: z.enum(GOAL_KINDS),
  value: z.number().int().min(0),
  target: z.number().int().min(1),
  level: z.number().int().min(1),
});
export type GoalView = z.infer<typeof goalViewSchema>;

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
    /** Reactions to play when the line starts. */
    fx: z.array(effectSchema).max(3).optional(),
  }),
  /** Audio for an upcoming line: fetch and decode it now so playback starts instantly. */
  z.object({ v, t: z.literal("prefetch"), audioUrl: z.string() }),
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
  /** A reaction on its own (a game win, a like milestone). `intensity` 1 is normal; up to 3 for big moments. */
  z.object({ v, t: z.literal("fx"), fx: effectSchema, intensity: z.number().min(0.25).max(3).optional() }),
  /** Music the stage synthesizes from its score, or null to stop (ADR-0024). Ducks under speech. */
  z.object({ v, t: z.literal("music"), track: musicTrackSchema.nullable() }),
  /** A short synthesized sound for a show moment. */
  z.object({ v, t: z.literal("sfx"), sound: z.enum(SOUNDS) }),
  /** A minigame's scene, or null to go back to the show's normal stage (ADR-0023). */
  z.object({ v, t: z.literal("game"), scene: gameSceneSchema.nullable() }),
  /** A gift just powered up the game round on screen, for everyone (ADR-0029). */
  z.object({ v, t: z.literal("boost"), boost: z.enum(BOOST_KINDS), by: z.string().max(40) }),
  /** Chat's vote on the last segment's game, with the live tally, or null when it closes (ADR-0029). */
  z.object({
    v,
    t: z.literal("vote"),
    vote: z
      .object({
        title: z.string().max(60),
        options: z.array(z.string().max(40)).min(2).max(3),
        tally: z.array(z.number().int().min(0)).max(3),
      })
      .nullable(),
  }),
  /** The "how to support the show" card, in the ranking card's place for a moment, or null to put the rankings back (ADR-0032). */
  z.object({ v, t: z.literal("support"), card: supportCardSchema.nullable() }),
  /** The stream's like and gift goals and how far along they are; an empty list hides them (ADR-0036). */
  z.object({ v, t: z.literal("goals"), goals: z.array(goalViewSchema).max(GOAL_KINDS.length) }),
  /** What's coming up on the show, soonest first, with times relative to receipt (ADR-0028). */
  z.object({ v, t: z.literal("schedule"), items: z.array(upNextItemSchema).max(UP_NEXT_MAX) }),
  /** Who gave the most in the last `windowMin` minutes, most first: likes, or diamonds in gifts (ADR-0028, ADR-0029). */
  z.object({
    v,
    t: z.literal("leaders"),
    board: z.enum(LEADER_BOARDS),
    windowMin: z.number().int().min(1).max(240),
    rows: z.array(z.object({ name: z.string().max(40), value: z.number().int().min(1) })).max(LEADERS_MAX),
  }),
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
  /** A line's audio started on this stage; `durationMs` is how long it really is. */
  z.object({ v: z.number(), t: z.literal("started"), id: z.string().max(64), durationMs: z.number().min(0).max(600_000) }),
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
  /** The run of show this loop plays (the automatic one when it's on, ADR-0035), with each segment's minigame. */
  segments: Array<{ id: string; title: string; game?: SegmentGame["kind"] }>;
  /** The minigame running now, if any. */
  game: GameStatus | null;
  /** What's coming up on the show, soonest first (estimates: segments wait for games and quiet moments). */
  upNext: Array<{ kind: UpNextKind; title: string; inSec: number }>;
  /** Top likers over the last 15 minutes and top gifters (diamonds) over the last hour, most first. */
  leaders: Record<LeaderBoard, LeaderRow[]>;
  /** Minigame points summed over this loop of the run of show. */
  ranking: LoopRankingStatus;
  /** The stream's like and gift goals, when the stage shows them (ADR-0036). */
  goals: GoalView[];
  /** Chat's vote on the last segment's game, while it's open. */
  vote: { segment: string; options: Array<{ label: string; votes: number }>; closesInSec: number } | null;
  /** The piece of music playing on stage, if any. */
  music: { title: string; endsInSec: number; byHost: boolean } | null;
  stats: { viewers: number; likes: number; diamonds: number; messages: number; follows: number; uptimeSec: number };
  nowSaying: { text: string; emotion: string } | null;
  queue: QueueItemSummary[];
  filtered: Record<string, number>;
  health: {
    source: { name: string; connected: boolean; detail: string };
    stages: { program: number; preview: number; broadcast: number };
    engine: { fps: number; frameP95: number; quality: number; renderer: string | null; error: string | null } | null;
    brain: {
      host: string;
      moderator: string | null;
      tts: string;
      /** The host's conversation: its size in tokens, and how much of recent turns' input came from the prompt cache. */
      context: { tokens: number; cachedPct: number } | null;
    };
    /**
     * From a viewer's event to the host's first line going on stage, with the
     * median of each stage: waiting for the turn, writing, voice, and the line
     * before it.
     */
    latency: {
      p50: number;
      p95: number;
      samples: number;
      stages?: { waitMs: number; writeMs: number; voiceMs: number; queueMs: number } | null;
    } | null;
    budget: { usedPct: number; limitTokensPerHour: number | null };
    /** Cloud broadcast, when it's turned on for this channel. */
    broadcast?: { state: "starting" | "live" | "retrying" | "failed" | "stopped"; detail: string; bitrateKbps: number | null } | null;
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
  /** Sent right after the snapshot: recent lines and events, oldest first, so the room isn't empty on reload. */
  | { v: 1; t: "history"; transcript: TranscriptLine[]; events: LiveEventSummary[] }
  | { v: 1; t: "transcript"; line: TranscriptLine }
  | { v: 1; t: "live-event"; event: LiveEventSummary }
  | { v: 1; t: "log"; level: "info" | "warn" | "error"; msg: string; at: number }
  | { v: 1; t: "notice"; level: "info" | "warn" | "error"; code: string; message: string; at: number }
  | { v: 1; t: "ack"; id: string; ok: boolean; error?: string };

type StudioPayloadOf<T> = T extends unknown ? Omit<T, "v"> : never;
export type StudioServerPayload = StudioPayloadOf<StudioServerMessage>;

/** Every studio message type, for docs and contract tests; the check below fails to compile if one is missing. */
export const STUDIO_SERVER_MESSAGE_TYPES = ["snapshot", "patch", "history", "transcript", "live-event", "log", "notice", "ack"] as const;
type MissingStudioType = Exclude<StudioServerMessage["t"], (typeof STUDIO_SERVER_MESSAGE_TYPES)[number]>;
const _allStudioTypesListed: [MissingStudioType] extends [never] ? true : MissingStudioType = true;
void _allStudioTypesListed;

// ---------------------------------------------------------------------------
// Studio: studio -> server

export const studioCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pause") }),
  z.object({ kind: z.literal("resume") }),
  z.object({ kind: z.literal("skip") }),
  z.object({ kind: z.literal("say"), text: z.string().trim().min(1).max(300) }),
  z.object({ kind: z.literal("segment"), id: z.string().max(40) }),
  z.object({ kind: z.literal("inject"), event: injectEventSchema }),
  z.object({ kind: z.literal("game_start"), game: gameConfigSchema }),
  z.object({ kind: z.literal("game_stop") }),
  /** Plays a piece from the library, or asks the host to compose one from a prompt. */
  z.object({
    kind: z.literal("music_play"),
    library: z.string().refine((id) => id in MUSIC_LIBRARY, "Música desconhecida").optional(),
    prompt: z.string().trim().min(1).max(120).optional(),
  }),
  z.object({ kind: z.literal("music_stop") }),
  /** Clears the stage (speech, game, podium, music) and restarts the stream's counters and leaderboards. */
  z.object({ kind: z.literal("reset") }),
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
