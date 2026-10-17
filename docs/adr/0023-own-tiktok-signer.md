# ADR-0023: Our own TikTok signer in place of Euler Stream

**Status:** Proposed
**Date:** 2026-10-17
**Deciders:** Project owner

## Context

`tiktok-live-connector` reads a room's chat, gifts and likes over a websocket
([ADR-0002](0002-bun-runtime-and-toolchain.md),
[ADR-0007](0007-channel-runtime.md)). Opening that websocket starts with one
HTTP request, `webcast/im/fetch`, that TikTok only answers when it carries
the signature its own web client adds (`X-Bogus`, `X-Gnarly`, `msToken`,
`X-Dynosaur`). Since version 2 the connector gets that signature from Euler
Stream's hosted sign server. That puts a third party, with rate limits and
paid tiers, on the critical path of every channel the product runs.

What the app uses of Euler is small. Reading the connector (2.5.0) shows one
call we can't do ourselves, the signed `im/fetch`; room lookups are tried
free first, and the rest of Euler's API (gift catalog, sending chat,
moderation, alerts) is unused here. The connector documents `RouteConfig` as
the place to swap those provider calls.

## Evidence

A spike on 2026-10-17 (Chromium 1194 through Playwright 1.64, from a
data-center network), then the finished service against a real LIVE:

- TikTok's page script patches **`XMLHttpRequest`, not `fetch`**, and installs
  that hook some seconds after the page loads, later than other signs of life
  such as a patched `fetch`. A webcast request made with `XMLHttpRequest`
  once it's installed leaves the browser with all four signature parameters,
  on both `webcast.tiktok.com` and `webcast.us.tiktok.com`, for the `im/fetch`
  path too.
- The page's own CORS and CSP rules stop it from completing that request
  (the real web client never makes it), but Playwright can take the request
  over at the network layer after the page has signed it, send it itself, and
  return the raw response and its cookies.
- The room lookup (`api-live/user/room`) works from the page and says whether
  an account is live.
- **Not verified:** that TikTok accepts the join. From the development
  network it answers 403 or an empty 200, and TikTok's own web client, loaded
  as an anonymous viewer there, shows a login wall and doesn't join either.
  So this is the network's reputation, not our request, but only a run from a
  network where anonymous viewing works can say so
  (`scripts/verify-signer.ts`, [decisions needed](../decisions-needed.md#6-verify-the-tiktok-connection-on-a-real-live)).

## Decision

Add **`apps/signer`**: a small service that keeps one headless Chromium open
on a TikTok page and lets TikTok's own script sign the requests we need.

- **Signing:** the signer makes the request as an `XMLHttpRequest` inside the
  page, watches it leave, and sends it itself, so TikTok's script does the
  signing and nothing of its algorithm lives in this repository. Identity
  parameters (device id, region, language) are copied from a request the page
  made, so they match the browser.
- **Readiness** is probed by outcome: a test request must come out signed
  before the signer accepts work. A request that comes out unsigned is an
  `unsigned` error and recycles the session; idle sessions are reloaded
  periodically; a crashed browser restarts on the next request.
- **API** (internal, bearer token, [docs/api.md](../api.md#signer-internal)):
  `POST /v1/webcast-fetch` and `POST /v1/room`. Contract in
  `packages/shared/src/signer.ts`.
- **In the app:** `SIGNER_URL` and `SIGNER_TOKEN` turn it on. `TikTokSource`
  asks the signer whether the account is live, then connects to that room;
  the connector's provider route for the signed join is replaced, per
  connection, so connections that still use Euler (`EULER_API_KEY`) work
  beside it. The signer wins when both are set.
- **Network:** `SIGNER_PROXY_URL` sends the browser's traffic through a
  residential or mobile proxy, because TikTok decides per network whether
  anonymous viewers may join.

## Options Considered

### Option A: Run TikTok's own page script as the signer (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: one service, one browser |
| Cost | About 300 to 500 MB of RAM and a CPU core while it works; no per-request fee |
| Resilience | Survives changes to the signing algorithm; breaks if the page stops signing XHR, which the readiness probe reports |
| Team familiarity | High: the broadcaster already runs Chromium |

### Option B: Reimplement the signature algorithms

Rejected. They are obfuscated, versioned and rotated by TikTok. It is the
maintenance race Euler is paid to run, and we would lose it quietly: wrong
signatures look like empty responses.

### Option C: Make the browser the whole client

A page per channel joins the room and we read its websocket frames. Rejected:
a Chromium page per channel is far heavier than one shared page that only
signs, and the connector already does the decoding.

### Option D: Keep Euler Stream

Stays supported (`EULER_API_KEY`) as the fallback and for anyone who prefers
to pay for a hosted service and its network.

## Trade-off Analysis

The decision replaces a hosted dependency with one we operate. The cost is a
Chromium next to the app and a dependency on TikTok's page behaving the way
it does today; the readiness probe, the `unsigned` error and session recycling
turn a change there into a clear failure instead of silent empty responses.

The unproven part is not the signing but the network. If TikTok refuses
anonymous joins from the VPS's addresses, code can't fix that, and Euler's
price probably includes clean addresses. `SIGNER_PROXY_URL` is the answer, and
the proxy then is the new recurring cost to compare with Euler's.

## Consequences

- Easier: no outside rate limit or quota on connections; one fewer secret.
- Harder: we run and patch a browser service; we find out about changes to
  TikTok's page by monitoring, not by Euler's release notes.
- Not supported by the signer: authenticated connections (a logged-in
  session), sending chat, and the gift catalog. The app uses none of them.
- Terms: automated access to TikTok is against its terms, as with the
  connector today. This doesn't change that posture; it moves it in-house.
- Revisit: if the join can't be made to work from deployment networks even
  through a proxy, or if signing in the page stops working.

## Action Items

1. [x] Shared contract (`packages/shared/src/signer.ts`).
2. [x] `apps/signer`: backend, API, limiter, config, tests against a fake backend.
3. [x] Browser backend tested in Chromium against a stand-in TikTok (`e2e/signer.e2e.ts`), under Node and Bun.
4. [x] App side: `HttpSignerClient`, per-connection route override, `TikTokSource` room lookup; tested with the real connector against stand-ins.
5. [x] Deployment: image, both compose files, env examples, CI image build.
6. [ ] Run `scripts/verify-signer.ts` from the deployment network on a live account: confirms the join and the events.
7. [ ] If TikTok refuses anonymous joins there, pick a proxy provider and set `SIGNER_PROXY_URL`; compare its cost with Euler's.
8. [ ] Decide whether to drop `EULER_API_KEY` once item 6 passes.
