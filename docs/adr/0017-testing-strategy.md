# ADR-0017: Testing strategy

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

The owner asked for something that "doesn't feel buggy". Bugs in this
product show up in three different places: logic (director, triage, safety,
billing), integration (API, auth, database, WebSockets), and pixels and timing
(the stage engine and the dashboard). v0.1 has 45 unit tests on vitest; the
new system needs coverage at every layer without slow or flaky suites.

## Decision

| Layer | Tool | What it covers | Runs |
|---|---|---|---|
| Unit | `bun test` | Pure logic: triage, director (fake clock), sentences, safety rules, prompt building, plans and entitlements, engine math (springs, layout, quality governor, syllable envelope), protocol schemas | Every push; under 10 s |
| Integration (server) | `bun test` + PGlite in-memory + `app.request()` | Every API route against a real migrated Postgres dialect: identity modes and the dev gate, channel CRUD, tenancy isolation (two dev users via impersonation), runtime start/stop/reconcile, WebSocket protocol (Bun server on an ephemeral port), Mercado Pago webhooks against a simulated API, write-behind flushing | Every push; under 60 s |
| Contract | `bun test` in `packages/shared` | Every protocol message round-trips its zod schema; version handling | Every push |
| Type safety | `tsc --noEmit` per workspace | Including the dashboard against the server's `AppType` | Every push |
| End-to-end | `@playwright/test` (run with Node in CI) against the built app with PGlite and the simulator source | Open the dashboard (dev identity) → create channel → start → studio shows transcript → pause → stop; character editor autosave; stage page renders and acknowledges playback | PRs labeled `e2e`, and `main` |
| Visual | Playwright screenshots of the engine in deterministic mode (`seed`, fixed clock, `renderAt(t)`) | Each emotion, alerts, captions, voice-line mode; compared with a tolerance against committed baselines | With E2E |
| Engine robustness | Playwright | Context loss and restore (`WEBGL_lose_context`), no allocation growth in the frame loop (heap snapshots over 30 s), reconnect behavior | With E2E |
| Performance budgets | Build script | Bundle sizes for stage, dashboard and landing | Every push |
| Load (manual, Phase 7) | A Bun script spawning N simulated channels and M stage and studio sockets | Event-loop lag, memory per channel, turn latency with a fake brain | Before launch and on major changes |

**Rules**

- **No real network in automated tests.** Claude, ElevenLabs, Mercado Pago and
  TikTok sit behind interfaces with fakes (the v0.1 pattern: `FakeHost`,
  fake TTS, fake `EventSource`). A small opt-in smoke suite
  (`LIVE_SMOKE=1`) hits the real Claude and ElevenLabs APIs with tiny
  budgets, for manual runs before releases.
- **Time is injected.** Anything that schedules uses an injected clock (as in
  v0.1), so tests never sleep.
- **A flaky test is a bug.** Fix it or delete the behavior; never retry-to-pass
  or quarantine.
- **Every bug fix adds the test that would have caught it.**

## Options Considered

### Option A: `bun test` + PGlite + Playwright (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Free; CI minutes modest |
| Scalability | Fast suites at every layer |
| Team familiarity | Jest-compatible API; Playwright is the standard for E2E |

**Pros:** real Postgres semantics without Docker; deterministic engine
screenshots; one test runner for unit and integration.
**Cons:** Playwright's test runner targets Node, so E2E runs under Node in CI
(the app under test still runs on Bun).

### Option B: vitest everywhere (as in v0.1)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Free |
| Scalability | Good |
| Team familiarity | High |

**Pros:** browser mode for component tests.
**Cons:** a second toolchain next to Bun; slower startup.

### Option C: Integration tests against Docker Postgres (testcontainers)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Slower CI; Docker required locally |
| Scalability | Good |
| Team familiarity | Medium |

**Pros:** exact production server.
**Cons:** slow and heavy compared with in-process PGlite for the same dialect.

## Trade-off Analysis

PGlite gives Postgres-dialect integration tests at unit-test speed, which is
what makes testing every endpoint (including cross-tenant checks) affordable.
Deterministic rendering makes visual tests reliable, instead of the usual flaky
screenshot diffs.

## Consequences

- Easier: confident refactors; regressions in pixels and timing caught before release.
- Harder: maintaining screenshot baselines (update deliberately, with the diff reviewed).
- Revisit: component tests (Vitest browser mode or Playwright CT) if dashboard logic grows complex.

## Action Items

1. [x] Port the v0.1 tests to `bun test`.
2. [x] Build test helpers: migrated PGlite per file, an authenticated user factory, a channel factory, a WebSocket test client.
3. [x] Add the Playwright E2E suite and deterministic engine screenshots with baselines (pixel-probe engine checks and axe accessibility scans).
4. [x] Add bundle budgets to the build and CI.
5. [x] Write the load-test script (Phase 7) (`scripts/load-test.ts`).
