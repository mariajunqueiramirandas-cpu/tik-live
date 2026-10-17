# Deploying Lantern on Dokploy

[Dokploy](https://dokploy.com) runs the same containers as the plain-VPS
setup in [README.md](README.md), with Dokploy's Traefik in front instead
of Caddy. The decision and what was tested are in
[ADR-0019](../docs/adr/0019-dokploy.md).

| Service | What it does | Public? |
|---|---|---|
| Dokploy's Traefik | HTTPS (Let's Encrypt), routing, WebSocket proxying | Ports 80 and 443 |
| `app` | API, realtime sockets, every running host, the web app | Only through Traefik (port 8080 inside) |
| `db` | Postgres 17 | No (internal network only) |
| `backup` | Nightly `pg_dump`, 7 daily and 4 weekly copies, optional S3 upload | No |
| `broadcaster` | Cloud broadcast (only with `COMPOSE_PROFILES=broadcast`) | No |
| `tts` | Self-hosted Brazilian Portuguese voice (only with `tts` in `COMPOSE_PROFILES`) | No |
| `signer` | Our own TikTok signer ([ADR-0023](../docs/adr/0023-own-tiktok-signer.md); only with `signer` in `COMPOSE_PROFILES`) | No |

Everything lives in [`compose.dokploy.yaml`](../compose.dokploy.yaml) at
the repository root.

## 1. Install Dokploy

On a fresh Ubuntu or Debian server (ports 80, 443 and 3000 must be free):

```sh
curl -sSL https://dokploy.com/install.sh | sh
```

Open `http://<server-ip>:3000` and create the admin account. Then give the
Dokploy panel its own domain with HTTPS and close port 3000 in your
firewall, so the panel isn't reachable over plain HTTP.

