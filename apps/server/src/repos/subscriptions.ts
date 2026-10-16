import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { billingEvent, subscription } from "../db/schema";

export type SubscriptionRow = typeof subscription.$inferSelect;
export type SubscriptionValues = Omit<typeof subscription.$inferInsert, "updatedAt">;

export async function getSubscription(db: Db, userId: string): Promise<SubscriptionRow | undefined> {
  const [row] = await db.select().from(subscription).where(eq(subscription.userId, userId));
  return row;
}

export async function getSubscriptionByProviderId(db: Db, providerSubscriptionId: string): Promise<SubscriptionRow | undefined> {
  const [row] = await db.select().from(subscription).where(eq(subscription.providerSubscriptionId, providerSubscriptionId));
  return row;
}

export async function upsertSubscription(db: Db, values: SubscriptionValues): Promise<SubscriptionRow> {
  const { userId, ...rest } = values;
  const [row] = await db
    .insert(subscription)
    .values({ ...values, updatedAt: new Date() })
    .onConflictDoUpdate({ target: subscription.userId, set: { ...rest, updatedAt: new Date() } })
    .returning();
  return row as SubscriptionRow;
}

/** Records a webhook delivery; returns false when it was already processed. */
export async function recordBillingEvent(db: Db, id: string, type: string, payload: unknown): Promise<boolean> {
  const rows = await db.insert(billingEvent).values({ id, type, payload }).onConflictDoNothing().returning({ id: billingEvent.id });
  return rows.length > 0;
}
