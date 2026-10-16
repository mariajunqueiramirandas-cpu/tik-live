# ADR-0013: Billing and plans

**Status:** Proposed (revised 2026-10-16: Mercado Pago replaces Stripe, at the owner's request)
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

The SaaS needs paid plans with limits that match its real costs: AI usage per
live hour ([ADR-0012](0012-ai-and-voice-pipeline.md)), concurrent channels, and
CPU-heavy cloud broadcast ([ADR-0014](0014-cloud-broadcast.md)). The same
codebase should also run self-hosted, for example by the owner on their own
VPS before launch, with no billing at all.

The first draft of this ADR chose Stripe. The owner asked for **Mercado
Pago**, which fits the first market (Brazil, prices in BRL, local cards).
This revision records that decision and how it's implemented.

## Decision

- **Plans are defined in code** (`packages/shared/src/plans.ts`), so limits
  are type-checked and enforced the same way in the API, the runtime and the
  dashboard. **Prices live in server configuration** (`PLAN_PRICE_CREATOR`,
  `PLAN_PRICE_PRO`, `BILLING_CURRENCY`), because they're a business decision,
  not a code change. The landing page and billing page read them from the
  server.
- **Tiers** (limits are starting points for the owner to tune; prices are
  placeholders, see [decisions needed](../decisions-needed.md)):

| Plan | Channels running at once | Channels | Live hours / month | Cloud broadcast | Voice | Transcript retention | Price (placeholder) |
|---|---|---|---|---|---|---|---|
| Free | 1 | 2 | 5 | No | Default voice | 7 days | Free |
| Creator | 2 | 5 | 150 | No | Choose any voice | 90 days | R$ 49,90 / month |
| Pro | 5 | 20 | 600 | Yes (720p) | Choose any voice | 365 days | R$ 149,90 / month |
| Self-hosted | unlimited | unlimited | unlimited | if enabled | all | 365 days | n/a |

  Each plan also has an hourly AI token budget; past it the host switches to
  react-only mode until the hour rolls over ([ADR-0012](0012-ai-and-voice-pipeline.md)).

- **Self-hosted mode:** when `MP_ACCESS_TOKEN` is not set, every account is
  on the `self-hosted` plan, purchase buttons are hidden, and limits are off.
  The public plans are still listed (not purchasable) so pages read the same.
- **Mercado Pago integration** (`apps/server/src/billing/`):
  - **Subscriptions are preapprovals** (`POST /preapproval`), one per user,
    created when they pick a paid plan, with `auto_recurring` monthly in
    `BILLING_CURRENCY`, `external_reference = <userId>:<plan>` and an
    `X-Idempotency-Key`. The user is sent to the preapproval's `init_point`
    (Mercado Pago's hosted checkout; no card data touches our servers) and
    returns to `/app/billing?checkout=done`, which polls until the webhook
    lands.
  - **Plan changes** for an authorized subscription update the preapproval in
    place (`PUT /preapproval/{id}` with the new amount), with no new checkout.
  - **Cancellation** sets the preapproval to `cancelled`; the plan stays
    active until the next payment date that was already paid for.
  - **Webhooks** at `POST /api/billing/webhook`, exempt from the CSRF origin
    check. Every notification is verified with the `x-signature` header:
    HMAC-SHA256 with `MP_WEBHOOK_SECRET` over
    `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, compared in constant
    time. Handled topics: `subscription_preapproval` (re-fetches the
    preapproval and mirrors it) and `subscription_authorized_payment`
    (re-fetches the charge and records approval or rejection). Webhook bodies
    are never trusted for state: the server always reads the object back
    from Mercado Pago.
  - **Idempotency:** each notification is recorded in `billing_event` before
    side effects; a repeat is acknowledged and ignored.
  - The `subscription` table mirrors Mercado Pago and is the only source the
    app reads for entitlements; no Mercado Pago call on the request path.
  - **Payment failure:** a rejected charge starts a 7-day grace period (the
    dashboard says when it ends); Mercado Pago retries the charge. After the
    grace period the account drops to Free limits. Running channels beyond
    the limit stop with a notice; they're never deleted.
- **Enforcement points:**
  1. Channel create (count of channels; drafts are generous).
  2. Runtime start (concurrent running channels, remaining hours, feature flags).
  3. A runtime minute ticker (hours accrue; at zero, the channel stops gracefully; a downgrade stops cloud broadcast).
  4. Feature gates in the UI, with upgrade prompts that say exactly what unlocks.
- **Usage display:** the billing page shows live hours used against the
  plan, the subscription state in plain words, and the estimated AI cost.

## Options Considered

### Option A: Plans in code + Mercado Pago preapprovals and webhooks (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Mercado Pago fees only |
| Scalability | Good |
| Team familiarity | Medium; documented REST API, no SDK needed |

**Pros:** local payment methods and BRL pricing for the first market; hosted
checkout keeps card data out of scope; self-hosted mode is trivial; the
integration is a small REST client with an injectable `fetch`, fully tested
against a simulated Mercado Pago.
**Cons:** no hosted "customer portal": plan changes and cancellation are our
own UI (built); fewer global payment methods than Stripe if the product
expands beyond Latin America.

### Option B: Stripe Checkout, Portal and webhooks (first draft)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Stripe fees |
| Scalability | Good |
| Team familiarity | High |

**Pros:** customer portal; global reach.
**Cons:** not the owner's choice; weaker fit for Brazilian payers.

### Option C: Usage-based billing (metered per live hour)

**Pros:** pricing tracks cost exactly.
**Cons:** unpredictable bills scare creators. Can be added later as overage on
top of tiers (hours are already metered per day in `usage_daily`).

### Option D: A merchant-of-record service (Paddle, Lemon Squeezy)

**Pros:** handles sales tax and VAT.
**Cons:** higher fees; weaker local payment support in Brazil.

## Trade-off Analysis

Tiered plans with hour allowances are predictable for creators and bound our
cost per account. Code-defined limits keep enforcement consistent across all
enforcement points. Mercado Pago matches the owner's market; because the
integration is isolated in `apps/server/src/billing/` and entitlements only
read our own `subscription` table, adding a second provider later (for
example Stripe for international customers) means another client plus a
`provider` value, not a redesign.

## Consequences

- Easier: launching with paid tiers in BRL; running free for personal use.
- Harder: prices must be set from measured cost before launch; invoices
  (nota fiscal) are outside this system and need the owner's accounting setup.
- Revisit: overage billing once usage patterns are known; a second provider
  for international customers.

## Action Items

1. [x] Write `plans.ts` with limits and feature flags; implement the entitlement service.
2. [x] Implement preapproval checkout, in-place plan changes, cancellation, and webhooks with idempotency and signature checks.
3. [x] Implement enforcement at create, start and the minute ticker, with studio notices.
4. [x] Build the billing page and upgrade prompts.
5. [x] Test webhook handling against a simulated Mercado Pago (signature, idempotency, payment failure and grace period, cancellation).
6. [ ] Owner: set real prices and confirm limits ([decisions needed](../decisions-needed.md)).
