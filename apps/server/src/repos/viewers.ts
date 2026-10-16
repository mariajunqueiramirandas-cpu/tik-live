import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { viewer } from "../db/schema";

export type ViewerRow = typeof viewer.$inferSelect;

export async function loadViewers(db: Db, channelId: string, platformUserIds: string[]): Promise<ViewerRow[]> {
  if (platformUserIds.length === 0) return [];
  return db
    .select()
    .from(viewer)
    .where(and(eq(viewer.channelId, channelId), inArray(viewer.platformUserId, platformUserIds)));
}

/** Writes full records (the runtime's cache is the source of truth while it runs). */
export async function saveViewers(db: Db, rows: ViewerRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await db
      .insert(viewer)
      .values(chunk)
      .onConflictDoUpdate({
        target: [viewer.channelId, viewer.platformUserId],
        set: {
          handle: sql`excluded.handle`,
          nickname: sql`excluded.nickname`,
          lastSeenAt: sql`excluded.last_seen_at`,
          visits: sql`excluded.visits`,
          messages: sql`excluded.messages`,
          diamonds: sql`excluded.diamonds`,
          gifts: sql`excluded.gifts`,
          follows: sql`excluded.follows`,
          shares: sql`excluded.shares`,
          recentLines: sql`excluded.recent_lines`,
          notes: sql`excluded.notes`,
        },
      });
  }
}

export async function topSupporters(db: Db, channelId: string, limit = 10): Promise<ViewerRow[]> {
  return db
    .select()
    .from(viewer)
    .where(and(eq(viewer.channelId, channelId), gt(viewer.diamonds, 0)))
    .orderBy(desc(viewer.diamonds))
    .limit(limit);
}

export async function regulars(db: Db, channelId: string, limit = 10): Promise<ViewerRow[]> {
  return db
    .select()
    .from(viewer)
    .where(and(eq(viewer.channelId, channelId), gt(viewer.visits, 1)))
    .orderBy(desc(viewer.visits), desc(viewer.lastSeenAt))
    .limit(limit);
}

export async function viewerCount(db: Db, channelId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(viewer)
    .where(eq(viewer.channelId, channelId));
  return row?.n ?? 0;
}
