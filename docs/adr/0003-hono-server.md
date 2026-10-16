# ADR-0003: Hono for HTTP and WebSockets

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

The backend serves a JSON API (auth, channels, runtime control, analytics,
billing), Stripe webhooks, static assets (the dashboard SPA and the stage
page), audio clips for the stage, and two kinds of WebSocket connection
(stage and studio). It runs on Bun ([ADR-0002](0002-bun-runtime-and-toolchain.md)).
The React dashboard should call the API with compile-time type safety, so
backend changes that break the frontend fail the build instead of failing in
production. The owner asked for Hono.

## Decision

Use **Hono 4** on the Bun adapter.

- **Server:** `Bun.serve({ fetch: app.fetch, websocket })` with
  `upgradeWebSocket` and `websocket` from `hono/bun`.
- **Routing:** one Hono app composed of route modules: `auth`, `channels`,
  `runtime`, `analytics`, `billing`, `stage`, `health`. Each module exports a
  sub-app, mounted with `app.route()`.
- **Typed client:** export `type AppType = typeof routes` from the server.
  The dashboard uses `hc<AppType>()` from `hono/client`, so request and
  response types come from the server code.
- **Validation:** `@hono/zod-validator` on every input (JSON, query, params),
  using schemas from `packages/shared`.
- **Middleware**, in order:
  1. Request ID and structured JSON access log.
  2. `secureHeaders()` with a strict CSP (see [ADR-0016](0016-security.md)).
  3. `csrf()`: checks `Origin` on state-changing requests.
  4. Rate limiting (`hono-rate-limiter` with an in-memory store; Postgres or
     Redis store later if we run more than one instance).
  5. Identity resolution through `IdentityProvider` (dev mode now, Clerk or
     WorkOS later; [ADR-0018](0018-defer-authentication.md)) into `c.var.user`.
  6. Error handler that maps zod and domain errors to a consistent JSON
     problem shape (`{ error: { code, message, details? } }`) and never leaks
     stack traces.
- **WebSockets:** Hono's `upgradeWebSocket` authenticates the upgrade (the
  resolved identity for studio, a stage key for stage). It then subscribes the raw Bun
  socket to a channel topic, and the runtime publishes with
  `server.publish(topic, data)`. See [ADR-0008](0008-realtime-protocol.md).
- **Static files:** `serveStatic` from `hono/bun` for hashed assets (immutable
  cache headers) with an SPA fallback to `index.html` for dashboard routes.
  Caddy adds compression.

## Options Considered

### Option A: Hono (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low: small API, built on web standards (`Request`/`Response`) |
| Cost | Free |
| Scalability | Among the fastest routers on Bun; no Node-only internals |
| Team familiarity | Owner's choice; Express-like ergonomics |

**Pros:** typed RPC client without code generation; first-class Bun
WebSocket support; built-in `csrf`, `secureHeaders`, `bodyLimit`, `timeout`;
web-standard handlers that are trivially testable with `app.request()`.
**Cons:** the RPC types get heavy if one app grows huge (mitigated by splitting
route modules and exporting per-module types); fewer batteries than Fastify
(no built-in schema-to-OpenAPI unless we add `hono-openapi` later).

### Option B: Elysia

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Free |
| Scalability | Excellent on Bun |
| Team familiarity | Lower |

**Pros:** Bun-native; Eden typed client; very fast.
**Cons:** Bun-only (harder to leave Bun); a smaller ecosystem than Hono; not
the owner's choice.

### Option C: Fastify on Bun

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Free |
| Scalability | Excellent on Node; Bun support is via Node compat |
| Team familiarity | Medium |

**Pros:** mature plugin ecosystem; JSON-schema validation.
**Cons:** built for Node's `http` module, so its WebSocket plugin doesn't use
Bun's native pub/sub; no typed client without extra tooling.

## Trade-off Analysis

The typed client is what tips it. With `hc<AppType>`, renaming a field in an
API response breaks the dashboard's type check in CI. That catches the most
common class of SaaS frontend bug. Hono also keeps us portable: the same
handlers would run on Node or at the edge if a piece of the system ever moved.

## Consequences

- Easier: end-to-end type safety; API tests without a running server; small,
  readable route modules.
- Harder: the RPC typing needs discipline (each route returns `c.json(...)`
  with explicit types; avoid `any` responses).
- Revisit: add OpenAPI generation if we publish a public API.

## Action Items

1. [ ] Scaffold `apps/server` with the Hono app, middleware chain and error shape.
2. [ ] Export `AppType` and wire `hc<AppType>` in `apps/web`.
3. [ ] Add a CI check that fails if `apps/web` doesn't type-check against the server types.
