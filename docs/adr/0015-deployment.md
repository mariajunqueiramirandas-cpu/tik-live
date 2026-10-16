# ADR-0015: Deployment on a VPS

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

The owner will deploy to their own VPS. The deployment has to give us HTTPS,
WebSockets, Postgres, backups, safe migrations, quick restarts (running
channels resume within 10 s), and logs that are easy to read. It should be
operable by one person, with upgrades as boring as `git pull && docker
compose up -d`.

## Decision

**Docker Compose** on a single VPS (recommended starting size: 4 vCPU, 8 GB
RAM, 80 GB SSD; Ubuntu 24.04 LTS).

| Service | Image | Notes |
|---|---|---|
| `caddy` | `caddy:2` | Automatic HTTPS (Let's Encrypt), HTTP/2 and HTTP/3, WebSocket proxying, gzip and zstd for static files; the only service with public ports (80, 443) |
| `app` | Built from `deploy/app.Dockerfile` on `oven/bun:1.4` (slim) | Runs migrations at boot, serves API + WS + static; non-root user; read-only root filesystem with a tmpfs |
| `db` | `postgres:17-alpine` | Named volume; not exposed publicly; tuned `shared_buffers` and `max_connections` for the box |
| `backup` | `postgres:17-alpine` + cron script | Nightly `pg_dump -Fc`, keeps 7 daily and 4 weekly copies; optional upload to S3-compatible storage (`BACKUP_S3_*`) |
| `broadcaster` | Built from `deploy/broadcaster.Dockerfile` on the Playwright base image + Bun + ffmpeg | Behind the `broadcast` compose profile; CPU limits set; internal network only |

### Image build (multi-stage)

1. **deps:** `bun install --frozen-lockfile` (workspace-aware).
2. **build:** `bun run build`. Vite builds the dashboard, stage and the
   prerendered landing page; `bun build --target=bun` bundles the server.
3. **runtime:** copy the server bundle, `dist/web`, migrations and production
   `node_modules` only. `HEALTHCHECK` hits `/healthz`.

### Configuration

All settings come from environment variables in `.env` on the server,
validated with zod at boot (the app refuses to start with a clear message if
something required is missing):

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | e.g. `https://lantern.example.com` (cookies, CSRF origin, email links) |
| `APP_SECRET` | 32+ random bytes; key derivation for encryption and stage-key HMAC |
| `AUTH_MODE` | `dev` during development; `clerk` or `workos` once the provider is chosen ([ADR-0018](0018-defer-authentication.md)) |
| `DEV_GATE_PASSWORD` | Required to run `AUTH_MODE=dev` with `NODE_ENV=production`; puts the dashboard and API behind HTTP Basic auth |
| `DATABASE_URL` | `postgres://…` |
| `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` | Platform AI keys |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | Billing (omit for self-hosted mode) |
| `MAIL_FROM`, `SMTP_URL` or `RESEND_API_KEY` | Email |
| `BROADCAST_ENABLED`, `BROADCAST_MAX_CONCURRENT`, `BROADCASTER_TOKEN` | Cloud broadcast |
| `CLERK_SECRET_KEY` / `CLERK_PUBLISHABLE_KEY` or `WORKOS_API_KEY` / `WORKOS_CLIENT_ID` | Identity provider (later) |

### Operations

- **Deploy:** `docker compose pull && docker compose up -d` (or `build` on
  the box). The app drains on SIGTERM: it flushes stores, sends `hold` to
  stages and closes sockets. The new container reconciles running channels
  on boot. Expected interruption is under 10 s; OBS sources hold the last
  frame and reconnect by themselves.
- **Migrations:** at boot under an advisory lock
  ([ADR-0005](0005-data-layer.md)). Breaking schema changes use
  expand/contract across two deploys.
- **Health:** `/healthz` (process up), `/readyz` (database reachable,
  migrations applied, event-loop lag under 200 ms). Docker restarts unhealthy
  containers.
- **Logs:** structured JSON to stdout (request id, user id, channel id; secrets
  redacted). Read with `docker compose logs`. Optionally ship to Grafana Loki
  or Better Stack later.
- **Metrics (later):** `/metrics` in Prometheus format: running channels,
  sockets, turn latency, AI usage, event-loop lag.
- **Backups:** nightly; restore is documented and rehearsed (`pg_restore`
  into a scratch database) as part of Phase 5.
- **Hardening of the host:** SSH keys only, `ufw` allowing 22, 80 and 443,
  unattended security upgrades, Docker log rotation. A checklist lives in
  `deploy/README.md`.

### Alternative without Docker

`bun build --compile` produces a single binary for the server. With a
systemd unit, Postgres from apt and Caddy from apt, this is documented as a
secondary path for people who prefer it.

### CI/CD

GitHub Actions (`oven-sh/setup-bun`):

1. Install with the frozen lockfile.
2. `bun run typecheck`.
3. `bun test` (PGlite, no services).
4. `bun run build`, plus bundle size budgets.
5. E2E with Playwright against the built app (on `main` and PRs labeled `e2e`).
6. On tags: build and push images to GHCR.

Deploying to the VPS stays a manual `docker compose pull && up -d` at first;
a deploy workflow over SSH can come later.

## Options Considered

### Option A: Docker Compose with Caddy on one VPS (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low to medium |
| Cost | One VPS (~$20–40/month at the recommended size) |
| Scalability | Vertical first; the broadcaster can move to its own host |
| Team familiarity | High |

**Pros:** reproducible; one file describes the stack; automatic TLS; easy rollback (previous image tag).
**Cons:** single host is a single point of failure (mitigated by backups and fast restore).

### Option B: Kubernetes (k3s)

| Dimension | Assessment |
|---|---|
| Complexity | High |
| Cost | Same hardware, more ops time |
| Scalability | Excellent |
| Team familiarity | Medium |

**Pros:** rolling deploys, self-healing.
**Cons:** far more operational surface than one VPS needs.

### Option C: A PaaS (Fly.io, Railway, Render)

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Higher per unit of compute; broadcast CPU gets expensive |
| Scalability | Good |
| Team familiarity | Medium |

**Pros:** no server administration.
**Cons:** the owner asked for a VPS; long-lived WebSockets and CPU-heavy
broadcasts cost more on a PaaS.

## Trade-off Analysis

Compose on one VPS is the least operational surface that still gives HTTPS,
isolation between services, health checks and reproducible deploys. The
architecture keeps a path to more hosts: the broadcaster is already separate,
and runtimes can move later ([ADR-0007](0007-channel-runtime.md)).

## Consequences

- Easier: first deploy in under an hour; upgrades with one command.
- Harder: single-host availability; the owner handles OS updates.
- Revisit: managed Postgres and a second app host once revenue justifies uptime guarantees.

## Action Items

1. [ ] Write `deploy/app.Dockerfile`, `deploy/compose.yaml`, `deploy/Caddyfile` and `deploy/backup.sh`.
2. [ ] Write `deploy/README.md`: first-time setup, DNS, `.env` reference, upgrade, rollback, backup and restore, host hardening.
3. [ ] Update CI to Bun with build budgets and an image publish on tags.
4. [ ] Rehearse: fresh VPS → running stack → restore from backup.