Size the server for Dokploy plus Lantern: 4 vCPU and 8 GB RAM is a
comfortable start. Each cloud broadcast needs about 2 more vCPU (see
[Capacity](README.md#capacity)).

## 2. Create the service

1. **Projects → Create Project** (e.g. "Lantern"), then **Create Service →
   Compose**.
2. **Compose type: Docker Compose**, not Stack. Stack mode can't build
   images.
3. **Provider:** your GitHub repository (connect Dokploy's GitHub app) or
   any Git URL, and the branch to deploy.
4. **Compose Path:** `./compose.dokploy.yaml`
5. Leave **Isolated Deployment** off. The setup was tested without it, and
   the service names it relies on are already unique (`lantern-app`,
   `lantern-db`, `lantern-broadcaster`).

## 3. Environment

Paste [`deploy/dokploy.env.example`](dokploy.env.example) into the
**Environment** tab and fill it in. Dokploy saves it as `.env` next to the
compose file; it never enters the Docker images (`.dockerignore` excludes
every `.env`).

| Variable | How to set it |
|---|---|
| `DOMAIN` | The domain you'll add in the next step, e.g. `lantern.example.com` |
| `APP_SECRET` | `openssl rand -base64 48`. Encrypts stream keys and stage links; **keep a copy somewhere safe**: without it, stored stream keys can't be decrypted |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24`. Set it before the first deploy; Postgres keeps the first one |
| `DEV_GATE_PASSWORD` | Required while `AUTH_MODE=dev` (no sign-in yet): the whole site asks for this password, except stage links, webhooks and health checks |
| `ANTHROPIC_API_KEY` | Without it, hosts run an offline scripted brain |
| `ELEVENLABS_API_KEY` | Without it (and without the self-hosted voice), hosts speak in captions only |
| `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` | Mercado Pago; leave both empty to run without billing |

## 4. Domain

1. Point the domain's DNS `A` (and `AAAA`) record at the server.
2. **Domains → Add Domain**: service **app**, **Host** = your `DOMAIN`,
   **Path** `/`, **Container Port** `8080`, **HTTPS** on,
   **Certificate** Let's Encrypt.

Domain changes on a compose service take effect on the next deploy.

## 5. Deploy and check

Press **Deploy**. The first build takes a few minutes (it builds the web app
and the server inside Docker). Then:

- **Logs → app**: the first lines say which features are on (AI, voice,
  billing) and the app refuses to start with a clear message when a setting
  is missing or invalid.
- `https://<DOMAIN>/readyz` returns `{"ok":true,"database":"postgres",...}`.
- Open `https://<DOMAIN>/app`, enter the staging password, create a host and
  press **Go live** in practice mode.

If the deployment log says `required variable ... is missing a value`, the
Environment tab is missing `DOMAIN` or `POSTGRES_PASSWORD`.

### Mercado Pago webhooks

Set the webhook URL in Mercado Pago to `https://<DOMAIN>/api/billing/webhook`;
the rest is the same as in [README.md](README.md#mercado-pago-webhooks).

## 6. Updates and rollbacks

- **Deploy** rebuilds from the branch; **Auto Deploy** (Dokploy's webhook)
  does it on every push.
- The app drains on shutdown: stages hold their last frame, and every
  running host resumes when the new container starts. OBS sources reconnect
  by themselves; viewers see a pause of a second or two.
- Migrations run at boot. Breaking schema changes ship in two releases, so
  **rolling back** is "deploy the previous commit": revert on the branch and
  deploy.

## 7. Backups

The `backup` service dumps the database every night at `BACKUP_AT` (UTC)
into the `backups` volume. Set `BACKUP_S3_*` for off-site copies: without
them, losing the server loses the backups too.

Don't use Dokploy's volume backups for `db_data`: copying a running
Postgres data directory doesn't give a consistent backup. Backing up the
`backups` volume with it is fine.

Run these on the server over SSH. `<app-name>` is the service's app name
shown in Dokploy (it's also the Compose project name):

```sh
svc() { docker ps -aqf label=com.docker.compose.project=<app-name> -f label=com.docker.compose.service="$1"; }
docker exec "$(svc backup)" backup.sh now                    # take a dump now
docker exec "$(svc backup)" ls -l /backups                   # list dumps
docker exec "$(svc backup)" restore.sh /backups/<file>.dump  # drill: restore into a scratch database and count rows
```

To restore for real, stop only the app (Dokploy's Stop button would stop
the backup service too), restore, and start it again:

```sh
docker stop "$(svc app)"
docker exec "$(svc backup)" restore.sh /backups/<file>.dump lantern
docker start "$(svc app)"
```

## 8. Cloud broadcast

In the Environment tab:

```sh
COMPOSE_PROFILES=broadcast
BROADCAST_ENABLED=true
BROADCASTER_TOKEN=<openssl rand -hex 24>
BROADCAST_MAX_CONCURRENT=1
```

and deploy. `COMPOSE_PROFILES` starts the broadcaster container; the rest
turns the feature on in the app. Creators then add their TikTok server URL
and stream key under **Setup → Broadcast from the cloud**.

### Self-hosted voice

A free Brazilian Portuguese voice on the server's own CPUs
([ADR-0021](../docs/adr/0021-self-hosted-tts.md), `services/tts`). In the
Environment tab:

```sh
COMPOSE_PROFILES=tts            # or broadcast,tts
POCKET_TTS_SECRET=<openssl rand -hex 24>
TTS_CPUS=2
```

The first build downloads the model (360 MB) from Hugging Face and packs it
(about 2 minutes). The service uses about 300 MB of RAM. Hosts on this voice
always speak Portuguese.

### TikTok signer

Our own replacement for the hosted Euler Stream sign server
([ADR-0023](../docs/adr/0023-own-tiktok-signer.md)). In the Environment tab:

```sh
COMPOSE_PROFILES=signer         # or broadcast,signer
SIGNER_URL=http://lantern-signer:8091
SIGNER_TOKEN=<openssl rand -hex 24>
SIGNER_CPUS=1
```

Then redeploy and look for `signer session ready` in the `signer` service's
logs. It uses about 500 MB of RAM. TikTok may refuse to let a data-center
address join a room anonymously; if the app's host status shows "TikTok
answered ... 403" or "returned nothing", send the signer through Oxylabs
residential proxies: add the proxy user's `OXYLABS_USERNAME` and
`OXYLABS_PASSWORD` (and optionally `OXYLABS_COUNTRY=BR`) and redeploy. The
signer gives each browser session its own sticky address and retries a refused
join once from a new one. `TIKTOK_WS_VIA_PROXY=true` also sends every
channel's websocket through the proxy, which costs traffic (residential
proxies bill by the gigabyte); leave it off unless TikTok refuses the
websocket from the server's own address.
To check it against a live account (yours, or one whose owner agreed), start a
host on that handle and watch its status in the studio; the signer's logs say
why a join is refused. `scripts/verify-signer.ts` does the same check from a
terminal against a signer you can reach, for example one started locally with
`bun run --filter @tik-live/signer dev`.

## 9. Cloudflare

Simplest: leave the record **DNS only** (grey cloud).

If you proxy through Cloudflare (orange cloud):

- Use SSL/TLS mode **Full (strict)** with Dokploy's Let's Encrypt
  certificate, or a Cloudflare Origin CA certificate with Dokploy's
  Certificate set to None.
- Traefik then sees Cloudflare's addresses, not your visitors', so per-IP
  rate limits would treat everyone behind one Cloudflare edge as a single
  client. Tell Traefik to trust Cloudflare's forwarded headers: in Traefik's
  static configuration (`/etc/dokploy/traefik/traefik.yml`), add
  Cloudflare's ranges from <https://www.cloudflare.com/ips/> under
  `entryPoints.websecure.forwardedHeaders.trustedIPs` (and the same for
  `web`), then restart Traefik from Dokploy.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Traefik "404 page not found" | The domain isn't attached to service `app` on port 8080, or the service wasn't redeployed after adding the domain |
| "Bad Gateway" | The app isn't healthy: **Logs → app** |
| Certificate errors | DNS doesn't point at the server yet, or port 80 is blocked (Let's Encrypt validates over it) |
| App refuses to start | **Logs → app**: the first line names the missing or invalid setting |
| Broadcast keeps retrying | Studio health strip and **Logs → broadcaster**; usually a wrong server URL or stream key |

The rest of [README.md's troubleshooting](README.md#7-troubleshooting)
applies too.
