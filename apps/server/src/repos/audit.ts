import type { Db } from "../db/client";
import { auditLog } from "../db/schema";

export type AuditAction =
  | "user.provisioned"
  | "channel.created"
  | "channel.deleted"
  | "channel.stage_key_rotated"
  | "channel.stream_key_changed"
  | "channel.started"
  | "channel.stopped"
  | "billing.checkout_started"
  | "billing.plan_changed"
  | "billing.cancelled";

export async function audit(
  db: Db,
  entry: { userId: string | null; action: AuditAction; target?: string; meta?: Record<string, unknown>; ip?: string | null },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: entry.userId,
    action: entry.action,
    target: entry.target ?? null,
    meta: entry.meta ?? {},
    ip: entry.ip ?? null,
  });
}
