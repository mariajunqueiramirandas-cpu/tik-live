# Deploying Lantern on a VPS

This is the runbook for [ADR-0015](../docs/adr/0015-deployment.md): one
VPS, Docker Compose, Caddy for HTTPS, Postgres with nightly backups, and an
optional cloud broadcaster.

**Deploying with Dokploy?** Follow [DOKPLOY.md](DOKPLOY.md) instead; it uses
`compose.dokploy.yaml` with Dokploy's Traefik in place of Caddy.

| Service | What it does | Public? |
|---|---|---|
| `caddy` | HTTPS certificates, HTTP/2 and HTTP/3, WebSocket proxying | Ports 80 and 443 |
| `app` | API, realtime sockets, every running host, the web app | No (behind Caddy) |
| `db` | Postgres 17 | No (internal network only) |
| `backup` | Nightly `pg_dump`, 7 daily and 4 weekly copies, optional S3 upload | No |
| `broadcaster` | Cloud broadcast: renders the stage and streams to TikTok (profile `broadcast`) | No |
| `tts` | Self-hosted Brazilian Portuguese voice, Pocket TTS (profile `tts`, [ADR-0021](../docs/adr/0021-self-hosted-tts.md)) | No |
| `signer` | Our own TikTok signer, a browser that signs the TikTok connector's requests (profile `signer`, [ADR-0023](../docs/adr/0023-own-tiktok-signer.md)) | No |

## 1. Prepare the server

