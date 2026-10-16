import { PLANS, isUnlimited, type Plan, type PlanId } from "@tik-live/shared";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import { getSubscription } from "../repos/subscriptions";
import { monthStartKey, usageSince } from "../repos/usage";

export type EntitlementCheck = { ok: true } | { ok: false; code: string; message: string };

/**
 * Answers "what is this user allowed to do right now" from our own tables
 * (ADR-0013: no payment-provider call on the request path).
 */
export class Entitlements {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async planFor(userId: string): Promise<Plan> {
    if (!this.config.billingEnabled) return PLANS["self-hosted"];
    const sub = await getSubscription(this.db, userId);
    if (!sub) return PLANS.free;
    const planId = sub.plan as PlanId;
    const plan = PLANS[planId] ?? PLANS.free;
    if (sub.status === "authorized") return plan;
    // A failed payment keeps the paid plan until the grace period ends.
    if (sub.graceUntil && sub.graceUntil.getTime() > this.now()) return plan;
    return PLANS.free;
  }

  async liveSecondsThisMonth(userId: string): Promise<number> {
    const usage = await usageSince(this.db, userId, monthStartKey(new Date(this.now())));
    return usage.runtimeSeconds;
  }

  async canCreateChannel(userId: string, existing: number): Promise<EntitlementCheck> {
    const plan = await this.planFor(userId);
    if (!isUnlimited(plan.limits.channels) && existing >= plan.limits.channels) {
      return {
        ok: false,
        code: "plan_channel_limit",
        message: `Your ${plan.name} plan includes ${plan.limits.channels} hosts. Delete one or upgrade to add more.`,
      };
    }
    return { ok: true };
  }

  /** Can this user start another channel, given how many are running now? */
  async canStart(userId: string, running: number, pendingSeconds = 0): Promise<EntitlementCheck> {
    const plan = await this.planFor(userId);
    if (!isUnlimited(plan.limits.runningChannels) && running >= plan.limits.runningChannels) {
      return {
        ok: false,
        code: "plan_running_limit",
        message: `Your ${plan.name} plan runs ${plan.limits.runningChannels} host${plan.limits.runningChannels === 1 ? "" : "s"} at a time. Stop one first or upgrade.`,
      };
    }
    if (!isUnlimited(plan.limits.liveHoursPerMonth)) {
      const used = (await this.liveSecondsThisMonth(userId)) + pendingSeconds;
      if (used >= plan.limits.liveHoursPerMonth * 3600) {
        return {
          ok: false,
          code: "plan_hours_exhausted",
          message: `You've used all ${plan.limits.liveHoursPerMonth} live hours on the ${plan.name} plan this month. Upgrade to keep going.`,
        };
      }
    }
    return { ok: true };
  }
}
