import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { usageDaily } from "../db/schema";

export type UsageRow = typeof usageDaily.$inferSelect;
export type UsageDelta = Omit<UsageRow, "userId" | "channelId" | "day">;

export const EMPTY_USAGE: UsageDelta = {
  llmRequests: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  moderationRequests: 0,
  ttsCharacters: 0,
  runtimeSeconds: 0,
  broadcastSeconds: 0,
  costUsd: 0,
};

/** Adds increments to today's row (created if missing). */
export async function addUsage(db: Db, key: { userId: string; channelId: string; day: string }, delta: UsageDelta): Promise<void> {
  const inc = (column: keyof UsageDelta) => sql.raw(`usage_daily.${snake(column)} + excluded.${snake(column)}`);
  await db
    .insert(usageDaily)
    .values({ ...key, ...delta })
    .onConflictDoUpdate({
      target: [usageDaily.userId, usageDaily.channelId, usageDaily.day],
      set: {
        llmRequests: inc("llmRequests"),
        inputTokens: inc("inputTokens"),
        cacheReadTokens: inc("cacheReadTokens"),
        cacheWriteTokens: inc("cacheWriteTokens"),
        outputTokens: inc("outputTokens"),
        moderationRequests: inc("moderationRequests"),
        ttsCharacters: inc("ttsCharacters"),
        runtimeSeconds: inc("runtimeSeconds"),
        broadcastSeconds: inc("broadcastSeconds"),
        costUsd: inc("costUsd"),
      },
    });
}

/** Totals for a user since `fromDay` (inclusive, YYYY-MM-DD). */
export async function usageSince(db: Db, userId: string, fromDay: string): Promise<UsageDelta> {
  const [row] = await db
    .select({
      llmRequests: sql<number>`coalesce(sum(${usageDaily.llmRequests}), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${usageDaily.inputTokens}), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum(${usageDaily.cacheReadTokens}), 0)::int`,
      cacheWriteTokens: sql<number>`coalesce(sum(${usageDaily.cacheWriteTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${usageDaily.outputTokens}), 0)::int`,
      moderationRequests: sql<number>`coalesce(sum(${usageDaily.moderationRequests}), 0)::int`,
      ttsCharacters: sql<number>`coalesce(sum(${usageDaily.ttsCharacters}), 0)::int`,
      runtimeSeconds: sql<number>`coalesce(sum(${usageDaily.runtimeSeconds}), 0)::int`,
      broadcastSeconds: sql<number>`coalesce(sum(${usageDaily.broadcastSeconds}), 0)::int`,
      costUsd: sql<number>`coalesce(sum(${usageDaily.costUsd}), 0)::float8`,
    })
    .from(usageDaily)
    .where(and(eq(usageDaily.userId, userId), gte(usageDaily.day, fromDay)));
  return row ?? { ...EMPTY_USAGE };
}

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function monthStartKey(date: Date): string {
  return `${date.toISOString().slice(0, 7)}-01`;
}

function snake(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Estimated AI spend recorded for one channel on one day. */
export async function channelCostOn(db: Db, channelId: string, day: string): Promise<number> {
  const [row] = await db
    .select({ costUsd: sql<number>`coalesce(sum(${usageDaily.costUsd}), 0)::float8` })
    .from(usageDaily)
    .where(and(eq(usageDaily.channelId, channelId), eq(usageDaily.day, day)));
  return Number(row?.costUsd ?? 0);
}
