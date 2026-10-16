# HTTP API

The app server (`apps/server`) serves the dashboard's JSON API under `/api`,
the realtime WebSockets under `/ws` (see [protocol.md](protocol.md)), the
stage pages under `/s/<stageKey>`, and the built web app. The dashboard calls
the API through Hono's typed client (`hc<AppType>`, exported as
`@tik-live/server/app-type`), so request and response types are checked at
compile time; this page is the human-readable version.

The internal broadcaster API is at the [end of this page](#broadcaster-internal).

## Conventions

- **JSON in, JSON out.** Request bodies are validated with the zod schemas in
  `packages/shared` (named below); unknown fields are dropped.
- **Errors** always have one shape, with a stable `code` for programs and a
  `message` written for people:

  ```json
  { "error": { "code": "plan_running_limit", "message": "Your plan runs 1 host at a time. Stop one first or upgrade.", "details": null } }
  ```

  Validation failures are `400 invalid_input` with
  `details: [{ "path": "persona.name", "message": "..." }]`.

- **Status codes:** `400` bad input, `401` not signed in or bad signature, `402` the plan
  doesn't allow it (the message says what unlocks it), `403` blocked by the
  origin check, `404` doesn't exist or isn't yours (the two look the same on
  purpose), `409` a feature is off on this server, `413` payload too large, `422` (broadcaster) unusable URL,
  `429` rate limited, `502` an outside provider failed, `503` shutting down
  or not ready.
- **Dates** are ISO 8601 strings in UTC. Money is a number in the unit
  named by `currency`. Unlimited plan limits are `null` (JSON has no
  Infinity).
- **IDs** are UUIDv7 strings.

## Authentication

Every `/api` endpoint except `/api/config`, `/api/stage/*` and
`/api/billing/webhook` needs a signed-in user. How a request is signed in
depends on `AUTH_MODE` ([ADR-0018](adr/0018-defer-authentication.md)):

| Mode | How the server identifies the caller |
|---|---|
| `dev` | No sign-in. The `x-dev-user` header, the `devUser` query parameter or the `tl_dev_user` cookie picks a local user (default `local`). With `DEV_GATE_PASSWORD` set, the whole site except stage links, webhooks and health checks also needs HTTP Basic auth with that password (any username). |
| `clerk` | Clerk's session (cookie, or `Authorization: Bearer <session token>`), verified on every request with Clerk's backend SDK. Sign-in happens on `/app/sign-in` with Clerk's components. |
| `workos` | The sealed `wos-session` cookie set by `/auth/callback`, refreshed transparently when it expires. |

The first authenticated request creates the user record (just-in-time
provisioning). A request without a valid identity gets `401 unauthenticated`.

**CSRF:** state-changing requests (anything but `GET`, `HEAD`, `OPTIONS`) are
rejected with `403 bad_origin` when the `Origin` header isn't `PUBLIC_URL`'s
origin, or when there's no `Origin` and `Sec-Fetch-Site` is `cross-site`.
The Mercado Pago webhook is exempt (it's signed instead).

**Rate limits:** 600 requests a minute per client IP across `/api`, and 20
host starts a minute per user. The client IP comes from `X-Forwarded-For`
only when `TRUST_PROXY=true` (behind Caddy).

## Health

| Endpoint | Response |
|---|---|
| `GET /healthz` | `200 { ok: true }` while the process is up. |
| `GET /readyz` | `200 { ok, database, eventLoopLagMs }`; `503 not_ready` when the database is unreachable; `503 overloaded` when event-loop lag passed 200 ms. |

## Configuration and account

### `GET /api/config`

Public settings the dashboard reads before anything else. Also inlined into
the dashboard's HTML so the first paint doesn't wait for it.

```json
{
  "productName": "Lantern",
  "authMode": "dev",
  "signInPath": null,
  "clerkPublishableKey": null,
  "billing": { "enabled": false, "currency": "BRL" },
  "broadcast": { "enabled": false },
  "ai": { "enabled": true },
  "voice": { "enabled": false },
  "pricing": { "free": "Free", "creator": "R$ 49,90", "pro": "R$ 149,90" }
}
```

### `GET /api/me`

The signed-in user and their plan:
`{ user: { id, email, name, createdAt }, plan: { id, name, limits }, authMode, devUser }`.
`devUser` is the impersonated name in dev mode, otherwise `null`.

### `POST /api/me/dev-user`

Dev mode only (`404` otherwise). Body `{ name }` (lowercase letters, digits
and dashes, up to 32). Sets the `tl_dev_user` cookie so the dashboard acts
as that user; used to exercise multi-user paths before real sign-in exists.

### `DELETE /api/me`

Deletes the account: stops every host, then removes all channels, viewer
memory, streams, transcripts and usage. `204`. With a real identity
provider, also delete the user there.

## Hosts (channels)

A "host" in the dashboard is a `channel` in the API: one AI host for one
TikTok account. Responses carry a `ChannelDto` (`packages/shared/src/channel.ts`):

```json
{
  "id": "0199f1c2-…",
  "name": "Blip",
  "tiktokUsername": "my.handle",
  "source": "tiktok",
  "persona": { "name": "Blip", "tagline": "…", "description": "…", "style": "…", "catchphrases": [], "rules": [], "maxSentences": 3, "segments": [ … ], "look": { … } },
  "voice": { "provider": "elevenlabs", "voiceId": null },
  "safety": { "blocklist": [], "strictness": "standard", "avoidTopics": [] },
  "broadcast": { "enabled": false, "rtmpUrl": null, "hasStreamKey": false, "streamKeyLast4": null },
  "desiredState": "stopped",
  "runtime": { "status": "stopped", "detail": "", "viewers": 0, "since": null },
  "stageUrl": "https://example.com/s/9k…",
  "createdAt": "2026-10-16T12:00:00.000Z",
  "updatedAt": "2026-10-16T12:00:00.000Z"
}
```

`runtime.status` is one of `stopped`, `starting`, `standby` (waiting for the
TikTok account to go live; no AI calls), `live`, `stopping`, `failed`.
`stageUrl` contains the stage key: treat it like a password.

| Endpoint | Body | Response |
|---|---|---|
| `GET /api/channels` | | `{ channels: ChannelListItem[] }`: each channel plus `lastStream` (`{ startedAt, endedAt, peakViewers, diamonds, viewers: number[] }` with at most 32 points, or `null`) |
| `POST /api/channels` | `channelCreateSchema`: `{ name, tiktokUsername?, presetId? }` | `201 { channel }`. Without a handle the host uses the simulated audience. `402 plan_channel_limit` past the plan's channel count. |
| `GET /api/channels/:id` | | `{ channel }` |
| `PATCH /api/channels/:id` | `channelUpdateSchema`: any of `name`, `tiktokUsername`, `source`, `persona`, `voice`, `safety` | `{ channel }`. A running host picks up the change at once. `400 tiktok_handle_required` when `source` is `tiktok` with no handle. |
| `DELETE /api/channels/:id` | | `204`; stops the host first. |
| `POST /api/channels/:id/stage-key` | | `{ channel }` with a new `stageUrl`. Connected stages on the old link are closed with code `4001`. |
| `POST /api/channels/:id/start` | | `{ channel }`. `402 plan_running_limit`, `402 plan_hours_exhausted`, `400 tiktok_handle_required`, `503 shutting_down`. |
| `POST /api/channels/:id/stop` | | `{ channel }` |
| `PUT /api/channels/:id/broadcast` | `broadcastUpdateSchema`: `{ enabled?, rtmpUrl?, streamKey? }` | `{ channel }`. `streamKey` is write-only (send `null` to clear); only its last 4 characters come back. `402 plan_no_broadcast`, `409 broadcast_disabled`, `400 broadcast_incomplete`. |
| `POST /api/channels/:id/broadcast/check` | `{ rtmpUrl? }` (defaults to the saved one) | The broadcaster's reachability check: `{ ok, detail }`. Doesn't send video. |

### Streams and audience

| Endpoint | Response |
|---|---|
| `GET /api/channels/:id/sessions` | `{ sessions }`: the last 60 streams with `startedAt`, `endedAt`, `endReason`, `source`, `peakViewers`, `likes`, `diamonds`, `gifts`, `messages`, `follows`, `spokenLines`, `blockedLines`, `costUsd`. |
| `GET /api/channels/:id/sessions/:sid` | `{ session, samples, lines }`: per-minute `samples` (`viewers`, `likes`, `messages`, `diamonds`) and up to 1,000 transcript `lines` (`at`, `text`, `emotion`, `status` `spoken`/`blocked`, `reason`, `turnKind`). |
| `GET /api/channels/:id/audience` | `{ remembered, supporters, regulars }`: how many viewers the host remembers, and the top 10 by diamonds and by visits. |

Live state (what the host is saying, the queue, health) isn't polled: it
streams over the studio WebSocket ([protocol.md](protocol.md#studio)).

## Voices

### `GET /api/voices`

`{ enabled, canChoose, defaultVoiceId, voices: [{ id, name, previewUrl, description, tags }] }`. `enabled`
is false without an ElevenLabs key; `canChoose` is false on plans limited to
the default voice. The list is cached for a few minutes.

## Billing

See [ADR-0013](adr/0013-billing-and-plans.md) for the model. With billing
off (no `MP_ACCESS_TOKEN`), every account is on the `self-hosted` plan and the
purchase endpoints return `409 billing_disabled`.

| Endpoint | Body | Response |
|---|---|---|
| `GET /api/billing` | | `BillingStatus`: `{ enabled, plan, subscription, usage: { liveSeconds, liveHoursLimit, estimatedAiCostUsd }, offers }`. `subscription` is `null` or `{ status, plan, amount, currency, nextPaymentAt, lastPaymentStatus, graceUntil }`. |
| `POST /api/billing/checkout` | `{ plan: "creator" \| "pro" }` | `{ url, changed }`. A new subscriber gets Mercado Pago's checkout `url` to redirect to; an active subscriber's plan changes in place (`url: null, changed: true`). `502 provider_error` if Mercado Pago fails. |
| `POST /api/billing/cancel` | | The updated `BillingStatus`. The plan stays until the paid period ends. |
| `POST /api/billing/webhook` | Mercado Pago notification | `200 { received: true }`; `401 bad_signature` when the `x-signature` HMAC doesn't verify. Repeats are acknowledged and ignored. |

## Stage

| Endpoint | Response |
|---|---|
| `GET /s/:stageKey` | The stage page for OBS or TikTok LIVE Studio (1080×1920). `?role=preview` for the dashboard's monitor, `?role=broadcast` for the cloud broadcaster. |
| `GET /api/stage/:stageKey/audio/:cueId` | One line of speech audio (`audio/mpeg`), kept in memory for about two minutes. The stage key is the only credential. |

## Identity provider routes

Mounted only for the provider that needs them:

| Endpoint | Provider | What it does |
|---|---|---|
| `GET /auth/sign-in` | WorkOS | Redirects to AuthKit with a `state` cookie. `?returnTo=/app/...` is honored for same-site paths. |
| `GET /auth/callback` | WorkOS | Exchanges the code, checks `state`, sets the sealed session cookie, redirects. |
| `GET /auth/sign-out` | WorkOS | Clears the cookie and ends the WorkOS session. |
| `POST /api/identity/clerk-webhook` | Clerk | Svix-signed `user.updated` / `user.deleted`; a deleted Clerk user's data is removed here too. Needs `CLERK_WEBHOOK_SIGNING_SECRET`. |

## Broadcaster (internal)

`apps/broadcaster` renders stage pages in headless Chromium and pushes them
to RTMP ([ADR-0014](adr/0014-cloud-broadcast.md)). Only the app server calls
it, on the internal network. Every `/broadcasts` request needs
`Authorization: Bearer <BROADCASTER_TOKEN>`. Schemas live in
`packages/shared/src/broadcast.ts`.

| Endpoint | Body | Response |
|---|---|---|
| `GET /healthz` | | `{ ok, max, used }` |
| `GET /broadcasts` | | `{ broadcasts: BroadcastStatus[], capacity: { max, used } }` |
| `POST /broadcasts` | `startBroadcastSchema`: `{ channelId, stageUrl, rtmpUrl, streamKey, video? }` | `202 { broadcast }`. Idempotent per channel: the same settings return the running session, changed settings restart it. `400 invalid_input`; `422 bad_rtmp_url` (not rtmp(s)://, or a private or local address); `422 stage_not_allowed` (stage URL off `STAGE_ORIGINS`); `409 at_capacity`. |
| `POST /broadcasts/check` | `{ rtmpUrl }` | `{ ok, detail }` after resolving the host (SSRF guard) and opening a TCP connection. |
| `GET /broadcasts/:channelId` | | `{ broadcast }` or `404` |
| `DELETE /broadcasts/:channelId` | | `204` |

`BroadcastStatus` is `{ channelId, state, detail, since, restarts, stats }`
where `state` is `starting`, `live`, `retrying`, `failed` (after 5 failed
attempts in a row) or `stopped`, and `stats` holds `fps`, `bitrateKbps`,
`droppedFrames` and `speed` from the encoder. `detail` never contains the
stream key.
