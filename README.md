# Lantern

A fully autonomous AI host for TikTok LIVE, run as a service. A creator
designs a character (or picks a voice-only host with no character at all),
connects their TikTok account, and the host runs the stream: it reads chat,
answers questions, thanks gifts and follows, remembers regulars, runs show
segments and chat minigames, composes little beats on request, and fills
quiet moments. Nobody needs to be at the keyboard.

"Lantern" is a working name ([decisions needed](docs/decisions-needed.md)).

The product is in Brazilian Portuguese: the dashboard, the stage, the host's
voice and every message a creator sees
([ADR-0027](docs/adr/0027-brazilian-portuguese-product.md), terms in
[docs/glossario.md](docs/glossario.md)). Code and developer docs are in English.

```
TikTok LIVE ──(chat, gifts, likes, follows, joins)──► Triage
   spam, links, prompt injection, blocklist, priority, expiry
        │
        ▼
   Director ── run of show: opening, reactions, milestones, segments, filler
        │
        ▼
   Host (Claude Haiku 5.5: one cached conversation, streamed sentence by sentence)
        │
        ▼
   Safety gate (rules + Claude moderator) ∥ Voice (Fish Audio Drama 3, ElevenLabs or self-hosted)
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
  and analytics per stream. Works on a phone. One switch in the Roteiro tab
  hands the whole run of show to the host, which plans a fresh one every
  loop ([ADR-0035](docs/adr/0035-automatic-run-of-show.md)).
- **Stage engine**: a WebGL2 renderer built for a 1080×1920 browser source.
  An orb character (or a voice line) with nine emotions and vowel-shaped
  lip sync, gift and follow alerts, captions, a frame loop that doesn't
  allocate, and a quality governor that steps down before frames drop. It
  keeps animating through disconnects and reconnects on its own.
- **Runtime**: one supervised runtime per live host, with audience-aware
  pacing, per-plan AI budgets and daily spend caps, viewer memory, and
  graceful restarts that don't drop OBS. The show is one append-only
  conversation with Claude Haiku 5.5, read from the prompt cache each turn:
  the host sees everything in the order it happened, its own lines (and
  which ones never aired), a director's brief with its local time and what
  to answer in which order, a running summary of the show, and how the last
  stream went ([ADR-0026](docs/adr/0026-turn-engine-and-context-cache.md)).
- **Minigames**: trivia, this-or-that, word scramble, guess the number,
  true or false, quick math, riddles and fastest finger. Viewers answer in
  chat, the game keeps score, and each game has its own scene on stage
  ([ADR-0023](docs/adr/0023-chat-minigames.md)). Plus party games of luck
  ([ADR-0038](docs/adr/0038-games-of-chance-and-party-games.md)): a tug of
  war pulled by likes, and a hot potato that blows up on whoever holds it.
  Run them from a segment or
  start one from the studio. Every game's points add up over a loop of the
  run of show, and when the last segment ends the top three are revealed on
  a podium, one place at a time, before the ranking starts over.
- **Up next and rankings**: the stage shows what's coming (the next game,
  segment or podium) with a countdown, and a card that takes turns between
  who sent the most likes in the last 15 minutes and the most diamonds in
  the last hour ([ADR-0028](docs/adr/0028-up-next-likes-and-loop-ranking.md)).
  The top gifters get the loud version: gold, a crowned first place, a glow
  around the card, and they cut in whenever a gift comes in.
- **Gift combos, power-ups and a vote**: gifts in a row build a combo on
  stage; gifts during a game round unlock power-ups for everyone (more time,
  a hint, double points); and chat votes which minigame the last segment
  plays ([ADR-0029](docs/adr/0029-gifts-power-ups-and-final-vote.md)).
- **Supporting the show**: every gift gets a personal moment and big gifts
  are the highlight of their turn. Now and then the stage shows how to
  support the live (like, follow, share, gift) and the host explains that
  it's an AI whose voice and brain cost money; each channel picks whether
  the host asks for gifts lightly or actively
  ([ADR-0032](docs/adr/0032-gifts-and-supporting-the-show.md)).
- **Gift powers**: a gift unlocks something on the spot: 5 diamonds cut
  the line, 30 pick the next game, 99 get a personal anthem, 199 make the
  gifter "dono da live" for five minutes, with a crown on stage. Taking
  first place among the gifters gets its own alert
  ([ADR-0039](docs/adr/0039-gift-powers.md)).
- **Always asking, always showing what a gift gets**: a support ticker
  stays on screen under the goals, taking turns between what gifts pay for,
  each gift power with its price, and liking, following and sharing. Every
  few minutes a big showcase under the character lays out what each gift
  unlocks ([ADR-0041](docs/adr/0041-support-ticker-and-gift-showcase.md)).
- **Challenges for the room**: every few minutes a like rush, a comment
  rush or a free raffle (type EU; the winner picks a game), with a banner
  and a prize when the room wins. The host welcomes first-timers by name,
  runs roll calls and interviews, answers questions without a "?", and has
  an opinion about everything, with a "sem filtro" mode that takes on
  politics and religion too
  ([ADR-0040](docs/adr/0040-room-challenges-and-opinions.md)).
- **Fan levels and calls to passers-by**: every viewer climbs fan levels by
  coming back, chatting, following, sharing and gifting, across streams;
  level-ups get an alert and a shout-out. Every few minutes, and after a
  wave of arrivals, the host calls out to people scrolling past with a
  concrete reason to stay, shown big on stage
  ([ADR-0037](docs/adr/0037-fan-levels-and-passers-by.md)).
- **Like and gift goals**: two bars on stage fill with the stream's likes
  and diamonds; when one is reached there's a party on stage, the host
  celebrates and the next goal starts. The creator sets the targets or lets
  them climb on their own ([ADR-0036](docs/adr/0036-like-and-gift-goals.md)).
- **Reactions and music**: confetti, fireworks, hearts and character moves
  the host can cue, gift effects that scale with the gift, sound effects, and
  short original music the host writes as a score and the stage synthesizes
  ([ADR-0024](docs/adr/0024-music-as-code.md)).
- **Automatic DJ**: one switch and the stage plays recorded electronic
  music non-stop under the host's voice: 34 Creative Commons tracks by Kevin
  MacLeod (CC BY 4.0, credited on stage), shuffled and crossfaded, the same
  on every stage, with skip in the studio. No AI picks them, and no
  copyrighted hits: those get a TikTok LIVE muted
  ([ADR-0045](docs/adr/0045-automatic-dj.md)).
- **Presets**: nine ready-made hosts, from a cozy radio voice to a Brazilian
  party MC, a gaming caster and a study buddy.
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

- `ANTHROPIC_API_KEY`: the host and the safety moderator run on Claude
  (Haiku 5.5 by default; `HOST_MODEL` and `MODERATION_MODEL` override it).
- `OPENROUTER_API_KEY`: the host speaks out loud, in Brazilian voices that
  act each line's emotion (Fish Audio's Drama 3 through OpenRouter, about
  US$ 0.07 a live hour, [ADR-0030](docs/adr/0030-fish-audio-default-voice.md)).
  New hosts get this voice.
- Or `ELEVENLABS_API_KEY` for ElevenLabs voices.
- Or, free and in Brazilian Portuguese only: run the self-hosted voice
  (`services/tts`, [ADR-0021](docs/adr/0021-self-hosted-tts.md)) and set
  `POCKET_TTS_URL` and `POCKET_TTS_SECRET`.

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
