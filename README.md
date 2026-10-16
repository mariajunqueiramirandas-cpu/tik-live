# Lantern

A fully autonomous AI host for TikTok LIVE, run as a service. A creator
designs a character (or picks a voice-only host with no character at all),
connects their TikTok account, and the host runs the stream: it reads chat,
answers questions, thanks gifts and follows, remembers regulars, runs show
segments, and fills quiet moments. Nobody needs to be at the keyboard.

"Lantern" is a working name ([decisions needed](docs/decisions-needed.md)).

```
TikTok LIVE ──(chat, gifts, likes, follows, joins)──► Triage
   spam, links, prompt injection, blocklist, priority, expiry
        │
        ▼
   Director ── run of show: opening, reactions, milestones, segments, filler
        │
        ▼
   Host (Claude, streamed sentence by sentence)
        │
        ▼
   Safety gate (rules + Claude moderator) ∥ Voice (ElevenLabs)
        │
        ▼
   Stage engine (WebGL2: character, captions, alerts, lip sync)
        │
        ├──► OBS / TikTok LIVE Studio browser source ──► TikTok
        └──► Cloud broadcaster (headless Chromium + ffmpeg) ──RTMP──► TikTok
```

## What's in the box

- **Dashboard** (React): create hosts from presets, edit the character with
  a live preview, set safety rules and voice, watch a live studio with a
  stage monitor, the room's chat and the host's transcript, a kill switch,
  and analytics per stream. Works on a phone.
- **Stage engine**: a WebGL2 renderer built for a 1080×1920 browser source.
  An orb character (or a voice line) with nine emotions and vowel-shaped
  lip sync, gift and follow alerts, captions, a frame loop that doesn't
  allocate, and a quality governor that steps down before frames drop. It
  keeps animating through disconnects and reconnects on its own.
- **Runtime**: one supervised runtime per live host, with audience-aware
  pacing, per-plan AI budgets and daily spend caps, viewer memory, and
  graceful restarts that don't drop OBS.
- **Cloud broadcast** (Pro): renders the stage in headless Chromium and
  streams it to TikTok's RTMP ingest, so no PC has to stay on.
- **Billing** with Mercado Pago subscriptions; with billing off, every
  feature is unlocked (self-hosted mode).
- **Deployment**: Docker Compose with Caddy (automatic HTTPS), Postgres,
  nightly backups, and a runbook.

## Quick start (no accounts needed)

You need [Bun](https://bun.sh) 1.4.2.

```bash
bun install
bun run dev
```

Open http://localhost:5173/app and create a host. With no settings at all,
the host listens to a **simulated audience** and speaks with an **offline
scripted brain** in captions, so the whole loop works before you connect
anything. Development has no sign-in: you're the local user.

To give the host its real brain and voice, copy `.env.example` to `.env`:

- `ANTHROPIC_API_KEY`: the host and the safety moderator run on Claude.
- `ELEVENLABS_API_KEY`: the host speaks out loud.

## Going live

1. In the host's **Setup** tab, under "Where <name> listens", choose
   TikTok and enter your handle.
2. Copy the **stage link** into OBS (or TikTok LIVE Studio) as a Browser
   source, 1080×1920, with **Control audio via OBS** ticked.
3. Start your TikTok LIVE, then press **Go live** in the dashboard. The host
   waits in standby until TikTok reports the stream live, so it never talks
   to an empty room, and goes back to standby when the stream ends.

On Pro, **Broadcast from the cloud** streams to TikTok without OBS: paste the
server URL and stream key from TikTok LIVE Producer. Stream keys aren't
available on every account or in every region.

## Safety

One bad sentence can get an account banned, so safety is layered
([ADR-0016](docs/adr/0016-security.md)):

1. **Input triage** drops links, contact info, spam, floods, blocklisted
   terms and prompt-injection attempts before the model sees them.
2. **Prompt hygiene:** viewer names and messages are passed as untrusted,
   escaped data; manipulative nicknames are replaced with "friend".
3. **Output gate:** every sentence passes rules and a Claude moderator before
   it's spoken, and fails closed: if the moderator is down, the line is
   dropped.
4. **Kill switch:** pause stops speech at once; skip cuts the current line.
5. **Disclosure:** every stage shows "<name> is an AI host", on every plan,
   and the host says it's an AI when asked.

This is for regular TikTok LIVE. TikTok Shop LIVE bans AI voices.

## Deploying

- **Dokploy:** [`deploy/DOKPLOY.md`](deploy/DOKPLOY.md). One Compose
  service from this repository (`compose.dokploy.yaml`), a domain on port
  8080, and the Environment tab filled from `deploy/dokploy.env.example`.
- **Plain VPS:** [`deploy/README.md`](deploy/README.md). Docker Compose with
  Caddy for HTTPS, `deploy/.env`, and `docker compose up -d`.

Both cover upgrades, rollbacks, backups and restore.

Before anyone else signs in, set up a sign-in provider (Clerk or WorkOS;
both are built in). Until then a production server refuses to start without
`DEV_GATE_PASSWORD`, which puts the whole site behind one password.

## Documentation

| Document | What it covers |
|---|---|
| [Decisions needed](docs/decisions-needed.md) | Choices left for the owner: prices, models per plan, sign-in provider, legal |
| [Architecture overview](docs/architecture/overview.md) | Requirements, diagrams, data model, key flows |
| [Implementation plan](docs/architecture/plan.md) | Phases, exit criteria, risks |
| [ADRs](docs/adr/README.md) | Every significant decision and the options weighed |
| [HTTP API](docs/api.md) | Endpoints, errors, auth, the broadcaster's internal API |
| [Realtime protocol](docs/protocol.md) | Stage and studio WebSocket messages |
| [Contributing](CONTRIBUTING.md) | Setup, scripts, tests, conventions |

## Platform notes

- Chat and gift events come from
  [tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector),
  an **unofficial**, reverse-engineered library. It can break when TikTok
  changes things; the normalizer reads every known field spelling, so a
  change drops events instead of crashing the show.
- Check TikTok's current LIVE guidelines before running a host unattended.
