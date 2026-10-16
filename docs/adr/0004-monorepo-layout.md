# ADR-0004: Monorepo layout with Bun workspaces

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

Four codebases share types and must change together: the server, the
dashboard, the stage engine (used by the stage page, the dashboard preview and
the landing page hero) and the cloud broadcaster. Shared contracts include the
WebSocket protocol, the persona schema, plan limits and API types. Keeping
them in separate repositories would turn every protocol change into a
coordinated multi-repo release.

## Decision

One repository with **Bun workspaces**:

```
apps/
  server/        @tik-live/server       Bun + Hono backend and channel runtimes
  web/           @tik-live/web          React dashboard + landing + stage page (Vite, multi-entry)
  broadcaster/   @tik-live/broadcaster  Headless renderer + ffmpeg (Phase 6)
packages/
  shared/        @tik-live/shared       zod schemas, protocol types, plans, constants
  engine/        @tik-live/engine       WebGL2 stage engine (no runtime deps)
deploy/          Dockerfiles, compose.yaml, Caddyfile, backup script
docs/            Architecture overview, plan, ADRs
```

- Internal packages are consumed **as TypeScript source** (`"exports":
  { ".": "./src/index.ts" }`). Bun and Vite both compile TS directly, so
  there's no build step and no stale `dist/` between packages.
- `tsconfig.base.json` at the root holds strict compiler options. Each
  workspace extends it and runs `tsc --noEmit` in `typecheck`.
- The stage page is a second Vite entry (`stage.html`) in `apps/web`. It
  imports `@tik-live/engine` but not React, so its bundle stays tiny while
  sharing the build pipeline with the dashboard.
- Root scripts:

| Script | Does |
|---|---|
| `bun run dev` | Server (watch) and Vite dev server together; Vite proxies `/api` and `/ws` to the server |
| `bun run typecheck` | `tsc --noEmit` in every workspace |
| `bun test` | All unit and integration tests |
| `bun run build` | Vite build for web and stage; server bundle |
| `bun run e2e` | Playwright end-to-end suite |

- Dependency rules, enforced by review and an import-boundary lint check:
  `shared` imports nothing internal; `engine` imports only `shared` (protocol
  types); `server` imports `shared`; `web` imports `shared`, `engine`, and
  `server` **types only** (for `AppType`).

## Options Considered

### Option A: Bun workspaces, source-consumed packages (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | None |
| Scalability | Fine up to dozens of packages |
| Team familiarity | Standard workspace model |

**Pros:** one install, one lockfile, atomic cross-package changes, no build orchestration.
**Cons:** no task caching (acceptable at this size).

### Option B: Turborepo or Nx on top of workspaces

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Free (remote cache optional) |
| Scalability | Excellent for large repos |
| Team familiarity | Medium |

**Pros:** task caching and dependency-aware pipelines.
**Cons:** more configuration than five packages need. Easy to add later.

### Option C: Separate repositories

| Dimension | Assessment |
|---|---|
| Complexity | High |
| Cost | Release coordination time |
| Scalability | Good for independent teams |
| Team familiarity | n/a |

**Pros:** independent deploys.
**Cons:** protocol changes need lockstep releases across repos; not worth it for one product team.

## Trade-off Analysis

Source-consumed packages remove the most common monorepo pain (forgetting to
rebuild a package) at the cost of every consumer needing a TS-aware toolchain,
which all of ours are. Add Turborepo when builds take long enough to matter.

## Consequences

- Easier: a protocol change and both of its ends land in one PR, type-checked together.
- Harder: the boundary rules need enforcing so `engine` doesn't grow app dependencies.
- Revisit: add task caching if CI time exceeds about 10 minutes.

## Action Items

1. [x] Move v0.1 `src/` into `apps/server/src/runtime/` (see the [plan](../architecture/plan.md#migration-from-v01)).
2. [x] Create `packages/shared` and move the persona schema, event types and protocol types there.
3. [x] Add `tsconfig.base.json`, workspace `tsconfig.json`s and root scripts.
4. [x] Add an import-boundary check (a small script over `bun build --metafile` or a lint rule) (`scripts/check-boundaries.ts`, run in CI).
