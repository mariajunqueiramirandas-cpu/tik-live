# ADR-0002: Bun as runtime and toolchain

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

v0.1 runs on Node 22 with npm, tsx, tsc and vitest. The owner wants Bun. The
backend has to hold many WebSocket connections (stage clients, dashboards),
run many channel runtimes concurrently, call external APIs, and start fast
after a deploy so running channels come back quickly. A smaller toolchain
(one tool for install, run, test and bundle) also means fewer moving parts on
the VPS.

What has to work on the runtime: the unofficial TikTok connector, the
Anthropic SDK, Postgres access, WebSockets, OBS WebSocket,
and (for cloud broadcast) Playwright driving Chromium.

## Decision

Use **Bun 1.4** for:

- **Runtime** for `apps/server` and `apps/broadcaster`. TypeScript runs
  directly; no transpile step in development.
- **Package manager:** `bun install` with workspaces and the text `bun.lock`
  lockfile.
- **Test runner:** `bun test` for unit and integration tests.
- **Server bundling:** `bun build --target=bun` for the production image.
  `bun build --compile` (single binary) is the option for non-Docker deploys.

Keep **`tsc --noEmit`** for type checking, because Bun strips types without
checking them. Vite runs the frontend build under Bun (`bunx --bun vite`).

Use Bun-native APIs only behind small interfaces, so moving runtimes later
means rewriting one file, not the codebase:

| Bun API | Used for | Wrapped by |
|---|---|---|
| `Bun.serve` WebSockets and pub/sub | Realtime hubs | `hono/bun` adapter plus `RealtimeHub` |
| `Bun.SQL` | Postgres driver | Drizzle `bun-sql` driver |
| `Bun.file` | Static files | `serveStatic` from `hono/bun` |

## Options Considered

### Option A: Bun 1.4 (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low: one tool replaces npm, tsx, vitest and esbuild |
| Cost | Free; lower memory and faster cold start than Node in typical servers |
| Scalability | Native WebSocket server with built-in pub/sub, a good fit for fan-out to stage and studio clients |
| Team familiarity | Owner's preference; Node-compatible APIs keep most knowledge transferable |

**Pros:** fast installs and startup; native TypeScript; built-in WebSocket
pub/sub and Postgres client; a Jest-compatible test runner. The spike
showed every critical dependency working (see the [index](README.md#evidence-used)).
**Cons:** younger than Node, so the long tail of Node-compat edge cases is
real; some tools (the Playwright test runner) officially target Node.

### Option B: Stay on Node 22 + npm

| Dimension | Assessment |
|---|---|
| Complexity | Medium: separate tools for TS execution, tests and bundling |
| Cost | Free |
| Scalability | Proven; WebSocket fan-out needs `ws` plus our own topic routing |
| Team familiarity | Already in place |

**Pros:** maximum ecosystem compatibility; v0.1 already runs on it.
**Cons:** more tooling; slower installs and startup; the owner prefers Bun.

### Option C: Deno 2

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Free |
| Scalability | Good |
| Team familiarity | Low |

**Pros:** secure-by-default permissions; built-in tooling.
**Cons:** npm compatibility for the TikTok connector and Playwright is less
proven; not what the owner asked for.

## Trade-off Analysis

The main risk with Bun is Node-compat surprises in dependencies we don't
control, the TikTok connector above all. Its live websocket path couldn't be
exercised in the spike because TikTok was unreachable. The connector sits
behind the `EventSource` interface, so if Bun can't run it, we run the
connector alone in a small Node sidecar that forwards normalized events over a
local socket. That is a contained fallback, not a rewrite. The upside (one
fast toolchain, native WebSocket pub/sub and Postgres) is worth
that risk.

## Consequences

- Easier: one command set (`bun install`, `bun test`, `bun run`); quicker CI
  and deploys; simpler Docker images (`oven/bun`).
- Harder: some libraries need verification on Bun before adoption. E2E tests
  with `@playwright/test` run under Node in CI (see
  [ADR-0017](0017-testing-strategy.md)).
- Revisit: if a critical dependency breaks on Bun, apply the sidecar pattern
  above before considering a runtime change.

## Action Items

1. [ ] Replace npm/tsx/vitest with Bun in the root and every workspace; commit `bun.lock`.
2. [ ] Port the v0.1 tests from vitest to `bun test` (same `expect` API; replace `vi` helpers).
3. [ ] Add `oven-sh/setup-bun` to CI; pin the Bun version in `package.json` (`packageManager`) and the Dockerfile.
4. [ ] Verify a real TikTok LIVE connection under Bun in Phase 1; if it fails, build the Node sidecar.
