import { z } from "zod";
import { isTimeZone, personaSchema, timeZoneSchema, type Persona } from "./persona";

export const CHANNEL_SOURCES = ["tiktok", "simulator"] as const;
export type ChannelSource = (typeof CHANNEL_SOURCES)[number];

/** TikTok handles: 2-24 letters, digits, dots, underscores. A leading @ is accepted and removed. */
export const tiktokHandleSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, ""))
  .pipe(z.string().regex(/^[A-Za-z0-9._]{2,24}$/, "Isso não parece um usuário do TikTok"));

export const voiceSettingsSchema = z.object({
  provider: z.enum(["fish", "elevenlabs", "pocket", "none"]).default("none"),
  voiceId: z.string().trim().max(64).nullable().default(null),
});
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;

/**
 * "spicy" ("sem filtro", ADR-0040): the host has a strong opinion about
 * everything, politics and religion included, roasts and swears a little.
 * Hate, slurs and electoral campaigning stay out in every mode.
 */
export const STRICTNESS = ["standard", "strict", "spicy"] as const;
export type Strictness = (typeof STRICTNESS)[number];
export const GIFT_ASKS = ["light", "active"] as const;
export type GiftAsks = (typeof GIFT_ASKS)[number];

export const safetySettingsSchema = z.object({
  /** Terms that are never read from chat and never spoken. Case-insensitive. */
  blocklist: z.array(z.string().trim().toLowerCase().min(1).max(60)).max(500).default([]),
  /** "strict" also steers away from romance, horror, slang and edgy humor; "spicy" opens up opinions on everything. */
  strictness: z.enum(STRICTNESS).default("standard"),
  /** Extra topics the host should steer away from. */
  avoidTopics: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  /**
   * How the host asks for gifts (ADR-0032). "light" (the default when
   * unset): it explains now and then how people can support the show.
   * "active": it asks for gifts directly and often, and offers playful
   * rewards on stream for them.
   */
  giftAsks: z.enum(GIFT_ASKS).optional(),
  /**
   * Gift powers (ADR-0039): a gift of so many diamonds unlocks something on
   * the show (cut the line, pick the next game, an anthem, "dono da live").
   * On when unset.
   */
  giftPerks: z.boolean().optional(),
});
export type SafetySettings = z.infer<typeof safetySettingsSchema>;

export const DEFAULT_SAFETY: SafetySettings = { blocklist: [], strictness: "standard", avoidTopics: [] };
export const DEFAULT_VOICE: VoiceSettings = { provider: "none", voiceId: null };

export const timeOfDaySchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use o formato HH:MM (ex.: 20:00)");

export const streamScheduleSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Start time in 24h "HH:MM" format in the schedule's or channel's time zone. */
    startTime: timeOfDaySchema.default("20:00"),
    /** End time in 24h "HH:MM" format. When earlier than startTime, crosses midnight into the next day. */
    endTime: timeOfDaySchema.default("23:00"),
    /** Days of the week (0 = Sunday .. 6 = Saturday) on which the stream starts. */
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1, "Escolha pelo menos um dia da semana")
      .max(7)
      .default([0, 1, 2, 3, 4, 5, 6])
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    /** Optional IANA time zone override; falls back to channel.persona.timezone or America/Sao_Paulo. */
    timezone: timeZoneSchema.optional(),
  })
  .refine((s) => s.startTime !== s.endTime, {
    message: "O horário de início e de término precisam ser diferentes",
    path: ["endTime"],
  });
export type StreamSchedule = z.infer<typeof streamScheduleSchema>;

export const DEFAULT_STREAM_SCHEDULE: StreamSchedule = {
  enabled: false,
  startTime: "20:00",
  endTime: "23:00",
  days: [0, 1, 2, 3, 4, 5, 6],
};

export interface StreamScheduleEvaluation {
  inWindow: boolean;
  /** Unique identifier for the active window instance, or null when outside the window. */
  windowKey: string | null;
  timezone: string;
  localTime: string;
  localWeekday: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function parseTimeOfDayMinutes(hhmm: string): number {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr ?? 0);
  const m = Number(mStr ?? 0);
  return h * 60 + m;
}

function localPartsInZone(at: Date, timezone: string): { dateKey: string; weekday: number; minutes: number; localTime: string } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hourStr = get("hour") === "24" ? "00" : get("hour");
  const minuteStr = get("minute");
  const weekday = WEEKDAY_MAP[get("weekday")] ?? 0;
  const minutes = Number(hourStr) * 60 + Number(minuteStr);
  return {
    dateKey: `${year}-${month}-${day}`,
    weekday,
    minutes,
    localTime: `${hourStr}:${minuteStr}`,
  };
}

