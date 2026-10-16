import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MercadoPagoClient, signWebhook, verifyWebhookSignature, type Preapproval } from "../../src/billing/mercadopago";
import type { IdentityProvider } from "../../src/identity/types";
import { getSubscription } from "../../src/repos/subscriptions";
import { addUsage, dayKey } from "../../src/repos/usage";
import { startTestServer, type TestServer } from "../harness";

const SECRET = "whsec_test_123";

/** An in-memory stand-in for the Mercado Pago API, reached through the real client over fetch. */
class FakeMercadoPago {
  preapprovals = new Map<string, Preapproval>();
  payments = new Map<string, { id: string; preapproval_id: string; status: string; payment: { status: string } }>();
  calls: string[] = [];

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    let match = url.pathname.match(/^\/preapproval\/(.+)$/);
    if (method === "POST" && url.pathname === "/preapproval") {
      const id = `pre_${this.preapprovals.size + 1}`;
      const pre: Preapproval = { ...body, id, status: "pending", init_point: `https://mp.example/checkout?preapproval_id=${id}` };
      this.preapprovals.set(id, pre);
      return json(pre, 201);
    }
    if (match && method === "GET") return json(this.preapprovals.get(match[1]!) ?? { message: "not found" }, this.preapprovals.has(match[1]!) ? 200 : 404);
    if (match && method === "PUT") {
      const pre = this.preapprovals.get(match[1]!)!;
      const next = { ...pre, ...body, auto_recurring: { ...pre.auto_recurring!, ...(body.auto_recurring ?? {}) } };
      this.preapprovals.set(pre.id, next);
      return json(next);
    }
    match = url.pathname.match(/^\/authorized_payments\/(.+)$/);
    if (match) return json(this.payments.get(match[1]!));
    return json({ message: "unknown endpoint" }, 404);
  }) as typeof fetch;

  authorize(id: string): void {
    const pre = this.preapprovals.get(id)!;
    this.preapprovals.set(id, { ...pre, status: "authorized", next_payment_date: new Date(Date.now() + 30 * 86_400_000).toISOString() });
  }
}

/** Identity with a real email so checkout is allowed. */
const identity: IdentityProvider = {
  mode: "dev",
  async resolve(request) {
    const name = request.headers.get("x-dev-user") ?? new URL(request.url).searchParams.get("devUser") ?? "payer";
    return { externalId: `test|${name}`, email: `${name}@example.com`, name };
  },
};

let server: TestServer;
const mp = new FakeMercadoPago();

beforeAll(async () => {
  server = await startTestServer({
    env: { MP_ACCESS_TOKEN: "TEST-token", MP_WEBHOOK_SECRET: SECRET, PLAN_PRICE_CREATOR: "49.90", PLAN_PRICE_PRO: "149.90" },
    mercadoPago: new MercadoPagoClient({ accessToken: "TEST-token", baseUrl: "https://api.mp.test", fetch: mp.fetch }),
    identity,
  });
});
afterAll(async () => {
  await server.close();
});

async function webhook(type: string, dataId: string, requestId: string, signature?: string) {
  const ts = Math.floor(Date.now() / 1000);
  return server.api(`/api/billing/webhook?data.id=${dataId}&type=${type}`, {
    method: "POST",
    json: { id: `${type}-${requestId}`, type, data: { id: dataId } },
    headers: { "x-request-id": requestId, "x-signature": signature ?? signWebhook({ requestId, dataId, secret: SECRET, ts }) },
  });
}

describe("webhook signatures", () => {
  it("accepts the documented manifest and rejects tampering", () => {
    const signature = signWebhook({ requestId: "req-1", dataId: "ABC123", secret: SECRET, ts: 1_700_000_000 });
    expect(verifyWebhookSignature({ signature, requestId: "req-1", dataId: "ABC123", secret: SECRET })).toBe(true);
    expect(verifyWebhookSignature({ signature, requestId: "req-2", dataId: "ABC123", secret: SECRET })).toBe(false);
    expect(verifyWebhookSignature({ signature, requestId: "req-1", dataId: "ABC123", secret: "other" })).toBe(false);
    expect(verifyWebhookSignature({ signature: "ts=1,v1=deadbeef", requestId: "req-1", dataId: "ABC123", secret: SECRET })).toBe(false);
    expect(verifyWebhookSignature({ signature: null, requestId: "req-1", dataId: "x", secret: SECRET })).toBe(false);
    expect(
      verifyWebhookSignature({ signature, requestId: "req-1", dataId: "ABC123", secret: SECRET, nowSeconds: 1_700_000_000 + 3600, toleranceSeconds: 300 }),
    ).toBe(false);
  });
});

