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
| [0009](0009-stage-engine.md) | WebGL2 stage engine | Proposed (the character's place amended by 0049) |
| [0010](0010-frontend-stack.md) | Frontend stack | Proposed |
| [0011](0011-design-direction.md) | Design direction | Proposed (palette, UI type and studio monitor amended by 0042) |
| [0012](0012-ai-and-voice-pipeline.md) | AI and voice pipeline | Proposed (voice amended by 0021 and 0030, pacing by 0022 and 0031, prompt by 0025 and 0040, models and context by 0026) |
| [0013](0013-billing-and-plans.md) | Billing and plans | Proposed |
| [0014](0014-cloud-broadcast.md) | Cloud broadcast | Proposed (pipeline amended by 0020) |
| [0015](0015-deployment.md) | Deployment on a VPS | Proposed (amended by 0019) |
| [0016](0016-security.md) | Security model | Proposed |
| [0017](0017-testing-strategy.md) | Testing strategy | Proposed |
| [0018](0018-defer-authentication.md) | No authentication during development; Clerk or WorkOS later | Proposed |
| [0019](0019-dokploy.md) | Deploy with Dokploy | Proposed |
| [0020](0020-broadcast-pipeline-avx2.md) | Broadcast pipeline for CPU-only AVX2 hosts | Proposed |
| [0021](0021-self-hosted-tts.md) | A self-hosted Brazilian Portuguese voice | Proposed (default voice amended by 0030) |
| [0022](0022-host-turn-taking.md) | Host turn-taking and speech pacing | Proposed (scheduling amended by 0026, gift urgency by 0046) |
| [0023](0023-chat-minigames.md) | Chat minigames, game scenes and stage reactions | Proposed (gift reactions amended by 0046) |
| [0024](0024-music-as-code.md) | Music as code | Proposed (recorded tracks for the DJ allowed by 0045) |
| [0025](0025-host-context-and-memory.md) | What the host knows each turn | Proposed (amended by 0026 and 0033) |
| [0026](0026-turn-engine-and-context-cache.md) | A turn engine over one cached conversation, on Claude Haiku 5.5 | Proposed (head and folding amended by 0033) |
| [0027](0027-brazilian-portuguese-product.md) | The product is in Brazilian Portuguese | Accepted |
| [0028](0028-up-next-likes-and-loop-ranking.md) | Up next, a 15-minute like ranking, and a loop ranking with a podium | Proposed (stage panels amended by 0049) |
| [0029](0029-gifts-power-ups-and-final-vote.md) | A gift ranking, gift combos and power-ups, and chat's vote on the last segment | Proposed |
| [0030](0030-fish-audio-default-voice.md) | Fish Audio Drama 3, through OpenRouter, is the default voice | Proposed |
| [0031](0031-not-every-message-needs-an-answer.md) | Not every message needs an answer, and chat can't hold the show | Proposed |
| [0032](0032-gifts-and-supporting-the-show.md) | Bigger gift moments, and how viewers can support the show | Proposed (on-screen support amended by 0041 and 0049, gift moments by 0046) |
| [0033](0033-host-memory.md) | Host memory that's cheap, fast and accurate | Proposed |
| [0034](0034-names-that-sound-rude.md) | Names that sound rude out loud | Proposed |
| [0035](0035-automatic-run-of-show.md) | A run of show the host plans by itself | Proposed (segment draw amended by 0044) |
| [0036](0036-like-and-gift-goals.md) | Like and gift goals on stage | Proposed (the goal panel amended by 0049) |
| [0037](0037-fan-levels-and-passers-by.md) | Fan levels, and catching people scrolling past | Proposed (the call's banner amended by 0049) |
| [0038](0038-games-of-chance-and-party-games.md) | Games of chance and party games | Proposed (the race and the wheel taken out by 0043) |
| [0039](0039-gift-powers.md) | Gift powers | Proposed (the powers card amended by 0041, the badge and alerts by 0049) |
| [0040](0040-room-challenges-and-opinions.md) | Room challenges, a more forward host, and opinions on everything | Proposed (the challenge banner amended by 0049) |
| [0041](0041-support-ticker-and-gift-showcase.md) | An always-on support ticker and a gift showcase | Proposed (their look amended by 0049) |
| [0042](0042-dashboard-visual-refresh.md) | Dashboard visual refresh | Proposed |
| [0043](0043-remove-betting-games.md) | Take out the betting games | Proposed |
| [0044](0044-segments-that-work.md) | The show leans toward the segments that work | Proposed |
| [0045](0045-automatic-dj.md) | An automatic DJ with Creative Commons tracks | Proposed (the chip's place amended by 0049) |
| [0046](0046-gifts-first-and-hype-mode.md) | Gifts first, every time, and hype mode on stage | Proposed |
| [0047](0047-bridge-agent-pairing-and-distribution.md) | Pairing and handing out the Local Bridge Agent | Proposed |
| [0048](0048-live-studio-bridge-reliability.md) | One TikTok LIVE Studio client, one socket, no lost stops | Proposed |
| [0049](0049-stage-hud-redesign.md) | A stage HUD built to keep people watching | Proposed |

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
