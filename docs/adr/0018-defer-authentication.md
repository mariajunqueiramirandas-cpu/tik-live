# ADR-0018: No authentication during development; Clerk or WorkOS later

**Status:** Proposed (supersedes [ADR-0006](0006-authentication.md), which was rejected before acceptance)
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

[ADR-0006](0006-authentication.md) proposed building accounts with Better Auth.
The owner decided instead:

- Authentication will be handled by a **hosted identity provider, Clerk or
  WorkOS**, chosen later.
- **No authentication is needed while development is happening.**

The rest of the system is still multi-tenant: channels belong to users,
billing attaches to users, and every query is scoped by owner
([ADR-0016](0016-security.md)). Skipping auth now must not mean skipping the
`user` concept, or adding the provider later becomes a rewrite.

## Decision

### An identity seam, not an auth system

The server resolves "who is making this request" through one interface:

```ts
interface IdentityProvider {
  /** Returns the caller's identity, or null when unauthenticated. */
  resolve(request: Request): Promise<Identity | null>;
}
type Identity = { externalId: string; email?: string; name?: string };
```

- A Hono middleware calls `resolve()`, then **upserts our own `app_user` row**
  by `external_id` (just-in-time provisioning) and sets `c.var.user`.
  `requireUser` guards the dashboard API. The studio WebSocket upgrade uses
  the same path.
- **All product data references our `app_user.id`**, never a provider id.
  Switching providers later is a change to the mapping, not to the data model.
- Stage URLs keep their own secret stage keys. They were never user auth and
  are unaffected.

### Now: `AUTH_MODE=dev`

- `DevIdentityProvider` resolves every request to a fixed development user
  (`external_id = "dev|local"`, `dev@localhost`). No sign-in screen, no
  passwords, no sessions. The dashboard opens straight into the app.
- **Impersonation for multi-tenant testing:** in dev mode only, an
  `x-dev-user: <name>` header (or `?devUser=<name>` for WebSockets and quick
  browser checks) resolves to `dev|<name>`. Integration tests use this to
  prove one user can't see another's channels. A small dev-only switcher in
  the dashboard shows which dev user is active.
- **Staging safety gate:** running dev mode on a public server would expose a
  control panel that can make a host say anything and spend AI budget. So:
  - with `NODE_ENV=production`, the app **refuses to start in dev mode**
    unless `DEV_GATE_PASSWORD` is set;
  - when it is set, the whole dashboard and API sit behind HTTP Basic auth.
  - Stage URLs (`/s/*`, `/ws/stage/*`, `/api/stage/*`) and webhooks are
    excluded, since they have their own keys or signatures.

  This is a gate for a private staging box, not user authentication.

### Later: `AUTH_MODE=clerk` or `AUTH_MODE=workos`

The choice is deferred to before public launch
([open question](../architecture/plan.md#open-questions)). Both fit the seam:

| | Clerk | WorkOS (AuthKit) |
|---|---|---|
| Server | `@clerk/backend` (`authenticateRequest`), `@hono/clerk-auth` middleware | `@workos-inc/node` (sealed session cookie, `authenticate()`) |
| React | `@clerk/react`: `<ClerkProvider>`, prebuilt `<SignIn/>`, `<UserButton/>` | `@workos-inc/authkit-react`; hosted AuthKit sign-in pages |
| WebSockets | Session cookie sent on the same-origin upgrade, verified with `authenticateRequest`; or a short-lived token in `Sec-WebSocket-Protocol` | Sealed session cookie sent on the same-origin upgrade |
| User sync | Signed webhooks (`user.updated`, `user.deleted`) | Events API or webhooks |
| Teams | Organizations | Organizations, plus enterprise SSO (SAML) and directory sync |
| Strongest fit | Individual creators: polished drop-in UI, fast setup | Agencies and B2B: SSO, organizations, enterprise readiness |

Integration work when the time comes:

1. An `IdentityProvider` adapter.
2. The provider's React provider and sign-in route.
3. A webhook handler for user updates and deletion (deleting our user cascades their channels).
4. Removing the dev gate in production.

Bot protection, email verification, password policy, sessions, device
management and social sign-in all become the provider's job.

## Options Considered

### Option A: Identity seam with a dev provider now, hosted provider later (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low now; one adapter later |
| Cost | None now; provider pricing later |
| Scalability | Provider-managed |
| Team familiarity | High |

**Pros:** zero auth friction while building; multi-tenancy exercised from day
one through impersonation; the future provider plugs into one interface; no
security-critical auth code of our own to maintain.
**Cons:** the real sign-in flow is untested until integration (contained:
the seam is small, and both providers document Hono and React usage).

### Option B: Better Auth now ([ADR-0006](0006-authentication.md), rejected)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Free |
| Scalability | Good |
| Team familiarity | Medium |

**Pros:** real auth from the start; data stays in our database.
**Cons:** work that gets thrown away when moving to Clerk or WorkOS; contrary
to the owner's direction.

### Option C: Integrate Clerk or WorkOS right away

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Provider setup now |
| Scalability | Good |
| Team familiarity | Medium |

**Pros:** production auth from day one.
**Cons:** forces the provider choice early; adds friction (sign-in on every
fresh environment, test keys in CI) while the product is still taking shape.

### Option D: No user concept at all until auth is added

| Dimension | Assessment |
|---|---|
| Complexity | Lowest now |
| Cost | A large retrofit later |
| Scalability | n/a |
| Team familiarity | n/a |

**Pros:** simplest possible start.
**Cons:** every query, billing record and test would need retrofitting for
tenancy later, which is the most error-prone change to make late.

## Trade-off Analysis

The valuable part of authentication for development is the **user
boundary** (ownership, scoping, billing attachment), not the sign-in screen.
Option A keeps the boundary and drops the screen. The dev gate closes the one
real risk of running without auth: a public staging server that anyone could
use to drive a stream or spend money.

## Consequences

- Easier: open the app and work; tests cover multi-user isolation without fixtures for logins.
- Harder: the provider integration becomes a launch-blocking task (tracked in Phase 7 of the [plan](../architecture/plan.md)).
- Superseded: [ADR-0006](0006-authentication.md). Its parts in other ADRs change: [0003](0003-hono-server.md) middleware, [0005](0005-data-layer.md) user table, [0008](0008-realtime-protocol.md) studio auth, [0015](0015-deployment.md) env vars, [0016](0016-security.md) authentication section, [0017](0017-testing-strategy.md) tests.

## Action Items

1. [x] Implement `IdentityProvider`, `DevIdentityProvider` (with impersonation), the identity middleware and `requireUser`.
2. [x] Add the `app_user` table with JIT provisioning.
3. [x] Implement the production guard and the `DEV_GATE_PASSWORD` Basic-auth gate with stage and webhook exclusions.
4. [x] Add a dev-user switcher to the dashboard (dev mode only).
5. [x] Implement both adapters (`apps/server/src/identity/clerk.ts`, `workos.ts`), the Clerk user-sync webhook, and the dashboard sign-in flows.
6. [ ] Owner: choose Clerk or WorkOS ([decisions needed](../decisions-needed.md)), set its keys, and record the choice in a follow-up ADR.
