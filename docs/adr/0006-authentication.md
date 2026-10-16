# ADR-0006: Better Auth for accounts and sessions

**Status:** Rejected, superseded by [ADR-0018](0018-defer-authentication.md)
**Date:** 2026-10-16
**Deciders:** Project owner

> **Rejected before acceptance.** The owner chose a hosted identity provider
> (Clerk or WorkOS) for later and no authentication during development. See
> [ADR-0018](0018-defer-authentication.md). This record is kept to show the
> option that was weighed.

## Context

The SaaS needs sign-up, sign-in, sign-out, email verification, password
reset, session management (list and revoke devices), rate limiting on auth
endpoints, and soon OAuth (Google, maybe TikTok) and teams. Auth is where
hand-written code most often goes wrong: timing attacks, session fixation,
weak reset tokens, enumeration leaks. The owner asked for a "really good
backend", so the question is whether to write this ourselves or adopt a
vetted library that fits Bun, Hono and Drizzle.

## Decision

Use **Better Auth 1.7**, mounted in Hono at `/api/auth/*`, with the Drizzle
adapter on our Postgres database.

- **Email and password**, with hashing overridden to `Bun.password` (argon2id).
  Minimum password length 10, checked against a small list of breached and
  common passwords.
- **Email verification** is required before a channel can go live (draft
  channels are allowed). Verification and password-reset emails go through a
  `Mailer` interface: SMTP or Resend in production, console output in
  development.
- **Sessions:** database-backed sessions with Better Auth's HttpOnly cookie.
  `Secure` is on in production and `SameSite=Lax`. Sessions expire after 30
  days and refresh daily on use. The cookie cache is enabled, so most requests
  avoid a database read.
- **Device list and revoke** in account settings use Better Auth's session APIs.
- **Rate limiting:** Better Auth's built-in limiter on sign-in, sign-up and
  reset (database storage, so limits survive restarts). Hono's limiter covers
  the rest of the API.
- **Hono integration:** a middleware calls `auth.api.getSession({ headers })`
  and sets `c.var.user` / `c.var.session`. `requireUser` guards `/api/*`
  except auth, health, stage and webhooks. The studio WebSocket upgrade uses
  the same check.
- **Later, without schema churn:** Google OAuth (`socialProviders`), the
  organization plugin for teams, and two-factor authentication.

The spike confirmed sign-up, the session cookie and `getSession` working on
Bun with Hono.

## Options Considered

### Option A: Better Auth (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low to medium: configuration, not code |
| Cost | Free, self-hosted, data in our database |
| Scalability | Database sessions with a cookie cache; works across instances |
| Team familiarity | Popular TypeScript auth library; Hono and Drizzle adapters |

**Pros:** vetted flows (verification, reset, sessions, rate limits) out of the
box; plugins for OAuth, organizations and 2FA; we own the data; typed client
for React.
**Cons:** a dependency on a fast-moving library (pin minor versions; follow
release notes); its table conventions shape part of our schema.

### Option B: Hand-written auth (argon2id, opaque session tokens, our own reset flow)

| Dimension | Assessment |
|---|---|
| Complexity | Medium to high: every flow and edge case is ours |
| Cost | Engineering time and security review |
| Scalability | Fine |
| Team familiarity | High |

**Pros:** no dependency; full control.
**Cons:** large security surface we'd own forever; OAuth and teams are big
projects later.

### Option C: A hosted auth service (Clerk, Auth0, WorkOS)

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Per-MAU pricing that grows with the user base |
| Scalability | Excellent |
| Team familiarity | Medium |

**Pros:** polished UI components; compliance handled.
**Cons:** vendor lock-in; recurring cost; user data off-box; another network
hop on every session check; harder to run self-hosted.

## Trade-off Analysis

Better Auth gives the security posture of a hosted provider while keeping data
and cost on our VPS. The dependency risk is real but bounded: it stores
standard tables we can migrate away from, and the Hono integration is one
route mount plus one middleware.

## Consequences

- Easier: secure defaults, OAuth and teams later, consistent session handling for HTTP and WebSockets.
- Harder: auth upgrades need a read of the changelog and a run of the auth test suite.
- Revisit: if Better Auth stalls or breaks compatibility, Option B is a contained rewrite behind the same middleware.

## Action Items

1. [ ] Configure Better Auth (Drizzle adapter, argon2id hooks, email verification, reset, rate limits, secure cookies).
2. [ ] Generate the auth schema into Drizzle and include it in the first migration.
3. [ ] Implement `Mailer` (SMTP, Resend, console) and the email templates (verify, reset).
4. [ ] Add `requireUser` middleware and studio WebSocket authentication.
5. [ ] Write auth integration tests: sign-up, verify, sign-in, wrong password, reset, revoke, rate limit.
