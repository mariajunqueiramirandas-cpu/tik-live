import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { hostMemory } from "../db/schema";
import type { HostFact } from "../runtime/brain/host-facts";

/** What the channel's host has said about itself on earlier streams. */
export async function loadHostFacts(db: Db, channelId: string): Promise<HostFact[]> {
  const [row] = await db.select({ facts: hostMemory.facts }).from(hostMemory).where(eq(hostMemory.channelId, channelId)).limit(1);
  return row?.facts ?? [];
}

export async function saveHostFacts(db: Db, channelId: string, facts: HostFact[], now: Date): Promise<void> {
  await db
    .insert(hostMemory)
    .values({ channelId, facts, updatedAt: now })
    .onConflictDoUpdate({ target: hostMemory.channelId, set: { facts, updatedAt: now } });
}
