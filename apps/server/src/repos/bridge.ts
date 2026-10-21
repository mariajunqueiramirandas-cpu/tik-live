import { and, asc, eq, gt, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { bridgeDevice, bridgePairing, channel } from "../db/schema";
import type { ChannelRow } from "./channels";

export type BridgeDeviceRow = typeof bridgeDevice.$inferSelect;

/** Stores a pairing code (by lookup hash) and clears expired ones. */
export async function createPairing(db: Db, values: { codeLookup: string; channelId: string; expiresAt: Date }, now: Date): Promise<void> {
  await db.delete(bridgePairing).where(lt(bridgePairing.expiresAt, now));
  await db.insert(bridgePairing).values(values);
}

/** Uses up a pairing code: returns its channel when it existed and hadn't expired. */
export async function claimPairing(db: Db, codeLookup: string, now: Date): Promise<string | undefined> {
  const [row] = await db
    .delete(bridgePairing)
    .where(and(eq(bridgePairing.codeLookup, codeLookup), gt(bridgePairing.expiresAt, now)))
    .returning({ channelId: bridgePairing.channelId });
  return row?.channelId;
}

export async function createDevice(db: Db, values: { id: string; channelId: string; name: string; tokenLookup: string }): Promise<BridgeDeviceRow> {
  const [row] = await db.insert(bridgeDevice).values(values).returning();
  return row!;
}

export async function deviceForToken(db: Db, tokenLookup: string): Promise<{ device: BridgeDeviceRow; channel: ChannelRow } | undefined> {
  const [row] = await db
    .select({ device: bridgeDevice, channel })
    .from(bridgeDevice)
    .innerJoin(channel, eq(channel.id, bridgeDevice.channelId))
    .where(eq(bridgeDevice.tokenLookup, tokenLookup));
  return row;
}

export async function listDevices(db: Db, channelId: string): Promise<BridgeDeviceRow[]> {
  return db.select().from(bridgeDevice).where(eq(bridgeDevice.channelId, channelId)).orderBy(asc(bridgeDevice.createdAt));
}

export async function deleteDevice(db: Db, channelId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(bridgeDevice)
    .where(and(eq(bridgeDevice.channelId, channelId), eq(bridgeDevice.id, id)))
    .returning({ id: bridgeDevice.id });
  return rows.length > 0;
}

export async function touchDevice(db: Db, id: string, now: Date): Promise<void> {
  await db.update(bridgeDevice).set({ lastSeenAt: now }).where(eq(bridgeDevice.id, id));
}
