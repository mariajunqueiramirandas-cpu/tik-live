import type { ChannelSource, Persona, SafetySettings, StreamSchedule, VoiceSettings } from "@tik-live/shared";
import type { SegmentScore } from "../runtime/segment-scores";
import {
  bigserial,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Our own user record, mapped from the identity provider (ADR-0018). */
export const appUser = pgTable("app_user", {
  id: uuid("id").primaryKey(),
  externalId: text("external_id").notNull().unique(),
  email: text("email"),
  name: text("name"),
  createdAt: createdAt(),
});

/** Broadcast settings as stored; the stream key is encrypted (ADR-0016). */
export interface StoredBroadcast {
  enabled: boolean;
  rtmpUrl: string | null;
  streamKeyCiphertext: string | null;
  streamKeyLast4: string | null;
  /** Start and stop the stream automatically in the local TikTok LIVE Studio app. */
  liveStudio?: boolean;
  /** Optional recurring stream hours schedule. */
  schedule?: StreamSchedule;
}

export const channel = pgTable(
  "channel",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tiktokUsername: text("tiktok_username"),
    source: text("source").$type<ChannelSource>().notNull().default("simulator"),
    persona: jsonb("persona").$type<Persona>().notNull(),
    voice: jsonb("voice").$type<VoiceSettings>().notNull(),
    safety: jsonb("safety").$type<SafetySettings>().notNull(),
    broadcast: jsonb("broadcast").$type<StoredBroadcast>().notNull(),
    desiredState: text("desired_state").$type<"stopped" | "running">().notNull().default("stopped"),
    stageKeyLookup: text("stage_key_lookup").notNull().unique(),
    stageKeyCiphertext: text("stage_key_ciphertext").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("channel_owner_idx").on(t.ownerId), index("channel_desired_state_idx").on(t.desiredState)],
);

export const viewer = pgTable(
  "viewer",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    platformUserId: text("platform_user_id").notNull(),
    handle: text("handle").notNull(),
    nickname: text("nickname").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    visits: integer("visits").notNull().default(1),
    messages: integer("messages").notNull().default(0),
    diamonds: integer("diamonds").notNull().default(0),
    gifts: jsonb("gifts").$type<Record<string, number>>().notNull().default({}),
    follows: integer("follows").notNull().default(0),
    shares: integer("shares").notNull().default(0),
    recentLines: jsonb("recent_lines").$type<string[]>().notNull().default([]),
    notes: jsonb("notes").$type<string[]>().notNull().default([]),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.platformUserId] }),
    index("viewer_top_supporters_idx").on(t.channelId, t.diamonds.desc()),
    index("viewer_last_seen_idx").on(t.channelId, t.lastSeenAt.desc()),
  ],
);

