import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal Mercado Pago client for subscriptions (preapprovals) and their
 * invoices (authorized payments). Plain HTTP, so it's easy to fake in tests.
 */

export type PreapprovalStatus = "pending" | "authorized" | "paused" | "cancelled";

export interface Preapproval {
  id: string;
  status: PreapprovalStatus;
  reason?: string;
  external_reference?: string | null;
  payer_email?: string;
  init_point?: string;
  next_payment_date?: string | null;
  auto_recurring?: {
    frequency: number;
    frequency_type: "days" | "months";
    transaction_amount: number;
    currency_id: string;
  };
}

export interface AuthorizedPayment {
  id: string | number;
  preapproval_id: string;
  status: string;
  transaction_amount?: number;
  date_created?: string;
  debit_date?: string;
  payment?: { id?: number | string; status?: string; status_detail?: string };
}

export interface CreatePreapprovalInput {
  reason: string;
  external_reference: string;
  payer_email: string;
  back_url: string;
  auto_recurring: { frequency: 1; frequency_type: "months"; transaction_amount: number; currency_id: string };
  status: "pending";
}

export class MercadoPagoError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface MercadoPagoClientOptions {
  accessToken: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class MercadoPagoClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MercadoPagoClientOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.mercadopago.com";
    this.fetchImpl = options.fetch ?? fetch;
  }

  createPreapproval(input: CreatePreapprovalInput, idempotencyKey: string): Promise<Preapproval> {
    return this.request("POST", "/preapproval", input, { "X-Idempotency-Key": idempotencyKey });
  }

  getPreapproval(id: string): Promise<Preapproval> {
    return this.request("GET", `/preapproval/${encodeURIComponent(id)}`);
  }

  updatePreapproval(id: string, body: Partial<Pick<Preapproval, "status" | "reason">> & { auto_recurring?: { transaction_amount: number; currency_id: string } }): Promise<Preapproval> {
    return this.request("PUT", `/preapproval/${encodeURIComponent(id)}`, body);
  }

  getAuthorizedPayment(id: string): Promise<AuthorizedPayment> {
    return this.request("GET", `/authorized_payments/${encodeURIComponent(id)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.accessToken}`,
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    const parsed = text ? safeJson(text) : null;
    if (!response.ok) {
      const message = (parsed as { message?: string } | null)?.message ?? `Mercado Pago request failed (${response.status})`;
      throw new MercadoPagoError(response.status, message, parsed);
    }
    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Verifies a webhook's `x-signature` header (Mercado Pago "validate the
 * origin of notifications"): HMAC-SHA256 over the manifest
 * `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, leaving out parts that
 * are absent, compared in constant time with the header's `v1`.
 */
export function verifyWebhookSignature(input: {
  signature: string | null;
  requestId: string | null;
  dataId: string | null;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  if (!input.signature) return false;
  const parts = Object.fromEntries(
    input.signature.split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key?.trim() ?? "", rest.join("=").trim()];
    }),
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  if (input.toleranceSeconds !== undefined && input.nowSeconds !== undefined) {
    // Timestamps arrive in seconds or milliseconds depending on the notification; accept both.
    const tsNumber = Number(ts);
    const tsSeconds = tsNumber > 1e12 ? tsNumber / 1000 : tsNumber;
    if (!Number.isFinite(tsSeconds) || Math.abs(input.nowSeconds - tsSeconds) > input.toleranceSeconds) return false;
  }

  const dataId = input.dataId && /^[a-z0-9]+$/i.test(input.dataId) ? input.dataId.toLowerCase() : input.dataId;
  let manifest = "";
  if (dataId) manifest += `id:${dataId};`;
  if (input.requestId) manifest += `request-id:${input.requestId};`;
  manifest += `ts:${ts};`;

  const expected = createHmac("sha256", input.secret).update(manifest).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Builds a valid signature header; used by tests and the local webhook tester. */
export function signWebhook(input: { requestId: string; dataId: string; secret: string; ts: number }): string {
  const dataId = /^[a-z0-9]+$/i.test(input.dataId) ? input.dataId.toLowerCase() : input.dataId;
  const manifest = `id:${dataId};request-id:${input.requestId};ts:${input.ts};`;
  return `ts=${input.ts},v1=${createHmac("sha256", input.secret).update(manifest).digest("hex")}`;
}
