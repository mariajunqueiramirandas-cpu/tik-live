import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { segmentScores } from "../db/schema";
import type { SegmentScore } from "../runtime/segment-scores";

/** How each segment has done on the channel's earlier streams (ADR-0043). */
export async function loadSegmentScores(db: Db, channelId: string): Promise<SegmentScore[]> {
  const [row] = await db.select({ scores: segmentScores.scores }).from(segmentScores).where(eq(segmentScores.channelId, channelId)).limit(1);
  return row?.scores ?? [];
}

export async function saveSegmentScores(db: Db, channelId: string, scores: SegmentScore[], now: Date): Promise<void> {
  await db
    .insert(segmentScores)
    .values({ channelId, scores, updatedAt: now })
    .onConflictDoUpdate({ target: segmentScores.channelId, set: { scores, updatedAt: now } });
}