describe("subscriptions with Mercado Pago", () => {
  it("starts on Free with priced offers", async () => {
    const res = await server.json("/api/billing", { user: "payer" });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.plan.id).toBe("free");
    expect(res.body.offers.map((o: { id: string; price: number }) => [o.id, o.price])).toEqual([
      ["free", 0],
      ["creator", 49.9],
      ["pro", 149.9],
    ]);
  });

  it("enforces Free limits on channels and live hours", async () => {
    for (let i = 0; i < 2; i++) {
      expect((await server.api("/api/channels", { method: "POST", user: "limited", json: { name: `h${i}` } })).status).toBe(201);
    }
    const third = await server.json("/api/channels", { method: "POST", user: "limited", json: { name: "h3" } });
    expect(third.status).toBe(402);
    expect(third.body.error.code).toBe("plan_channel_limit");

    const me = await server.json("/api/me", { user: "limited" });
    await addUsage(
      server.deps.db,
      { userId: me.body.user.id, channelId: crypto.randomUUID(), day: dayKey(new Date()) },
      { llmRequests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, moderationRequests: 0, ttsCharacters: 0, runtimeSeconds: 5 * 3600, broadcastSeconds: 0, costUsd: 0 },
    );
    const list = await server.json("/api/channels", { user: "limited" });
    const start = await server.json(`/api/channels/${list.body.channels[0].id}/start`, { method: "POST", user: "limited" });
    expect(start.status).toBe(402);
    expect(start.body.error.code).toBe("plan_hours_exhausted");
  });

  it("runs checkout, activation by webhook, payment failure grace, plan change and cancel", async () => {
    const checkout = await server.json("/api/billing/checkout", { method: "POST", user: "payer", json: { plan: "creator" } });
    expect(checkout.status).toBe(200);
    expect(checkout.body.url).toMatch(/^https:\/\/mp\.example\/checkout/);
    const me = await server.json("/api/me", { user: "payer" });
    const userId = me.body.user.id as string;
    const pending = await getSubscription(server.deps.db, userId);
    expect(pending).toMatchObject({ plan: "creator", status: "pending", amount: 49.9, currency: "BRL" });
    const pre = mp.preapprovals.get(pending!.providerSubscriptionId!)!;
    expect(pre).toMatchObject({ payer_email: "payer@example.com", external_reference: `${userId}:creator` });

    // A forged notification changes nothing.
    expect((await webhook("subscription_preapproval", pre.id, "r0", "ts=1,v1=00")).status).toBe(401);
    expect((await server.json("/api/billing", { user: "payer" })).body.plan.id).toBe("free");

    // The payer authorizes on Mercado Pago; the webhook activates the plan (once, even if redelivered).
    mp.authorize(pre.id);
    expect((await webhook("subscription_preapproval", pre.id, "r1")).status).toBe(200);
    expect((await webhook("subscription_preapproval", pre.id, "r1")).status).toBe(200);
    expect((await server.json("/api/billing", { user: "payer" })).body.plan.id).toBe("creator");
    expect(mp.calls.filter((c) => c === `GET /preapproval/${pre.id}`)).toHaveLength(1);

    // A rejected charge keeps the plan during the grace period.
    mp.payments.set("pay_1", { id: "pay_1", preapproval_id: pre.id, status: "processed", payment: { status: "rejected" } });
    await webhook("subscription_authorized_payment", "pay_1", "r2");
    const graced = await getSubscription(server.deps.db, userId);
    expect(graced?.lastPaymentStatus).toBe("rejected");
    expect(graced?.graceUntil).not.toBeNull();
    expect((await server.json("/api/billing", { user: "payer" })).body.plan.id).toBe("creator");

    // A later approved charge clears the grace period.
    mp.payments.set("pay_2", { id: "pay_2", preapproval_id: pre.id, status: "processed", payment: { status: "approved" } });
    await webhook("subscription_authorized_payment", "pay_2", "r3");
    expect((await getSubscription(server.deps.db, userId))?.graceUntil).toBeNull();

    // Upgrading changes the existing subscription's amount in place.
    const upgrade = await server.json("/api/billing/checkout", { method: "POST", user: "payer", json: { plan: "pro" } });
    expect(upgrade.body).toEqual({ url: null, changed: true });
    expect(mp.preapprovals.get(pre.id)?.auto_recurring?.transaction_amount).toBe(149.9);
    expect((await server.json("/api/billing", { user: "payer" })).body.plan.id).toBe("pro");

    // Cancelling stops renewal but keeps the plan until the paid period ends.
    const cancelled = await server.json("/api/billing/cancel", { method: "POST", user: "payer" });
    expect(cancelled.body.subscription.status).toBe("cancelled");
    expect(cancelled.body.plan.id).toBe("pro");
    expect(mp.preapprovals.get(pre.id)?.status).toBe("cancelled");
  });

  it("refuses checkout without a real email address", async () => {
    const devServer = await startTestServer({
      env: { MP_ACCESS_TOKEN: "TEST-token", MP_WEBHOOK_SECRET: SECRET },
      mercadoPago: new MercadoPagoClient({ accessToken: "TEST-token", baseUrl: "https://api.mp.test", fetch: mp.fetch }),
    });
    const res = await devServer.json("/api/billing/checkout", { method: "POST", user: "local", json: { plan: "creator" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("email_required");
    await devServer.close();
  });
});
