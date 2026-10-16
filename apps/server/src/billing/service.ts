import { PLANS, PRODUCT_NAME, limitsToWire, type PlanId, type WireLimits } from "@tik-live/shared";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import { AppError } from "../http/errors";
import type { Logger } from "../log";
import { audit } from "../repos/audit";
import {
  getSubscription,
  getSubscriptionByProviderId,
  recordBillingEvent,
  upsertSubscription,
  type SubscriptionRow,
} from "../repos/subscriptions";
import { monthStartKey, usageSince } from "../repos/usage";
import type { UserRow } from "../repos/users";
import type { Entitlements } from "./entitlements";
import { MercadoPagoClient, verifyWebhookSignature, type Preapproval } from "./mercadopago";

const GRACE_DAYS = 7;
const PAID_PLANS = ["creator", "pro"] as const satisfies readonly PlanId[];
type PaidPlan = (typeof PAID_PLANS)[number];

export interface PlanOffer {
  id: PlanId;
  name: string;
  summary: string;
  price: number | null;
  currency: string;
  limits: WireLimits;
  highlights: string[];
  purchasable: boolean;
}

export interface BillingStatus {
  enabled: boolean;
  plan: PlanOffer;
  subscription: {
    status: SubscriptionRow["status"];
    plan: string;
    amount: number | null;
    currency: string | null;
    nextPaymentAt: string | null;
    lastPaymentStatus: string | null;
    graceUntil: string | null;
  } | null;
  usage: { liveSeconds: number; liveHoursLimit: number | null; estimatedAiCostUsd: number };
  offers: PlanOffer[];
}

export interface WebhookInput {
  signature: string | null;
  requestId: string | null;
  query: URLSearchParams;
  body: string;
}

/**
 * Subscriptions through Mercado Pago (ADR-0013, revised): one preapproval per
 * user, created when they pick a paid plan, mirrored into `subscription` by
 * webhooks. Entitlements only ever read our table.
 */
