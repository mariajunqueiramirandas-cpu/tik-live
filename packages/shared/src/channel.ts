import { z } from "zod";
import { personaSchema, type Persona } from "./persona";

export const CHANNEL_SOURCES = ["tiktok", "simulator"] as const;
export type ChannelSource = (typeof CHANNEL_SOURCES)[number];

/** TikTok handles: 2-24 letters, digits, dots, underscores. A leading @ is accepted and removed. */
export const tiktokHandleSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, ""))
  .pipe(z.string().regex(/^[A-Za-z0-9._]{2,24}$/, "That doesn't look like a TikTok handle"));

export const voiceSettingsSchema = z.object({
  provider: z.enum(["elevenlabs", "none"]).default("none"),
  voiceId: z.string().trim().max(64).nullable().default(null),
});
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;

export const STRICTNESS = ["standard", "strict"] as const;

export const safetySettingsSchema = z.object({
  /** Terms that are never read from chat and never spoken. Case-insensitive. */
  blocklist: z.array(z.string().trim().toLowerCase().min(1).max(60)).max(500).default([]),
  /** "strict" also steers away from romance, horror, slang and edgy humor. */
  strictness: z.enum(STRICTNESS).default("standard"),
  /** Extra topics the host should steer away from. */
  avoidTopics: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
});
export type SafetySettings = z.infer<typeof safetySettingsSchema>;

export const DEFAULT_SAFETY: SafetySettings = { blocklist: [], strictness: "standard", avoidTopics: [] };
export const DEFAULT_VOICE: VoiceSettings = { provider: "none", voiceId: null };

/** Broadcast settings as the dashboard sees them. The stream key itself never leaves the server. */
export interface BroadcastDto {
  enabled: boolean;
  rtmpUrl: string | null;
  hasStreamKey: boolean;
  streamKeyLast4: string | null;
}

export const broadcastUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  rtmpUrl: z
    .string()
    .trim()
    .max(300)
    .regex(/^rtmps?:\/\/[^\s/]+(\/\S*)?$/i, "Use an rtmp:// or rtmps:// URL")
    .nullable()
    .optional(),
  /** Write-only. Send null to clear. */
  streamKey: z.string().trim().min(4).max(300).nullable().optional(),
});
export type BroadcastUpdate = z.infer<typeof broadcastUpdateSchema>;

export const channelCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  tiktokUsername: tiktokHandleSchema.nullable().optional(),
  presetId: z.string().max(40).optional(),
});
export type ChannelCreateInput = z.infer<typeof channelCreateSchema>;

export const channelUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  tiktokUsername: tiktokHandleSchema.nullable().optional(),
  source: z.enum(CHANNEL_SOURCES).optional(),
  persona: personaSchema.optional(),
  voice: voiceSettingsSchema.optional(),
  safety: safetySettingsSchema.optional(),
});
export type ChannelUpdateInput = z.infer<typeof channelUpdateSchema>;

export const RUNTIME_STATUSES = ["stopped", "starting", "standby", "live", "stopping", "failed"] as const;
export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];

export interface ChannelRuntimeSummary {
  status: RuntimeStatus;
  detail: string;
  viewers: number;
  since: string | null;
}

export interface ChannelDto {
  id: string;
  name: string;
  tiktokUsername: string | null;
  source: ChannelSource;
  persona: Persona;
  voice: VoiceSettings;
  safety: SafetySettings;
  broadcast: BroadcastDto;
  desiredState: "stopped" | "running";
  runtime: ChannelRuntimeSummary;
  stageUrl: string;
  createdAt: string;
  updatedAt: string;
}