Recommended: 4 vCPU, 8 GB RAM, 80 GB SSD, Ubuntu 24.04 LTS. Each cloud
broadcast needs about 2 more vCPU (see [Capacity](#capacity)).

```sh
# As root on a fresh server
adduser --disabled-password --gecos "" lantern && usermod -aG sudo lantern
rsync --archive --chown=lantern:lantern ~/.ssh /home/lantern
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config && systemctl reload ssh
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
apt-get update && apt-get install -y unattended-upgrades && dpkg-reconfigure -f noninteractive unattended-upgrades

# Docker Engine with the compose plugin (https://docs.docker.com/engine/install/ubuntu/)
curl -fsSL https://get.docker.com | sh
usermod -aG docker lantern
```

Point your domain's DNS `A` (and `AAAA`) record at the server before the
first start, so Caddy can get a certificate.

## 2. Configure

```sh
sudo -iu lantern
git clone https://github.com/<owner>/tik-live.git lantern && cd lantern/deploy
cp .env.example .env
chmod 600 .env
```

Fill in `.env`. The essentials:

| Variable | How to set it |
|---|---|
| `DOMAIN` | Your domain, e.g. `lantern.example.com` |
| `APP_SECRET` | `openssl rand -base64 48`. Encrypts stream keys and stage links; **back it up**: without it, stored stream keys can't be decrypted |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `DEV_GATE_PASSWORD` | Required while `AUTH_MODE=dev` (no sign-in yet): the whole site asks for this password, except stage links, webhooks and health checks |
| `ANTHROPIC_API_KEY` | Without it, hosts run an offline scripted brain |
| `ELEVENLABS_API_KEY` | Without it (and without the self-hosted voice), hosts speak in captions only |
| `POCKET_TTS_SECRET` | The self-hosted voice: `openssl rand -hex 24`, then `docker compose --profile tts up -d --build` |
| `SIGNER_URL`, `SIGNER_TOKEN` | The self-hosted TikTok signer: `http://lantern-signer:8091` and `openssl rand -hex 24`, then `docker compose --profile signer up -d --build` (see [TikTok signer](#tiktok-signer)). Both or neither |
| `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` | Mercado Pago; leave both empty to run without billing |

The app checks its configuration at boot and refuses to start with a clear
message when something required is missing (`docker compose logs app`).

### Mercado Pago webhooks

In the Mercado Pago developer dashboard, under your application's
notifications (webhooks), set the URL to
`https://<DOMAIN>/api/billing/webhook` and subscribe to the
`subscription_preapproval` and `subscription_authorized_payment` events
(the dashboard also lists them as "Plans and subscriptions"). Copy the
signing secret into `MP_WEBHOOK_SECRET`.

## 3. Start

Either build on the server:

```sh
docker compose up -d --build
```

or use published images (CI pushes them to GHCR on `v*` tags):

```sh
echo "APP_IMAGE=ghcr.io/<owner>/lantern-app:1.0.0" >> .env
docker compose pull && docker compose up -d
```

Check it:

```sh
docker compose ps                     # all services healthy
curl -fsS https://$DOMAIN/healthz     # {"ok":true}
docker compose logs -f app            # JSON logs
```

Open `https://<DOMAIN>/app`, enter the staging password, create a host and
press Go live in practice mode.

## 4. Upgrade and roll back

```sh
git pull                                   # or bump APP_IMAGE in .env
docker compose up -d --build               # or: docker compose pull && docker compose up -d
```

On SIGTERM the app saves what it has in memory, tells every stage to hold
its last frame, and closes connections. The new container resumes every
running host at boot. OBS sources reconnect by themselves; the interruption
is a second or two.

Migrations run automatically at boot (under a Postgres advisory lock).
Schema changes that would break the previous version ship in two releases
(expand, then contract), so rolling back is always "deploy the previous
image": set `APP_IMAGE` back, or `git checkout <previous tag> && docker compose up -d --build`.

## 5. Backups and restore

- A dump is written to `deploy/backups/` every day at `BACKUP_AT` (UTC).
- Take one now: `docker compose exec backup backup.sh now`
- Off-site copies: set `BACKUP_S3_*` (any S3-compatible storage).

**Rehearse a restore** (do it once after setup, then every few months):

```sh
docker compose exec backup restore.sh /backups/<file>.dump
# restores into a scratch database "lantern_restore_check" and prints row counts
```

**Restore for real:**

```sh
docker compose stop app
docker compose exec backup restore.sh /backups/<file>.dump lantern
docker compose start app
```

Keep a copy of `.env` (especially `APP_SECRET`) somewhere safe and separate
from the backups.

## TikTok signer

The TikTok connector needs TikTok's request signing. By default it asks the
hosted Euler Stream sign server (`EULER_API_KEY` raises its limits). The
`signer` service replaces that with a headless browser on TikTok's own page
([ADR-0023](../docs/adr/0023-own-tiktok-signer.md)):

```sh
# In .env
SIGNER_URL=http://lantern-signer:8091
SIGNER_TOKEN=$(openssl rand -hex 24)

docker compose --profile signer up -d --build
docker compose logs signer        # "signer session ready" once the browser is up
```

It uses about 500 MB of RAM and a CPU core while it signs; `SIGNER_CPUS` caps
it. **TikTok decides per network whether anonymous viewers may join a room,
and often refuses data-center addresses.** Check from the server, with an
account that's live:

```sh
# On the server, from a checkout of this repository (the signer listens on 127.0.0.1:8091 there):
bun scripts/verify-signer.ts <handle> --url http://127.0.0.1:8091 --token <SIGNER_TOKEN>
```

If the signer reports 403 or an empty answer, set `SIGNER_PROXY_URL` in `.env`
to a residential or mobile proxy (`http://user:pass@host:port`; use a sticky
session if the provider offers one) and run `docker compose up -d signer`.
The signer holds one page open and downloads no images, video or fonts, so a
proxy billed by traffic sees a few megabytes at start and little after.
`SIGNER_WEBCAST_ORIGIN=https://webcast.us.tiktok.com` is the other host worth
trying. The signer's port is published on the server's loopback only, and every
request needs the token.

## 6. Cloud broadcast

Cloud broadcast streams a host to TikTok with no PC running. It's a Pro-plan
feature and costs a lot of CPU.

```sh
# In .env
BROADCAST_ENABLED=true
BROADCASTER_TOKEN=$(openssl rand -hex 24)
BROADCAST_MAX_CONCURRENT=1

docker compose --profile broadcast up -d --build
```

Creators then add their TikTok server URL and stream key under
**Setup → Broadcast from the cloud**. The key is stored encrypted and never
shown again.

### Capacity

Measured on a 4-vCPU AVX2 container with no GPU
([ADR-0020](../docs/adr/0020-broadcast-pipeline-avx2.md)): one 720x1280
broadcast at 30 fps uses about **1.8 vCPU**. Chrome renders the stage with
Mesa's llvmpipe (AVX2 shader code) and encodes H.264 in the page; ffmpeg
only copies the video and encodes the voice. Plan on one broadcast next to
the app on a 4-vCPU server, or about 2 vCPU per broadcast on a server of
its own. `BROADCASTER_CPUS` caps the broadcaster so it can never starve the
app.

Any x86-64 server from the last ten years has AVX2. Check with
`grep -c avx2 /proc/cpuinfo` (anything above 0). Without AVX2, llvmpipe
falls back to SSE and rendering costs roughly twice as much.

`VIDEO_ENCODER=x264` makes the stage send raw frames that ffmpeg encodes
with x264 instead (about 1 vCPU more per broadcast). Use it only if Chrome's
H.264 encoder ever misbehaves.

To run the broadcaster on a separate server, start only that service there,
put both servers on a private network, set `BROADCASTER_URL` on the app to
the broadcaster's private address, and set the broadcaster's `STAGE_ORIGINS`
and the app's `BROADCAST_STAGE_ORIGIN` to an app address the broadcaster can
reach. Don't use a bare `app` hostname for it: `app` is an HSTS-preloaded
top-level domain, and Chromium will force it to HTTPS.

## 7. Troubleshooting

| Symptom | Look at |
|---|---|
| `caddy` restarting | `docker compose logs caddy`: DNS not pointing at the server yet, or ports 80/443 blocked |
| App refuses to start | `docker compose logs app`: the first line names the missing or invalid setting |
| OBS shows the old look or a blank source | Copy the stage link again from Setup (it changes when replaced); in OBS, refresh the browser source |
| OBS shows "turn on hardware acceleration" | OBS → Settings → Advanced → Sources → enable browser source hardware acceleration |
| Broadcast keeps retrying | Studio health strip and `docker compose logs broadcaster`; usually a wrong server URL or stream key |
| Disk filling up | `docker system df`; logs rotate at 5 × 10 MB per service; old backups are pruned automatically |

## Without Docker

Docker is the supported path. If you prefer plain services: install Bun
1.4, Postgres 17 and Caddy from their packages, run `bun install --frozen-lockfile && bun run build`,
and start the bundled server with a systemd unit:

```ini
[Service]
User=lantern
WorkingDirectory=/opt/lantern
EnvironmentFile=/opt/lantern/deploy/.env
Environment=NODE_ENV=production HOST=127.0.0.1 PORT=8080 TRUST_PROXY=true WEB_DIST=/opt/lantern/apps/web/dist
ExecStart=/usr/local/bin/bun apps/server/dist/index.js
Restart=always
KillSignal=SIGTERM
TimeoutStopSec=25
```

with `DATABASE_URL` and `PUBLIC_URL` set in `.env`, and the same Caddyfile
proxying to `127.0.0.1:8080`.
