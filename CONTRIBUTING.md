# Contributing

## Setup

You need [Bun](https://bun.sh) 1.4.2 (the version in `package.json`'s
`packageManager`). Nothing else: development uses an embedded Postgres
(PGlite), a simulated TikTok audience and an offline scripted host, so no
accounts or API keys are needed.

```bash
bun install
bun run dev
```

`bun run dev` starts the API server (port 8080, restarts on change) and Vite
(port 5173) together. Open http://localhost:5173:

| Path | What it is |
|---|---|
| `/` | Landing page |
| `/app` | Dashboard. No sign-in in development: you're the local user. |
| `/s/<stageKey>` | A host's stage page (copy the link from the host's Setup tab) |
| `/lab.html` | Engine lab: every emotion and look, `?demo` plays the scripted show |

To try the real AI host or voice, copy `.env.example` to `.env` and set
`ANTHROPIC_API_KEY` and/or `ELEVENLABS_API_KEY`. Every variable is
documented in `apps/server/src/config.ts`; production settings are in
[`deploy/.env.example`](deploy/.env.example).

## Layout

```
apps/server        Hono API, WebSockets, channel runtimes, billing (Bun)
apps/web           React dashboard, landing page, stage page (Vite)
apps/broadcaster   Headless Chromium + ffmpeg to RTMP (cloud broadcast)
packages/shared    Types, zod schemas, plans, protocol: shared by everything
packages/engine    The WebGL2 stage engine (no React, no DOM framework)
deploy/            Dockerfiles, Compose with Caddy, backups, runbooks
compose.dokploy.yaml  The same stack for Dokploy (its Traefik replaces Caddy)
docs/              Architecture, ADRs, API and protocol references
e2e/               Playwright end-to-end and accessibility tests
scripts/           Dev runner, import boundary check, load test
```

`bun run boundaries` enforces who may import whom
([ADR-0004](docs/adr/0004-monorepo-layout.md)): `shared` depends on nothing,
the engine only on `shared`, the web app imports server code for types only,
and the apps never import each other.

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | API server and Vite together |
| `bun run check` | Typecheck, import boundaries and unit tests: run before every push |
| `bun test` | Unit and integration tests (server, engine, broadcaster, shared) |
| `bun test apps/server/test/api` | One directory, or `bun test -t "name"` for one test |
| `bun run typecheck` | `tsc` in every workspace, plus the e2e and script files |
| `bun run build` | Builds the web app (prerender and bundle budgets included), the server and the broadcaster |
| `bun run e2e` | Playwright against a built app; run `bun run --filter @tik-live/web build` first |
| `bun scripts/load-test.ts --channels 50 --seconds 120` | Simulated hosts against a running server; reports event-loop lag, memory and CPU. Offline host by default; `--allow-ai` makes real, paid Claude calls. |
| `bun run --filter @tik-live/server db:generate` | Generates a migration after a schema change in `apps/server/src/db/schema.ts` |

CI (`.github/workflows/ci.yml`) runs `typecheck`, `boundaries`, `test` and
`build`, then the E2E suite, on every pull request.

## Tests

[ADR-0017](docs/adr/0017-testing-strategy.md) has the full strategy. In short:

- **Server:** API tests go through the real Hono app with an in-memory
  PGlite database (`apps/server/test/harness.ts`); outside services
  (Anthropic, ElevenLabs, Mercado Pago, the broadcaster) are fakes passed in
  through `AppDeps`. Tests never call a real paid API.
- **Engine:** pure logic (springs, the quality governor, text layout, the
  connection client) is unit tested; rendering is checked by Playwright,
  which reads pixels from `/lab.html?clock=manual`, where frames are
  deterministic (every emotion, captions and alerts, recovery from a lost
  GPU context).
- **Broadcaster:** the session state machine and the RTMP guard are unit
  tested with a fake pipeline; the real Chromium + ffmpeg path was verified
  by hand (see ADR-0014).
- **Web:** Playwright drives the built app end to end and runs axe on every
  main page; contrast or labeling failures fail the build.
- **Contracts:** `packages/shared/test` checks the schemas and that
  [`docs/protocol.md`](docs/protocol.md) documents every message type. A new
  protocol message needs a section there.

Rules: no skipped or quarantined tests; a flaky test gets fixed or made
deterministic (inject the clock, the random source, `fetch`).

## Conventions

- **TypeScript, strict.** No `any` without a comment saying why. Validate
  every input that crosses a trust boundary (HTTP, WebSocket, env, webhook)
  with zod.
- **API errors** use the one problem shape (`{ error: { code, message } }`)
  with a stable `code` and a message written for the person reading it: what
  happened and what to do. See [docs/api.md](docs/api.md).
- **The stage engine's frame loop doesn't allocate.** No closures, arrays or
  objects created per frame; reuse buffers. The engine's bundle budget is
  60 KB gzipped, the dashboard's 200 KB, the landing page's 120 KB; the
  build fails past them.
- **UI copy** is plain, sentence case, and names things the way creators do
  ("host", "stage link", "go live"), not the way the code does.
- **Secrets** (stream keys, stage keys, tokens) never reach logs, error
  messages or API responses. Stage keys in request paths are redacted by the
  request logger.
- **Commits:** one logical change each, with a message that says why.

## Decisions and ADRs

Significant decisions are recorded as ADRs in [`docs/adr`](docs/adr/README.md),
using the template in [ADR-0001](docs/adr/0001-record-architecture-decisions.md).

- A change that goes against an ADR needs a new ADR that supersedes it;
  accepted ADRs aren't edited.
- When you finish work an ADR lists as an action item, tick it.
- Choices only the owner can make (prices, providers, legal) go in
  [`docs/decisions-needed.md`](docs/decisions-needed.md) with the default the
  code uses until then.
