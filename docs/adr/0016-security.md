# ADR-0016: Security model

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

A multi-tenant SaaS that holds creators' accounts, TikTok stream keys and a
voice on their live broadcasts has a specific threat model. The worst
outcomes:

1. **Something harmful gets said on a creator's stream.** Account bans and
   reputational damage. (Covered mostly by the safety pipeline,
   [ADR-0012](0012-ai-and-voice-pipeline.md).)
2. **Cross-tenant access.** One creator reads or controls another's channel.
3. **Account takeover.** Credential stuffing, session theft, weak resets.
   (Owned by the identity provider once it's added; until then, the risk is
   an exposed development server.)
4. **Secret theft.** Stream keys or API keys leaked from the database or logs.
5. **Abuse of our infrastructure.** Mass sign-ups, or an open dev server,
   burning AI budget; SSRF
   through user-supplied RTMP URLs; using the platform for TikTok Shop streams
   that ban AI voices.

## Decision

### Tenancy

- Every channel-scoped query goes through a repository function that takes
  the acting `userId` and filters by `owner_id`. Route handlers never query
  channel tables directly. A test suite creates two users and asserts every
  endpoint and WebSocket returns 404 (not 403, to avoid revealing that the
  resource exists) for the other user's resources.
- Studio WebSocket upgrades check ownership. Stage WebSockets are scoped by
  stage key to exactly one channel and are receive-only, apart from
  playback acks and telemetry, both validated.

### Authentication

Per [ADR-0018](0018-defer-authentication.md):

- **During development** there is no sign-in. `AUTH_MODE=dev` resolves every
  request to a development user; impersonation (`x-dev-user`) exists only in
  dev mode, for tenancy tests.
- **Guard against an open server:** the app refuses to start with
  `AUTH_MODE=dev` and `NODE_ENV=production` unless `DEV_GATE_PASSWORD` is
  set. With it set, the whole dashboard and API sit behind HTTP Basic auth
  over HTTPS; only stage URLs and webhooks (which carry their own keys or
  signatures) are outside the gate.
- **Before launch:** Clerk or WorkOS takes over sign-in, sessions, password
  policy, email verification, bot protection and device management. Our
  server verifies the provider's session on every HTTP request and WebSocket
  upgrade, and maps it to our `app_user` row.

### Request protection

- **CSRF:** SameSite=Lax cookies plus Hono's `csrf()` origin check on every
  state-changing request; the Stripe webhook is exempt and uses its signature
  instead.
- **Security headers:** `secureHeaders()` with a strict CSP for the dashboard:
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'
  data: blob:; media-src 'self' blob:; connect-src 'self' wss:; font-src
  'self'; frame-ancestors 'none'`. Fonts are self-hosted, so no third-party
  origins are needed (the identity provider's domains are added to the policy
  when it is integrated). The stage page gets its own policy that allows embedding
  in OBS. Also HSTS (via Caddy), `X-Content-Type-Options`,
  `Referrer-Policy: strict-origin-when-cross-origin`.
- **Input validation:** zod on every HTTP and WebSocket input; body size
  limits (`bodyLimit`: 64 KB API, 1 MB webhooks); persona text field length caps.
- **Rate limits:** the general API (per user and IP) and runtime commands
  (`say` at most 10 per minute, so a stolen session can't flood a stream).
  Sign-in rate limits come from the identity provider.

### Secrets

- **Encryption at rest** for stream keys and any future bring-your-own API
  keys: AES-256-GCM using WebCrypto, with a per-purpose key derived from
  `APP_SECRET` via HKDF and a random 96-bit IV per value. The ciphertext
  carries a key version for rotation.
- **Stage keys:** 128-bit random, shown in the dashboard (stored encrypted)
  and looked up by HMAC-SHA256 (`stage_key_lookup`), so a database leak
  doesn't give working stage URLs without `APP_SECRET`. Creators can rotate
  them in one click.
- **Write-only UI** for stream keys: the dashboard shows "set" and the last 4
  characters, never the value.
- **Logs:** a redaction list (authorization, cookie, stream keys, API keys,
  provider tokens) applied by the logger; request bodies are not logged.

### Abuse

- **Sign-ups (after the provider is added):** the provider's bot protection
  and email verification; going live requires a verified email. The free
  plan's live hours cap AI spend per account.
- **During development:** the dev gate above, plus deployment-level AI spend
  caps ([ADR-0012](0012-ai-and-voice-pipeline.md) budgets apply to dev users too).
- **SSRF:** RTMP destinations must be `rtmp://` or `rtmps://`; the hostname is
  resolved and private, loopback and link-local ranges are rejected before
  ffmpeg connects. The broadcaster runs on an internal network with egress
  only to the internet.
- **Terms:** no TikTok Shop livestreams; the AI disclosure badge can't be
  removed.

### Supply chain and operations

- Frozen lockfile in CI and Docker; dependency updates through PRs with tests.
- Containers run as non-root with read-only root filesystems where possible.
- An `audit_log` table records user provisioning, channel deletes,
  stream-key changes, plan changes and admin actions.
- A security review checklist runs before launch (Phase 7).

## Options Considered

### Option A: Defense in depth in the app (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Engineering time |
| Scalability | Good |
| Team familiarity | Standard practices |

**Pros:** each threat has a named control and a test.
**Cons:** controls must be kept in mind on every new endpoint (covered by the tenancy test suite and code review).

### Option B: Postgres row-level security for tenancy

| Dimension | Assessment |
|---|---|
| Complexity | Medium to high |
| Cost | Per-request role and settings management |
| Scalability | Good |
| Team familiarity | Lower |

**Pros:** tenancy enforced by the database even if app code forgets.
**Cons:** complicates connection pooling and the runtime (which acts across
channels); harder to test with PGlite. Reconsider when there are teams and
shared resources.

## Trade-off Analysis

Repository-layer scoping, plus a cross-tenant test suite that exercises every
endpoint, catches the same mistakes as row-level security with far less
operational complexity at this size. Encryption at rest with an
app-held key protects against database-dump leaks, the most likely way a
small SaaS gets breached.

## Consequences

- Easier: a clear checklist for new endpoints (validate, scope, rate-limit, audit).
- Harder: key rotation needs a re-encryption job (key versioning is designed in).
- Revisit: row-level security with teams; an external secrets manager if compliance requires it.

## Action Items

1. [ ] Implement the repository-layer scoping and the cross-tenant test suite (two dev users via impersonation).
2. [ ] Implement the dev-mode production guard and the `DEV_GATE_PASSWORD` gate ([ADR-0018](0018-defer-authentication.md)).
3. [ ] Implement `crypto.ts` (HKDF, AES-GCM, versioned ciphertext) and the stage-key HMAC lookup.
4. [ ] Configure CSP and security headers per surface (dashboard, stage, landing).
5. [ ] Add log redaction, `audit_log`, and the RTMP SSRF guard.
6. [ ] Run the pre-launch security checklist (Phase 7).
