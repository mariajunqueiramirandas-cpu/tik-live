# ADR-0013: Billing and plans

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

The SaaS needs paid plans with limits that match its real costs: AI usage per
live hour ([ADR-0012](0012-ai-and-voice-pipeline.md)), concurrent channels, and
CPU-heavy cloud broadcast ([ADR-0014](0014-cloud-broadcast.md)). The same
codebase should also run self-hosted, for example by the owner on their own
VPS before launch, with no billing at all.

## Decision

- **Plans are defined in code** (`packages/shared/src/plans.ts`), so limits
  are type-checked and enforced the same way in the API, the runtime and the
  dashboard. Stripe holds prices, not limits; each plan maps to a Stripe Price
  ID through environment variables.
- **Proposed tiers** (names, prices and limits are placeholders for the owner
  to set):

| Plan | Channels running at once | Live hours / month | Cloud broadcast | Voice | Models (host / moderator) | Transcript retention |
|---|---|---|---|---|---|---|
| Free | 1 | 5 | No | Default voice | per [ADR-0012](0012-ai-and-voice-pipeline.md) decision | 7 days |
| Creator | 2 | 150 | No | Curated voices | per decision | 90 days |
| Pro | 5 | 600 | Yes (720p) | Curated voices, BYOK later | per decision | 365 days |
| Self-hosted | unlimited | unlimited | if enabled | all | deployment override | configurable |

- **Self-hosted mode:** when `STRIPE_SECRET_KEY` is not set, every account is
  on the `self-hosted` plan, billing UI is hidden, and limits are off.
- **Stripe integration:**
  - Checkout Session (subscription mode) to upgrade; Customer Portal to
    change plan, update payment, cancel.
  - Webhooks at `POST /api/billing/webhook` with signature verification on the
    raw body. Handled events: `checkout.session.completed`,
    `customer.subscription.created`, `customer.subscription.updated`,
    `customer.subscription.deleted`, `invoice.payment_failed`.
  - Idempotency: event ids are recorded in `stripe_event` before side effects.
  - The `subscription` table mirrors Stripe and is the only source the app
    reads for entitlements; no Stripe call on the request path.
  - Payment failure: a 7-day grace period with a dashboard banner, then a
    downgrade to Free limits. Running channels beyond the limit stop with a
    notice; they're never deleted.
- **Enforcement points:**
  1. Channel create (count of channels, which is generous: drafts are free).
  2. Runtime start (concurrent running channels, remaining hours, feature flags).
  3. A runtime minute ticker (hours accrue; at zero, the channel stops gracefully).
  4. Feature gates in the UI, with upgrade prompts that say exactly what unlocks.
- **Usage display:** the billing page shows live hours used, estimated AI
  cost (internal, for the owner) and plan limits with progress bars.

## Options Considered

### Option A: Plans in code + Stripe Checkout, Portal and webhooks (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Stripe fees only |
| Scalability | Good |
| Team familiarity | High; the standard SaaS pattern |

**Pros:** limits are type-checked; Stripe-hosted payment pages (PCI scope
minimal); self-hosted mode is trivial.
**Cons:** changing limits needs a deploy (acceptable; they rarely change).

### Option B: Usage-based billing (metered per live hour)

| Dimension | Assessment |
|---|---|
| Complexity | Medium to high |
| Cost | Stripe Billing meters |
| Scalability | Good |
| Team familiarity | Medium |

**Pros:** pricing tracks cost exactly.
**Cons:** unpredictable bills scare creators; more complex reconciliation. Can
be added later as overage on top of tiers.

### Option C: A merchant-of-record service (Paddle, Lemon Squeezy)

| Dimension | Assessment |
|---|---|
| Complexity | Low to medium |
| Cost | Higher fees |
| Scalability | Good |
| Team familiarity | Medium |

**Pros:** handles global sales tax and VAT for us.
**Cons:** higher fees; less flexible. Worth considering if the owner doesn't
want to deal with tax registration. **Open question.**

## Trade-off Analysis

Tiered plans with hour allowances are predictable for creators and bound our
cost per account. Code-defined limits keep enforcement consistent across three
enforcement points. Whether to use Stripe directly or a merchant of record is a
business decision about tax handling, not a technical one. The integration is
isolated in `apps/server/src/billing/`, so switching later is contained.

## Consequences

- Easier: launching with paid tiers; running free for personal use.
- Harder: pricing must be set from measured cost before launch.
- Revisit: overage billing once usage patterns are known.

## Action Items

1. [ ] Write `plans.ts` with limits and feature flags; implement the entitlement service.
2. [ ] Implement Checkout, the Portal and webhooks with idempotency and signature checks.
3. [ ] Implement enforcement at create, start and the minute ticker, with studio notices.
4. [ ] Build the billing page and upgrade prompts.
5. [ ] Test webhook handling with Stripe fixtures (signature, idempotency, downgrade path).
