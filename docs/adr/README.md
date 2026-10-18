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
| [0012](0012-ai-and-voice-pipeline.md) | AI and voice pipeline | Proposed (voice amended by 0021 and 0030, pacing by 0022 and 0031, prompt by 0025, models and context by 0026) |
| [0013](0013-billing-and-plans.md) | Billing and plans | Proposed |
| [0014](0014-cloud-broadcast.md) | Cloud broadcast | Proposed (pipeline amended by 0020) |
| [0015](0015-deployment.md) | Deployment on a VPS | Proposed (amended by 0019) |
| [0016](0016-security.md) | Security model | Proposed |
| [0017](0017-testing-strategy.md) | Testing strategy | Proposed |
| [0018](0018-defer-authentication.md) | No authentication during development; Clerk or WorkOS later | Proposed |
| [0019](0019-dokploy.md) | Deploy with Dokploy | Proposed |
| [0020](0020-broadcast-pipeline-avx2.md) | Broadcast pipeline for CPU-only AVX2 hosts | Proposed |
| [0021](0021-self-hosted-tts.md) | A self-hosted Brazilian Portuguese voice | Proposed (default voice amended by 0030) |
| [0022](0022-host-turn-taking.md) | Host turn-taking and speech pacing | Proposed (scheduling amended by 0026) |
| [0023](0023-chat-minigames.md) | Chat minigames, game scenes and stage reactions | Proposed |
| [0024](0024-music-as-code.md) | Music as code | Proposed |
| [0025](0025-host-context-and-memory.md) | What the host knows each turn | Proposed (amended by 0026 and 0033) |
| [0026](0026-turn-engine-and-context-cache.md) | A turn engine over one cached conversation, on Claude Haiku 5.5 | Proposed (head and folding amended by 0033) |
| [0027](0027-brazilian-portuguese-product.md) | The product is in Brazilian Portuguese | Accepted |
| [0028](0028-up-next-likes-and-loop-ranking.md) | Up next, a 15-minute like ranking, and a loop ranking with a podium | Proposed |
| [0029](0029-gifts-power-ups-and-final-vote.md) | A gift ranking, gift combos and power-ups, and chat's vote on the last segment | Proposed |
| [0030](0030-fish-audio-default-voice.md) | Fish Audio Drama 3, through OpenRouter, is the default voice | Proposed |
| [0031](0031-not-every-message-needs-an-answer.md) | Not every message needs an answer, and chat can't hold the show | Proposed |
| [0032](0032-gifts-and-supporting-the-show.md) | Bigger gift moments, and how viewers can support the show | Proposed |
| [0033](0033-host-memory.md) | Host memory that's cheap, fast and accurate | Proposed |
| [0034](0034-names-that-sound-rude.md) | Names that sound rude out loud | Proposed |
| [0035](0035-automatic-run-of-show.md) | A run of show the host plans by itself | Proposed |
| [0036](0036-like-and-gift-goals.md) | Like and gift goals on stage | Proposed |
| [0037](0037-fan-levels-and-passers-by.md) | Fan levels, and catching people scrolling past | Proposed |

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
