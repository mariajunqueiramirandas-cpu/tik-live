# Decisions needed from the owner

Everything in the ADRs is built. While building it, every choice that a
contributor could reasonably make was made and recorded in the ADRs. What's
left here are the choices that belong to the owner: money, legal, accounts,
and product direction. Each item says what the software does **today** (the
default it ships with), where to change it, and a recommendation.

Nothing here blocks running the product for yourself. Several items block
charging other people.

## At a glance

| # | Decision | Default today | Blocks |
|---|---|---|---|
| 1 | [Prices, hours and AI models per plan](#1-prices-hours-and-ai-models-per-plan) | R$ 49,90 / R$ 149,90, every plan on Opus 5.5 | Paid launch |
| 2 | [Sign-in provider: Clerk or WorkOS](#2-sign-in-provider-clerk-or-workos) | No sign-in; one shared password (`DEV_GATE_PASSWORD`) | Any second user |
| 3 | [Terms of service, privacy policy, invoices](#3-terms-privacy-and-invoices) | None | Paid launch |
| 4 | [Cloud broadcast capacity and price](#4-cloud-broadcast-capacity-and-price) | Pro only, 1 stream per 4 vCPU | Turning cloud broadcast on |
| 5 | [Domain, VPS and outside accounts](#5-domain-vps-and-outside-accounts) | Dokploy setup ready ([runbook](../deploy/DOKPLOY.md)); no domain or accounts yet | Public deployment |
| 6 | [Verify the TikTok connection on a real LIVE](#6-verify-the-tiktok-connection-on-a-real-live) | Built against the connector's documented events; not yet tried on a real stream | Going live with real chat |
| 7 | [Sign-ups at launch](#7-sign-ups-at-launch) | Whoever the identity provider lets in | Public launch |
| 8 | [Product name](#8-product-name) | "Lantern" | Domain, branding |
| 9 | [Language of the dashboard](#9-language-of-the-dashboard) | English | Nothing |
| 10 | [Transactional email](#10-transactional-email) | None (in-app notices only) | Nothing yet |
| 11 | [Accept the ADRs](#11-accept-the-adrs) | All "Proposed" | Nothing |
| 12 | [Pre-launch checks only the owner can run](#12-pre-launch-checks-only-the-owner-can-run) | Not done | Paid launch |

## 1. Prices, hours and AI models per plan

**Today:** Free / Creator / Pro with the limits in
[ADR-0013](adr/0013-billing-and-plans.md); prices R$ 49,90 and R$ 149,90 a
month; every plan's host and moderator use Claude Opus 5.5.

**The problem with the defaults:** at Opus 5.5 for both host and moderator, a
busy live hour costs about **US$ 7.55** in AI alone
([ADR-0012 cost model](adr/0012-ai-and-voice-pipeline.md#cost-model-estimates-to-be-replaced-by-metered-data)).
The worst case per month, if a customer uses every included hour on a busy
stream:

| Plan (hours / month) | Opus 5.5 + Opus 5.5 | Sonnet 5.5 + Haiku 5.5 | Haiku 5.5 + Haiku 5.5 |
|---|---|---|---|
| Free (5 h) | US$ 38 | US$ 11 | US$ 1 |
| Creator (150 h) | US$ 1,133 | US$ 338 | US$ 30 |
| Pro (600 h) | US$ 4,530 | US$ 1,350 | US$ 120 |

ElevenLabs adds about 30–40k characters per active hour on top. Quiet hours
cost far less (filler slows down with fewer viewers and stops with none), and
the daily spend cap per channel (US$ 8 / 60 / 200) bounds the damage, but the
placeholder prices don't cover an active Creator customer on any model except
Haiku.

**Where to change it:**

- Prices: `PLAN_PRICE_CREATOR`, `PLAN_PRICE_PRO`, `BILLING_CURRENCY` in
  `deploy/.env`. No code change.
- Hours, channels, daily spend caps, token budgets and models per plan:
  `packages/shared/src/plans.ts` (one object per plan).
- One model for the whole server, overriding the plans: `HOST_MODEL`,
  `MODERATION_MODEL`.
- Existing subscribers keep the amount Mercado Pago has on their
  subscription; a price change applies to new checkouts and plan changes.

**Recommendation:** run your own channels for a week on a staging server
(billing off, every channel on the self-hosted plan), then read real cost
per live hour from the billing page and the session list. Then pick models
per plan. A reasonable starting point: Free on Haiku 5.5 for both; Creator
on Sonnet 5.5 with a Haiku 5.5 moderator; Pro on Opus 5.5 with a Haiku 5.5
moderator. Set prices from the measured cost with margin for ElevenLabs,
Mercado Pago fees and taxes. Fewer included hours on Creator (for example
60) is the other lever.

## 2. Sign-in provider: Clerk or WorkOS

**Today:** `AUTH_MODE=dev`. There's no sign-in; a production server refuses
to start without `DEV_GATE_PASSWORD`, which puts the whole site behind one
password (stage links, webhooks and health checks stay reachable). Both
providers are implemented behind the identity seam
([ADR-0018](adr/0018-defer-authentication.md)) and tested with simulated
providers; neither has been tried with a real account.

**To switch:** set `AUTH_MODE=clerk` with `CLERK_SECRET_KEY` and
`CLERK_PUBLISHABLE_KEY` (optionally `CLERK_WEBHOOK_SIGNING_SECRET` for
profile updates and account deletion), or `AUTH_MODE=workos` with
`WORKOS_API_KEY`, `WORKOS_CLIENT_ID` and `WORKOS_COOKIE_PASSWORD` (and add
`https://<domain>/auth/callback` as a redirect URI in WorkOS). Then record
the choice in a short ADR that supersedes the open part of ADR-0018.

**Recommendation:** Clerk. The customers are individual creators; Clerk's
prebuilt sign-in, social logins (Google, Apple and others) and user
management fit them, and its free tier covers launch. Pick WorkOS only if
agencies that want SSO for their staff are a target market.

## 3. Terms, privacy and invoices

None of these can be written by engineering:

- **Terms of service.** Should at least: forbid TikTok Shop LIVE (AI voices
  are banned there), require keeping the "is an AI host" label (it can't be
  turned off in the product), make the customer responsible for following
  TikTok's community guidelines, and explain the kill switch and automatic
  moderation without promising they catch everything.
- **Privacy policy (LGPD).** The product stores viewer handles, nicknames and
  chat for "regulars" memory and transcripts. Retention follows the plan (7,
  90 or 365 days of transcripts) and an account deletion removes everything.
  The policy should say so and name the processors: Anthropic, ElevenLabs,
  Mercado Pago, the identity provider, the VPS host, and the backup storage
  if used.
- **Invoices (nota fiscal).** Mercado Pago charges the customer but doesn't
  issue a nota fiscal. Decide with your accountant whether to issue them
  manually or through a service; nothing in the product does it.

There are no links to terms or privacy in the dashboard or landing page yet.
Once the documents exist, add the links to the landing page footer and to
the sign-in screen of the chosen identity provider.

## 4. Cloud broadcast capacity and price

**Measured** ([ADR-0014](adr/0014-cloud-broadcast.md)): one 720p30 stream
uses about 2.5–3 vCPU for Chromium (software rendering) plus about 0.3 for
the video encoder. That's the most expensive thing the product does.

**Today:** only Pro can turn it on; `BROADCAST_MAX_CONCURRENT=1` per
broadcaster host (sized for a 4 vCPU VPS next to the app); when the host is
full, starting another broadcast fails with a clear message and the channel
keeps working in browser-source mode. A Pro account may run up to 5 channels
at once, and each could ask for a cloud broadcast.

**Decide:**

- Whether cloud broadcast is in the launch at all. Browser-source mode (the
  creator's own OBS or TikTok LIVE Studio) costs nothing extra.
- How many cloud broadcasts a Pro account gets (today: as many as it has
  running channels, limited only by server capacity), or whether it's a paid
  add-on per stream.
- Where it runs: extra CPU VPSs (set `BROADCASTER_URL` per host), or a GPU
  host, which would cut the Chromium cost sharply but costs more per month.

**Recommendation:** launch with browser-source mode only, then open cloud
broadcast as an add-on priced per broadcast hour once you know the VPS cost
per stream.

## 5. Domain, VPS and outside accounts

You're deploying with Dokploy: [`deploy/DOKPLOY.md`](../deploy/DOKPLOY.md)
covers the steps ([ADR-0019](adr/0019-dokploy.md)). Owner-only parts:

- **Domain** pointing at the server, added on the compose service's Domains
  tab (service `app`, port 8080, HTTPS with Let's Encrypt) and set as
  `DOMAIN` in the Environment tab.
- **Anthropic API key** (`ANTHROPIC_API_KEY`), with a spend limit in the
  Anthropic console as a backstop to the in-product caps.
- **ElevenLabs** plan and a default voice (`ELEVENLABS_API_KEY`,
  `DEFAULT_VOICE_ID`). Without them hosts talk in captions only.
  `ELEVENLABS_MAX_CONCURRENCY` (default 4) should match the plan's
  concurrency limit.
- **Mercado Pago:** `MP_ACCESS_TOKEN` and `MP_WEBHOOK_SECRET`, plus the
  webhook URL `https://<domain>/api/billing/webhook` with the
  `subscription_preapproval` and `subscription_authorized_payment` topics.
  Run one checkout with Mercado Pago test users before switching to the
  production token.
- **Off-site backups:** any S3-compatible bucket (`BACKUP_S3_*`). Without it,
  backups stay on the VPS disk, which doesn't survive losing the VPS.
- **Euler Stream key** (`EULER_API_KEY`, optional): higher rate limits for
  the TikTok connector's sign server. Worth it once many channels run.

## 6. Verify the TikTok connection on a real LIVE

The TikTok connector is unofficial and reverse-engineered
([ADR-0002](adr/0002-bun-runtime-and-toolchain.md),
[ADR-0007](adr/0007-channel-runtime.md)). Everything around it is tested
with a simulated audience; the connection itself has to be tried on a real
account that's live, which only the owner can do:

1. Create a host with your TikTok handle and start it; it waits in standby.
2. Go live from TikTok LIVE Studio or OBS with the stage link as a browser
   source.
3. Check in the studio that chat, gifts, likes and follows arrive and that
   the viewer count moves, then end the stream and check it returns to
   standby.

If events don't arrive under Bun, the plan's fallback is a small Node
sidecar for the connector (the `EventSource` interface already isolates it).

## 7. Sign-ups at launch

**Today:** whoever the identity provider lets sign in gets a Free account.
**Recommendation:** invite-only at first (both Clerk and WorkOS have an
allowlist or invitation mode in their dashboards; no code change), then open
once costs per plan are known.

## 8. Product name

**Today:** "Lantern", a working name. It's one constant
(`packages/shared/src/brand.ts`) used by every page, plus the landing copy.
Internal names (`lantern-app` in compose, `lantern.*` cookie and storage
keys) can stay as they are after a rename. Check trademark and domain
availability before committing to a name.

## 9. Language of the dashboard

**Today:** the dashboard and landing page are in English. The hosts
themselves reply in each viewer's language, and fill quiet moments in the
language chat has been using (English when there's no chat yet). A creator
can pin the host's language with a rule in the character editor ("Always
speak Brazilian Portuguese").

**Decide** whether to translate the dashboard to Brazilian Portuguese for the
first market. Prices are already shown in BRL with Brazilian formatting.

## 10. Transactional email

**Today:** none. Billing problems, stopped channels and budget warnings show
up as notices in the dashboard. Sign-in emails will come from the identity
provider; Mercado Pago sends its own payment receipts.
**Recommendation:** add Resend when the first email-worthy feature is wanted
(for example "your payment failed, your plan drops in 7 days").

## 11. Accept the ADRs

All 18 ADRs are "Proposed" ([index](adr/README.md)). The software follows
them as written. Accepting them is a one-line status change each; after
that, a change of direction gets a new ADR instead of an edit.

## 12. Pre-launch checks only the owner can run

- The first Dokploy deploy, following [`deploy/DOKPLOY.md`](../deploy/DOKPLOY.md)
  through its checks, plus one backup restore drill
  ([ADR-0019](adr/0019-dokploy.md) action item 5,
  [ADR-0015](adr/0015-deployment.md) action item 4).
- Go through the pre-launch security checklist
  ([ADR-0016](adr/0016-security.md) action item 6).
- Read TikTok's current LIVE guidelines for AI-generated content and check
  that the always-on disclosure still satisfies them.
- Optional engineering follow-up, no decision needed: try Google Chrome's
  H.264 recorder so the video passes through without re-encoding
  ([ADR-0014](adr/0014-cloud-broadcast.md) action item 5). Low priority:
  the encoder is only about 0.3 of the 3 vCPU a stream uses.
