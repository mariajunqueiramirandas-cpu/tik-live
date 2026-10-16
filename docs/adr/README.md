# Architecture decision records

Each record captures one significant decision: the context, the options we
weighed, what we chose and what it costs us. Format and process are set by
[ADR-0001](0001-record-architecture-decisions.md).

| # | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Proposed |
| [0002](0002-bun-runtime-and-toolchain.md) | Bun as runtime and toolchain | Proposed |
| [0003](0003-hono-server.md) | Hono for HTTP and WebSockets | Proposed |
| [0004](0004-monorepo-layout.md) | Monorepo layout with Bun workspaces | Proposed |
| [0005](0005-data-layer.md) | PostgreSQL, Drizzle ORM and PGlite | Proposed |
| [0006](0006-authentication.md) | Better Auth for accounts and sessions | Rejected (superseded by 0018) |
| [0007](0007-channel-runtime.md) | Multi-tenant channel runtime | Proposed |
| [0008](0008-realtime-protocol.md) | Realtime protocol | Proposed |
| [0009](0009-stage-engine.md) | WebGL2 stage engine | Proposed |
| [0010](0010-frontend-stack.md) | Frontend stack | Proposed |
| [0011](0011-design-direction.md) | Design direction | Proposed |
| [0012](0012-ai-and-voice-pipeline.md) | AI and voice pipeline | Proposed |
| [0013](0013-billing-and-plans.md) | Billing and plans | Proposed |
| [0014](0014-cloud-broadcast.md) | Cloud broadcast | Proposed |
| [0015](0015-deployment.md) | Deployment on a VPS | Proposed |
| [0016](0016-security.md) | Security model | Proposed |
| [0017](0017-testing-strategy.md) | Testing strategy | Proposed |
| [0018](0018-defer-authentication.md) | No authentication during development; Clerk or WorkOS later | Proposed |

## Evidence used

The Bun and Hono decisions rest on a compatibility spike run on 2026-10-16
(Bun 1.4.2, Linux x64). Every check passed:

| Check | Result |
|---|---|
| `tiktok-live-connector` imports and constructs a connection | ok (live connect not tested: TikTok unreachable from the spike environment) |
| `@electric-sql/pglite` in-memory query | ok |
| `Bun.SQL` (SQLite in-memory query; Postgres client present) | ok |
| `Bun.password` argon2id hash and verify | ok (no longer needed, see ADR-0018) |
| `hono/bun` WebSocket helpers (`upgradeWebSocket`, `websocket`, `serveStatic`) | ok |
| `@anthropic-ai/sdk`, `obs-websocket-js`, `drizzle-orm/bun-sql`, `drizzle-orm/pglite` | ok |
| Better Auth on Hono: sign-up, session cookie, `getSession` | ok (option rejected, see ADR-0018) |
| `playwright-core` launches headless Chromium with WebGL2 (SwiftShader) | ok |
| `MediaRecorder` in headless Chromium | VP8/VP9 + Opus only; **no H.264** |
| Vite 8 under `bun --bun` | ok |
