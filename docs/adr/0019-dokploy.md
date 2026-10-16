# ADR-0019: Deploy with Dokploy

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner
**Amends:** [ADR-0015](0015-deployment.md) (the plain-VPS setup stays supported)

## Context

The owner will deploy on [Dokploy](https://dokploy.com), a self-hosted
platform that builds and runs Docker Compose projects and routes domains to
them through its own Traefik (v3.6.25 by default). ADR-0015's stack assumes
it owns the server: Caddy binds ports 80 and 443, and Caddy also provides
compression, the HSTS header and long WebSocket timeouts. Under Dokploy,
Traefik already holds 80 and 443, and Dokploy has rules of its own:

- it clones the repository again on every deploy, so bind mounts inside the
  checkout are wiped;
- it writes the Environment tab to `.env` next to the compose file and runs
  `docker compose -p <app> -f <path> --env-file <dir>/.env up -d --build`;
- when a domain points at a service, it adds Traefik labels plus
  `dokploy-network` to that service; that network is shared by every
  Dokploy project on the server.

## Decision

- **A second compose file, `compose.dokploy.yaml`, at the repository root**
  (root, so relative paths resolve the same even if Dokploy adds
  `--project-directory`). Same images, Dockerfiles, settings and database
  configuration as `deploy/compose.yaml`; a test (`scripts/compose.test.ts`)
  fails if the two drift apart.
  - No Caddy and no published ports; the app `expose`s 8080 and Traefik
    routes to it through the domain configured in Dokploy's UI.
  - Data only in named volumes (`db_data`, `backups`).
  - Services reach each other only through `lantern-*` aliases on an
    internal network (`lantern-app`, `lantern-db`, `lantern-broadcaster`).
  - The broadcaster stays behind a Compose profile, turned on with
    `COMPOSE_PROFILES=broadcast` in the Environment tab.
- **The app compresses its own responses** instead of relying on the proxy:
  the web build writes Brotli and gzip copies of every text asset, HTML
  rendered at startup is compressed once, and API JSON over 1 KB is
  gzipped. HSTS was already sent by the app. This also helps every other
  deployment.
- **`.env` files never enter Docker build contexts** (`.dockerignore`),
  because Dokploy's `.env` with every secret sits at the repository root.
- Runbook: [`deploy/DOKPLOY.md`](../../deploy/DOKPLOY.md).

## Evidence

Tested locally with Traefik v3.6.25 configured like Dokploy's (Docker
provider on `dokploy-network`, default timeouts, no forwarded-header trust)
and the labels and networks Dokploy injects for a domain:

| Check | Result |
|---|---|
| Routing, staging gate, health checks through Traefik | ok |
| Stage and studio WebSockets held open for 150 s (Traefik v3's 60 s `readTimeout` default doesn't cut them) | ok, no timeout settings needed |
| A forged `X-Forwarded-For` from a client | replaced by Traefik with the real address, so `TRUST_PROXY=true` stays safe |
| A host live for 76 s through Traefik | 17 spoken lines and 9 alerts reached the stage; studio patches, transcript and events flowed |
| Cloud broadcast from the Dokploy layout into an RTMP sink | H.264 720x1280 at 30 fps plus AAC |
| Brotli assets and HTML, HSTS, CSP through Traefik | ok |
| Another project's container answering to `db` on `dokploy-network` | a bare `db` lookup in the app resolved to **that** container; `lantern-db` resolved to ours, which is why every hostname is prefixed |
| `COMPOSE_PROFILES` in the `--env-file` | turns the broadcaster on and off |
| A root `.env` in the build context | excluded |

Not tested: Dokploy's own UI and its HTTPS certificate issuance, which need
a real server and domain.

## Options Considered

### Option A: A Dokploy-specific compose file (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low: one more file, guarded by a test |
| Cost | None |
| Scalability | Same as ADR-0015 |
| Team familiarity | High |

**Pros:** one service in Dokploy deploys everything; same networks and
isolation as the plain-VPS setup; deploys on push.
**Cons:** two compose files to keep in step (the test enforces it).

### Option B: Dokploy "Applications" plus a Dokploy-managed Postgres

**Pros:** Dokploy's own database backups and rollbacks per application.
**Cons:** three or four separately configured services; the broadcaster's
private link to the app and the internal-only database network would have
to be rebuilt by hand; drifts from the tested compose setup.

### Option C: Keep Caddy behind Traefik

**Pros:** no change to the existing compose file.
**Cons:** two proxies and two certificate paths; port conflicts to work
around; nothing gained.

## Consequences

- Easier: deploying from the Dokploy UI with automatic HTTPS and
  deploy-on-push; compression no longer depends on the proxy.
- Harder: compose changes are made in two files (CI validates both and the
  test compares them).
- Behind a Cloudflare proxy, Traefik must be told to trust Cloudflare's
  forwarded headers or per-IP rate limits see Cloudflare's addresses
  (documented in the runbook).

## Action Items

1. [x] Write `compose.dokploy.yaml`, `deploy/dokploy.env.example` and `deploy/DOKPLOY.md`.
2. [x] Compress responses in the app; keep `.env` files out of build contexts.
3. [x] Test the layout behind Traefik v3.6.25 with Dokploy's labels (table above).
4. [x] Validate both compose files in CI.
5. [ ] Owner: first deploy on the real server; confirm HTTPS issuance and the checks in the runbook's step 5.