/**
 * Evaluates whether `at` falls inside the configured `schedule` window in the
 * schedule's (or channel's) time zone, including overnight schedules that cross midnight.
 */
export function evaluateStreamSchedule(
  schedule: StreamSchedule | null | undefined,
  at: Date = new Date(),
  fallbackTimeZone?: string,
): StreamScheduleEvaluation {
  const rawZone = schedule?.timezone ?? fallbackTimeZone ?? "America/Sao_Paulo";
  const timezone = isTimeZone(rawZone) ? rawZone : "America/Sao_Paulo";
  const nowParts = localPartsInZone(at, timezone);

  if (!schedule || !schedule.enabled || schedule.days.length === 0) {
    return {
      inWindow: false,
      windowKey: null,
      timezone,
      localTime: nowParts.localTime,
      localWeekday: nowParts.weekday,
    };
  }

  const startMinutes = parseTimeOfDayMinutes(schedule.startTime);
  const endMinutes = parseTimeOfDayMinutes(schedule.endTime);
  const days = new Set(schedule.days);

  if (startMinutes < endMinutes) {
    // Same-day window (e.g. 14:00 -> 18:00)
    const inWindow = days.has(nowParts.weekday) && nowParts.minutes >= startMinutes && nowParts.minutes < endMinutes;
    return {
      inWindow,
      windowKey: inWindow ? `${nowParts.dateKey}:${schedule.startTime}-${schedule.endTime}` : null,
      timezone,
      localTime: nowParts.localTime,
      localWeekday: nowParts.weekday,
    };
  }

  // Overnight window crossing midnight (e.g. 22:00 -> 02:00)
  if (nowParts.minutes >= startMinutes) {
    const inWindow = days.has(nowParts.weekday);
    return {
      inWindow,
      windowKey: inWindow ? `${nowParts.dateKey}:${schedule.startTime}-${schedule.endTime}` : null,
      timezone,
      localTime: nowParts.localTime,
      localWeekday: nowParts.weekday,
    };
  }

  if (nowParts.minutes < endMinutes) {
    // Started on the previous local calendar day
    const prevInstant = new Date(at.getTime() - (nowParts.minutes + 120) * 60_000);
    const prevParts = localPartsInZone(prevInstant, timezone);
    const inWindow = days.has(prevParts.weekday);
    return {
      inWindow,
      windowKey: inWindow ? `${prevParts.dateKey}:${schedule.startTime}-${schedule.endTime}` : null,
      timezone,
      localTime: nowParts.localTime,
      localWeekday: nowParts.weekday,
    };
  }

  return {
    inWindow: false,
    windowKey: null,
    timezone,
    localTime: nowParts.localTime,
    localWeekday: nowParts.weekday,
  };
}

/** Broadcast settings as the dashboard sees them. The stream key itself never leaves the server. */
export interface BroadcastDto {
  enabled: boolean;
  rtmpUrl: string | null;
  hasStreamKey: boolean;
  streamKeyLast4: string | null;
  /** Start and stop the stream automatically in the local TikTok LIVE Studio app. */
  liveStudio?: boolean;
  /** Optional recurring stream hours schedule. */
  schedule?: StreamSchedule;
}

export const broadcastUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  rtmpUrl: z
    .string()
    .trim()
    .max(300)
    .regex(/^rtmps?:\/\/[^\s/]+(\/\S*)?$/i, "Use um endereço rtmp:// ou rtmps://")
    .nullable()
    .optional(),
  /** Write-only. Send null to clear. */
  streamKey: z.string().trim().min(4).max(300).nullable().optional(),
  /** Start and stop the stream automatically in the local TikTok LIVE Studio app. */
  liveStudio: z.boolean().optional(),
  /** Recurring stream hours schedule. Send null to clear. */
  schedule: streamScheduleSchema.nullable().optional(),
});
export type BroadcastUpdate = z.infer<typeof broadcastUpdateSchema>;

export const channelCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  tiktokUsername: tiktokHandleSchema.nullable().optional(),
  presetId: z.string().max(40).optional(),
  /** The creator's time zone (from their browser), so the host knows the local time. */
  timezone: timeZoneSchema.optional(),
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

/** The most recent stream, for the channel list's sparkline. */
export interface LastStreamDto {
  startedAt: string;
  endedAt: string | null;
  peakViewers: number;
  diamonds: number;
  /** Viewers per sample, downsampled to at most 32 points. */
  viewers: number[];
}

export type ChannelListItem = ChannelDto & { lastStream: LastStreamDto | null };

/** Evenly downsamples a series (keeps the first and last points). */
export function downsample(values: readonly number[], max: number): number[] {
  if (values.length <= max) return [...values];
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(values[Math.round((i * (values.length - 1)) / (max - 1))] as number);
  return out;
}
