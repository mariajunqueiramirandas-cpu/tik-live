import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessionSample, streamSession, utterance } from "../db/schema";

export type StreamSessionRow = typeof streamSession.$inferSelect;
export type SampleRow = typeof sessionSample.$inferSelect;
export type UtteranceRow = typeof utterance.$inferSelect;
export type NewUtterance = typeof utterance.$inferInsert;

export type SessionTotals = Omit<StreamSessionRow, "id" | "channelId" | "startedAt" | "endedAt" | "endReason" | "source">;

export async function createSession(db: Db, values: { id: string; channelId: string; startedAt: Date; source: StreamSessionRow["source"] }): Promise<void> {
  await db.insert(streamSession).values(values);
}

export async function updateSessionTotals(db: Db, id: string, totals: SessionTotals): Promise<void> {
  await db.update(streamSession).set(totals).where(eq(streamSession.id, id));
}

export async function endSession(db: Db, id: string, endedAt: Date, reason: string, totals: SessionTotals): Promise<void> {
  await db
    .update(streamSession)
    .set({ ...totals, endedAt, endReason: reason })
    .where(eq(streamSession.id, id));
}

/** Sessions left open by a crash or hard restart are closed when the channel's runtime next starts. */
export async function closeOrphanedSessions(db: Db, channelId: string, now: Date): Promise<number> {
  const rows = await db
    .update(streamSession)
    .set({ endedAt: now, endReason: "interrupted" })
    .where(and(eq(streamSession.channelId, channelId), isNull(streamSession.endedAt)))
    .returning({ id: streamSession.id });
  return rows.length;
}

export async function upsertSamples(db: Db, rows: SampleRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(sessionSample)
    .values(rows)
    .onConflictDoUpdate({
      target: [sessionSample.sessionId, sessionSample.minute],
      set: {
        viewers: sql`greatest(${sessionSample.viewers}, excluded.viewers)`,
        likes: sql`${sessionSample.likes} + excluded.likes`,
        messages: sql`${sessionSample.messages} + excluded.messages`,
        diamonds: sql`${sessionSample.diamonds} + excluded.diamonds`,
      },
    });
}

export async function insertUtterances(db: Db, rows: NewUtterance[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(utterance).values(rows);
}

export async function listSessions(db: Db, channelId: string, limit = 30): Promise<StreamSessionRow[]> {
  return db
    .select()
    .from(streamSession)
    .where(eq(streamSession.channelId, channelId))
    .orderBy(desc(streamSession.startedAt))
    .limit(limit);
}

export async function getSession(db: Db, channelId: string, id: string): Promise<StreamSessionRow | undefined> {
  const [row] = await db
    .select()
    .from(streamSession)
    .where(and(eq(streamSession.id, id), eq(streamSession.channelId, channelId)));
  return row;
}

export async function listSamples(db: Db, sessionId: string): Promise<SampleRow[]> {
  return db.select().from(sessionSample).where(eq(sessionSample.sessionId, sessionId)).orderBy(asc(sessionSample.minute));
}

export async function listUtterances(db: Db, sessionId: string, limit = 500): Promise<UtteranceRow[]> {
  return db.select().from(utterance).where(eq(utterance.sessionId, sessionId)).orderBy(asc(utterance.at)).limit(limit);
}

/** Retention: deletes host lines older than `before` for one channel. */
export async function purgeUtterances(db: Db, channelId: string, before: Date): Promise<number> {
  const rows = await db
    .delete(utterance)
    .where(and(eq(utterance.channelId, channelId), lt(utterance.at, before)))
    .returning({ id: utterance.id });
  return rows.length;
}
