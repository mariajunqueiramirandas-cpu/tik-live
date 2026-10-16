import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { appUser } from "../db/schema";

export type UserRow = typeof appUser.$inferSelect;

export interface IdentityClaims {
  externalId: string;
  email?: string | null;
  name?: string | null;
}

/** Just-in-time provisioning: find or create our user for an external identity (ADR-0018). */
export async function upsertUser(db: Db, identity: IdentityClaims): Promise<UserRow> {
  const [row] = await db
    .insert(appUser)
    .values({
      id: Bun.randomUUIDv7(),
      externalId: identity.externalId,
      email: identity.email ?? null,
      name: identity.name ?? null,
    })
    .onConflictDoUpdate({
      target: appUser.externalId,
      set: {
        email: sql`coalesce(excluded.email, ${appUser.email})`,
        name: sql`coalesce(excluded.name, ${appUser.name})`,
      },
    })
    .returning();
  return row as UserRow;
}

export async function getUser(db: Db, id: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(appUser).where(eq(appUser.id, id));
  return row;
}

export async function getUserByExternalId(db: Db, externalId: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(appUser).where(eq(appUser.externalId, externalId));
  return row;
}

/** Deletes the user and, by cascade, their channels and everything under them. */
export async function deleteUser(db: Db, id: string): Promise<void> {
  await db.delete(appUser).where(eq(appUser.id, id));
}
