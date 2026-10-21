import { and, asc, count, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { channel } from "../db/schema";

export type ChannelRow = typeof channel.$inferSelect;
export type NewChannel = typeof channel.$inferInsert;
export type ChannelPatch = Partial<
  Pick<ChannelRow, "name" | "tiktokUsername" | "source" | "persona" | "voice" | "safety" | "broadcast" | "desiredState" | "stageKeyLookup" | "stageKeyCiphertext">
>;

// Every function that takes `ownerId` is tenant-scoped (ADR-0016). Functions
// without it are for the runtime manager and the stage endpoint only.

export async function listChannels(db: Db, ownerId: string): Promise<ChannelRow[]> {
  return db.select().from(channel).where(eq(channel.ownerId, ownerId)).orderBy(asc(channel.createdAt));
}

export async function countChannels(db: Db, ownerId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(channel).where(eq(channel.ownerId, ownerId));
  return row?.n ?? 0;
}

export async function getChannel(db: Db, ownerId: string, id: string): Promise<ChannelRow | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .select()
    .from(channel)
    .where(and(eq(channel.id, id), eq(channel.ownerId, ownerId)));
  return row;
}

export async function createChannel(db: Db, values: NewChannel): Promise<ChannelRow> {
  const [row] = await db.insert(channel).values(values).returning();
  return row as ChannelRow;
}

export async function updateChannel(db: Db, ownerId: string, id: string, patch: ChannelPatch): Promise<ChannelRow | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .update(channel)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(channel.id, id), eq(channel.ownerId, ownerId)))
    .returning();
  return row;
}

export async function deleteChannel(db: Db, ownerId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db
    .delete(channel)
    .where(and(eq(channel.id, id), eq(channel.ownerId, ownerId)))
    .returning({ id: channel.id });
  return rows.length > 0;
}

// --- internal (not tenant-scoped) -------------------------------------------

export async function getChannelById(db: Db, id: string): Promise<ChannelRow | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db.select().from(channel).where(eq(channel.id, id));
  return row;
}

export async function getChannelByStageLookup(db: Db, lookup: string): Promise<ChannelRow | undefined> {
  const [row] = await db.select().from(channel).where(eq(channel.stageKeyLookup, lookup));
  return row;
}

/** Internal (jobs only): every channel's id and owner. */
export async function listAllChannelOwners(db: Db): Promise<Array<{ id: string; ownerId: string }>> {
  return db.select({ id: channel.id, ownerId: channel.ownerId }).from(channel);
}

/** Internal (scheduler / runtime manager only): every channel row. */
export async function listAllChannels(db: Db): Promise<ChannelRow[]> {
  return db.select().from(channel).orderBy(asc(channel.createdAt));
}

export async function listDesiredRunning(db: Db): Promise<ChannelRow[]> {
  return db.select().from(channel).where(eq(channel.desiredState, "running")).orderBy(asc(channel.updatedAt));
}

export async function setDesiredStateInternal(db: Db, id: string, desiredState: "stopped" | "running"): Promise<void> {
  await db.update(channel).set({ desiredState, updatedAt: new Date() }).where(eq(channel.id, id));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