/** What the host has said about itself on a channel (ADR-0033), so it stays the same character across streams. */
export const hostMemory = pgTable("host_memory", {
  channelId: uuid("channel_id")
    .primaryKey()
    .references(() => channel.id, { onDelete: "cascade" }),
  facts: jsonb("facts").$type<Array<{ topic: string; fact: string; at: number }>>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/** Which segments pull viewers, likes and gifts on a channel (ADR-0044), so the show leans toward them. */
export const segmentScores = pgTable("segment_scores", {
  channelId: uuid("channel_id")
    .primaryKey()
    .references(() => channel.id, { onDelete: "cascade" }),
  scores: jsonb("scores").$type<SegmentScore[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/**
 * A one-time code that pairs a Local Bridge Agent with a channel (ADR-0047).
 * Stored by HMAC lookup, like stage keys; claiming deletes the row.
 */
export const bridgePairing = pgTable(
  "bridge_pairing",
  {
    codeLookup: text("code_lookup").primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("bridge_pairing_expires_idx").on(t.expiresAt)],
);

/** A PC paired with a channel; its agent connects with the token whose HMAC is `tokenLookup`. */
export const bridgeDevice = pgTable(
  "bridge_device",
  {
    id: uuid("id").primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenLookup: text("token_lookup").notNull().unique(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("bridge_device_channel_idx").on(t.channelId)],
);

export const streamSession = pgTable(
  "stream_session",
  {
    id: uuid("id").primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: text("end_reason"),
    source: text("source").$type<ChannelSource>().notNull(),
    peakViewers: integer("peak_viewers").notNull().default(0),
    likes: integer("likes").notNull().default(0),
    diamonds: integer("diamonds").notNull().default(0),
    gifts: integer("gifts").notNull().default(0),
    messages: integer("messages").notNull().default(0),
    follows: integer("follows").notNull().default(0),
    shares: integer("shares").notNull().default(0),
    joins: integer("joins").notNull().default(0),
    turns: integer("turns").notNull().default(0),
    spokenLines: integer("spoken_lines").notNull().default(0),
    blockedLines: integer("blocked_lines").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    ttsCharacters: integer("tts_characters").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    /** What happened on the show, from the host's chronicler (ADR-0026); the next stream's opening reads it. */
    summary: text("summary"),
  },
  (t) => [index("stream_session_channel_idx").on(t.channelId, t.startedAt.desc())],
);

export const sessionSample = pgTable(
  "session_sample",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => streamSession.id, { onDelete: "cascade" }),
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    viewers: integer("viewers").notNull().default(0),
    likes: integer("likes").notNull().default(0),
    messages: integer("messages").notNull().default(0),
    diamonds: integer("diamonds").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.minute] })],
);

export const utterance = pgTable(
  "utterance",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => streamSession.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    text: text("text").notNull(),
    emotion: text("emotion").notNull(),
    status: text("status").$type<"spoken" | "blocked">().notNull(),
    reason: text("reason"),
    turnKind: text("turn_kind"),
  },
  (t) => [index("utterance_session_idx").on(t.sessionId, t.at), index("utterance_channel_at_idx").on(t.channelId, t.at)],
);

/** Metering (ADR-0012). `channel_id` is not a foreign key so usage survives channel deletion. */
export const usageDaily = pgTable(
  "usage_daily",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    llmRequests: integer("llm_requests").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    moderationRequests: integer("moderation_requests").notNull().default(0),
    ttsCharacters: integer("tts_characters").notNull().default(0),
    runtimeSeconds: integer("runtime_seconds").notNull().default(0),
    broadcastSeconds: integer("broadcast_seconds").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channelId, t.day] })],
);

/** Billing state mirrored from Mercado Pago; the only source the app reads for entitlements. */
export const subscription = pgTable("subscription", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => appUser.id, { onDelete: "cascade" }),
  plan: text("plan").notNull(),
  status: text("status").$type<"pending" | "authorized" | "paused" | "cancelled">().notNull(),
  provider: text("provider").notNull().default("mercadopago"),
  providerSubscriptionId: text("provider_subscription_id").unique(),
  amount: doublePrecision("amount"),
  currency: text("currency"),
  nextPaymentAt: timestamp("next_payment_at", { withTimezone: true }),
  lastPaymentAt: timestamp("last_payment_at", { withTimezone: true }),
  lastPaymentStatus: text("last_payment_status"),
  graceUntil: timestamp("grace_until", { withTimezone: true }),
  updatedAt: updatedAt(),
});

/** Webhook idempotency. */
export const billingEvent = pgTable("billing_event", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb("payload").$type<unknown>().notNull(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id"),
    action: text("action").notNull(),
    target: text("target"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_user_idx").on(t.userId, t.at.desc())],
);

export const schema = {
  appUser,
  channel,
  viewer,
  streamSession,
  sessionSample,
  utterance,
  usageDaily,
  subscription,
  billingEvent,
  auditLog,
  bridgePairing,
  bridgeDevice,
} as const;

export type Schema = typeof schema;