export class BillingService {
  private readonly mp: MercadoPagoClient | null;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly entitlements: Entitlements,
    private readonly log: Logger,
    mp?: MercadoPagoClient,
    private readonly now: () => number = Date.now,
  ) {
    this.mp = mp ?? (config.MP_ACCESS_TOKEN ? new MercadoPagoClient({ accessToken: config.MP_ACCESS_TOKEN }) : null);
  }

  get enabled(): boolean {
    return this.config.billingEnabled && this.mp !== null;
  }

  price(plan: PlanId): number | null {
    if (plan === "creator") return this.config.PLAN_PRICE_CREATOR;
    if (plan === "pro") return this.config.PLAN_PRICE_PRO;
    return plan === "free" ? 0 : null;
  }

  offers(): PlanOffer[] {
    // Without billing everyone is on Self-hosted; the public plans are still
    // listed (not purchasable) so the pricing page reads the same everywhere.
    const ids: PlanId[] = ["free", "creator", "pro"];
    return ids.map((id) => this.offer(id));
  }

  async status(userId: string): Promise<BillingStatus> {
    const plan = await this.entitlements.planFor(userId);
    const sub = this.enabled ? await getSubscription(this.db, userId) : undefined;
    const usage = await usageSince(this.db, userId, monthStartKey(new Date(this.now())));
    const hours = plan.limits.liveHoursPerMonth;
    return {
      enabled: this.enabled,
      plan: this.offer(plan.id),
      subscription: sub
        ? {
            status: sub.status,
            plan: sub.plan,
            amount: sub.amount,
            currency: sub.currency,
            nextPaymentAt: sub.nextPaymentAt?.toISOString() ?? null,
            lastPaymentStatus: sub.lastPaymentStatus,
            graceUntil: sub.graceUntil?.toISOString() ?? null,
          }
        : null,
      usage: {
        liveSeconds: usage.runtimeSeconds,
        liveHoursLimit: Number.isFinite(hours) ? hours : null,
        estimatedAiCostUsd: Math.round(usage.costUsd * 100) / 100,
      },
      offers: this.offers(),
    };
  }

  /**
   * Starts a subscription (returns Mercado Pago's checkout URL) or, for an
   * existing active subscription, changes its plan in place.
   */
  async checkout(user: UserRow, planId: string, ip: string | null): Promise<{ url: string | null; changed: boolean }> {
    const mp = this.requireEnabled();
    if (!isPaidPlan(planId)) throw new AppError(400, "invalid_plan", "Pick the Creator or Pro plan.");
    const price = this.price(planId) as number;
    const existing = await getSubscription(this.db, user.id);

    if (existing?.status === "authorized" && existing.providerSubscriptionId) {
      if (existing.plan === planId) return { url: null, changed: false };
      await mp.updatePreapproval(existing.providerSubscriptionId, {
        reason: `${PRODUCT_NAME} ${PLANS[planId].name}`,
        auto_recurring: { transaction_amount: price, currency_id: this.config.BILLING_CURRENCY },
      });
      await upsertSubscription(this.db, { ...withoutMeta(existing), plan: planId, amount: price });
      await audit(this.db, { userId: user.id, action: "billing.plan_changed", meta: { from: existing.plan, to: planId }, ip });
      return { url: null, changed: true };
    }

    if (!user.email || user.email.endsWith("@localhost")) {
      throw new AppError(400, "email_required", "Your account needs a real email address before you can subscribe.");
    }
    const preapproval = await mp.createPreapproval(
      {
        reason: `${PRODUCT_NAME} ${PLANS[planId].name}`,
        external_reference: `${user.id}:${planId}`,
        payer_email: user.email,
        back_url: `${this.config.PUBLIC_URL}/app/billing?checkout=done`,
        auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: price, currency_id: this.config.BILLING_CURRENCY },
        status: "pending",
      },
      `${user.id}:${planId}:${new Date(this.now()).toISOString().slice(0, 13)}`,
    );
    await upsertSubscription(this.db, {
      userId: user.id,
      plan: planId,
      status: "pending",
      provider: "mercadopago",
      providerSubscriptionId: preapproval.id,
      amount: price,
      currency: this.config.BILLING_CURRENCY,
      nextPaymentAt: null,
      lastPaymentAt: existing?.lastPaymentAt ?? null,
      lastPaymentStatus: existing?.lastPaymentStatus ?? null,
      graceUntil: null,
    });
    await audit(this.db, { userId: user.id, action: "billing.checkout_started", meta: { plan: planId }, ip });
    if (!preapproval.init_point) throw new AppError(502, "provider_error", "Mercado Pago didn't return a checkout link. Try again.");
    return { url: preapproval.init_point, changed: false };
  }

  /** Cancels renewal. The paid plan stays until the end of the period already paid for. */
  async cancel(user: UserRow, ip: string | null): Promise<void> {
    const mp = this.requireEnabled();
    const sub = await getSubscription(this.db, user.id);
    if (!sub?.providerSubscriptionId || sub.status === "cancelled") return;
    await mp.updatePreapproval(sub.providerSubscriptionId, { status: "cancelled" });
    const paidUntil = sub.nextPaymentAt && sub.nextPaymentAt.getTime() > this.now() ? sub.nextPaymentAt : null;
    await upsertSubscription(this.db, { ...withoutMeta(sub), status: "cancelled", graceUntil: paidUntil });
    await audit(this.db, { userId: user.id, action: "billing.cancelled", meta: { plan: sub.plan }, ip });
  }

  /** Handles a Mercado Pago notification. Returns false if the signature is invalid. */
  async handleWebhook(input: WebhookInput): Promise<boolean> {
    if (!this.enabled || !this.config.MP_WEBHOOK_SECRET) return false;
    const body = parseBody(input.body);
    const dataId = input.query.get("data.id") ?? input.query.get("id") ?? body?.data?.id?.toString() ?? null;
    const valid = verifyWebhookSignature({
      signature: input.signature,
      requestId: input.requestId,
      dataId,
      secret: this.config.MP_WEBHOOK_SECRET,
    });
    if (!valid) {
      this.log.warn("rejected a billing webhook with an invalid signature");
      return false;
    }
    const type = input.query.get("type") ?? input.query.get("topic") ?? body?.type ?? "unknown";
    const eventId = String(body?.id ?? `${type}:${dataId}:${input.requestId}`);
    const fresh = await recordBillingEvent(this.db, eventId, type, body ?? { raw: input.body });
    if (!fresh || !dataId) return true;

    if (type === "subscription_preapproval" || type === "preapproval") {
      await this.syncPreapproval(await this.mp!.getPreapproval(dataId));
    } else if (type === "subscription_authorized_payment") {
      await this.syncPayment(dataId);
    }
    return true;
  }

  /** Mirrors a preapproval's state into our table. */
  async syncPreapproval(preapproval: Preapproval): Promise<void> {
    const [userId, planFromRef] = (preapproval.external_reference ?? "").split(":");
    const existing =
      (await getSubscriptionByProviderId(this.db, preapproval.id)) ?? (userId ? await getSubscription(this.db, userId) : undefined);
    const owner = existing?.userId ?? userId;
    if (!owner) {
      this.log.warn(`billing webhook for unknown subscription ${preapproval.id}`);
      return;
    }
    const plan = isPaidPlan(existing?.plan ?? "") ? (existing!.plan as PaidPlan) : isPaidPlan(planFromRef ?? "") ? (planFromRef as PaidPlan) : "creator";
    const nextPaymentAt = preapproval.next_payment_date ? new Date(preapproval.next_payment_date) : null;
    let graceUntil = existing?.graceUntil ?? null;
    if (preapproval.status === "authorized") graceUntil = existing?.lastPaymentStatus === "rejected" ? graceUntil : null;
    if (preapproval.status === "cancelled" && !graceUntil && nextPaymentAt && nextPaymentAt.getTime() > this.now()) graceUntil = nextPaymentAt;
    await upsertSubscription(this.db, {
      userId: owner,
      plan,
      status: preapproval.status,
      provider: "mercadopago",
      providerSubscriptionId: preapproval.id,
      amount: preapproval.auto_recurring?.transaction_amount ?? existing?.amount ?? null,
      currency: preapproval.auto_recurring?.currency_id ?? existing?.currency ?? null,
      nextPaymentAt,
      lastPaymentAt: existing?.lastPaymentAt ?? null,
      lastPaymentStatus: existing?.lastPaymentStatus ?? null,
      graceUntil,
    });
  }

  private async syncPayment(paymentId: string): Promise<void> {
    const payment = await this.mp!.getAuthorizedPayment(paymentId);
    const sub = await getSubscriptionByProviderId(this.db, payment.preapproval_id);
    if (!sub) return;
    const outcome = payment.payment?.status ?? payment.status;
    const approved = outcome === "approved" || outcome === "processed";
    const rejected = outcome === "rejected" || outcome === "cancelled";
    await upsertSubscription(this.db, {
      ...withoutMeta(sub),
      lastPaymentAt: new Date(payment.debit_date ?? payment.date_created ?? this.now()),
      lastPaymentStatus: approved ? "approved" : rejected ? "rejected" : outcome,
      // A failed charge keeps the plan for a grace period, then drops to Free (ADR-0013).
      graceUntil: approved ? null : rejected ? sub.graceUntil ?? new Date(this.now() + GRACE_DAYS * 86_400_000) : sub.graceUntil,
    });
  }

  private offer(id: PlanId): PlanOffer {
    const plan = PLANS[id];
    return {
      id,
      name: plan.name,
      summary: plan.summary,
      price: this.price(id),
      currency: this.config.BILLING_CURRENCY,
      limits: limitsToWire(plan.limits),
      highlights: plan.highlights,
      purchasable: plan.purchasable && this.enabled,
    };
  }

  private requireEnabled(): MercadoPagoClient {
    if (!this.enabled || !this.mp) throw new AppError(409, "billing_disabled", "Billing is turned off on this server.");
    return this.mp;
  }
}

function isPaidPlan(value: string): value is PaidPlan {
  return (PAID_PLANS as readonly string[]).includes(value);
}

function withoutMeta(row: SubscriptionRow) {
  const { updatedAt: _updatedAt, ...rest } = row;
  return rest;
}

function parseBody(text: string): { id?: string | number; type?: string; data?: { id?: string | number } } | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
