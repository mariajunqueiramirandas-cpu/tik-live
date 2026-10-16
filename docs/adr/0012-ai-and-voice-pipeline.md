# ADR-0012: AI and voice pipeline

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

Each running channel makes three kinds of external AI call: host turns
(Claude), safety moderation of each sentence (Claude), and text-to-speech
(ElevenLabs). In a SaaS these calls are the main variable cost, the main
latency, and the main safety risk. v0.1 established the pipeline:

- stateless streamed turns with a cached system prompt;
- sentence splitting so speech starts early;
- moderation in parallel with TTS;
- fail-closed safety;
- refusal fallbacks.

This ADR settles models, cost controls, metering and the voice layer for many
tenants.

## Decision

### Models

| Call | Default | Settings |
|---|---|---|
| Host turn | `claude-opus-5-5` | Streamed; `output_config.effort: "low"` (Opus 5.5 can't disable thinking, so effort is the latency control); `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`; stop after `maxSentences + 1` |
| Moderation | `claude-opus-5-5` | `output_config.format` JSON schema `{ safe, reason }`; effort `low`; results cached per normalized sentence; a refusal counts as unsafe |

The model for each call is a **per-plan setting** in `packages/shared/plans.ts`
plus a deployment override, not a hard-coded constant. The defaults stay on
Opus 5.5 until the owner decides otherwise; the cost table below is the input
for that decision ([open question](../architecture/plan.md#open-questions)).

### Cost model (estimates, to be replaced by metered data)

Assumptions: an active stream gets a host turn about every 8 s (≈450
turns/hour); each turn ≈ 1,200 cached system tokens + 500 fresh input tokens
+ 350 output tokens (including low-effort thinking); ≈2.5 sentences per turn,
each moderated (≈350 input, ≈80 output). Prices are per million tokens from
the current Anthropic price list.

| Configuration | Host ≈ $/hour | Moderation ≈ $/hour | Total ≈ $/hour per live channel |
|---|---|---|---|
| Opus 5.5 host + Opus 5.5 moderator (current default) | 4.15 | 3.40 | **7.55** |
| Sonnet 5.5 host + Haiku 5.5 moderator | 2.15 | 0.08 | **2.25** |
| Haiku 5.5 host + Haiku 5.5 moderator | 0.11 | 0.08 | **0.20** |

ElevenLabs adds roughly 30–40k characters per active hour; cost depends on
the plan we buy. These numbers decide pricing ([ADR-0013](0013-billing-and-plans.md)),
so the first staging week measures real usage per channel.

### Cost guardrails (all plans)

- **Audience-aware pacing.** Filler turns slow down when nobody is watching:
  every 7 s with 5 or more viewers, every 20 s with 1–4, every 60 s with
  none. After 10 minutes with no viewers and no events, the host only reacts
  to events. A 3 a.m. stream with nobody watching costs almost nothing.
- **Budgets.** Each plan sets a token budget per live hour and a daily spend
  cap per channel. Crossing 80% raises a studio notice; crossing 100% switches
  the host to react-only and notifies the owner. A budget never silently
  stops a stream.
- **Prompt caching.** The system prompt is a byte-stable prefix per persona
  version. Staging checks `usage.cache_read_input_tokens`; if the prompt is
  below the model's minimum cacheable length, caching won't apply, and we'll
  know from the metrics.
- **Moderation cache.** Identical sentences (catchphrases, thank-yous) skip the
  moderator.

### Metering

Every Claude response's `usage` (input, cache read, cache creation, output),
every moderation call and every TTS character count goes into the runtime's
usage accumulator, which flushes to `usage_daily` ([ADR-0005](0005-data-layer.md)).
A price table in `packages/shared` turns usage into an estimated cost, shown to
the owner in analytics and used by the budget guardrails.

### Safety (unchanged from v0.1, now per channel)

1. **Input triage:** links, contact info, noise, floods, repeats, injection
   patterns and the channel's blocklist.
2. **Prompt hygiene:** viewer content escaped and wrapped as untrusted data;
   manipulative or blocklisted nicknames replaced with "friend".
3. **Output gate:** rules, then the moderator, failing closed.
4. **Kill switch** in the studio.
5. **AI disclosure:** the "is an AI host" badge is rendered by the engine on
   every plan and can't be turned off; the character admits being an AI when
   asked.
6. **Channel safety settings:** blocklist, strictness (`standard` or `strict`;
   strict also blocks romance, horror and slang categories), and topics to
   avoid. These feed both the system prompt and the moderator prompt.

**Terms of service:** creators may not use the product for TikTok Shop
livestreams, where TikTok bans AI voices.

### Voice

- `TtsProvider` interface (from v0.1). v1 ships ElevenLabs (platform key) and
  captions-only. Each channel picks a voice from a curated list (voice id,
  label, sample URL); free plans get a fixed default voice.
- Synthesis per sentence, concurrent with moderation. A concurrency limit per
  provider protects rate limits.
- Clips go into an in-memory LRU per runtime (TTL 2 minutes) and are served at
  `/api/stage/:stageKey/audio/:cueId`.
- Later: bring-your-own ElevenLabs key (encrypted at rest), streaming TTS for
  lower first-audio latency, more providers.

### Latency budget (chat event to first audio, server-side)

| Step | Target |
|---|---|
| Triage, memory and prompt build | under 5 ms |
| Claude time to first token (effort `low`) | about 0.6–1.5 s |
| First sentence complete | +0.3–0.6 s |
| Moderation ∥ TTS for sentence 1 | about 0.4–0.8 s |
| Stage fetch and decode | about 0.1–0.2 s |
| **Total** | **about 1.5–3 s** (p50 target under 2.5 s) |

Each turn records these timestamps; the studio's health panel shows p50 and
p95.

## Options Considered

### Option A: Server-side Claude and ElevenLabs with platform keys, plan-based models and guardrails (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Variable cost per live hour, controlled by plan settings and guardrails |
| Scalability | Bounded by API rate limits; the concurrency limiters protect them |
| Team familiarity | Continuation of v0.1 |

**Pros:** simple onboarding (no keys needed from creators); we control safety
and quality; usage visible per channel.
**Cons:** we carry the AI cost and must price for it.

### Option B: Bring-your-own keys only

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | No AI cost for us |
| Scalability | Per-creator limits |
| Team familiarity | Medium |

**Pros:** no cost risk.
**Cons:** high onboarding friction; creators can't easily get API keys;
support burden. Offered later as an add-on.

## Trade-off Analysis

Platform keys make the product usable in two minutes, which matters more than
cost risk at launch. Guardrails (pacing, budgets, caching) and per-plan model
choice make the risk explicit and tunable instead of hidden.

## Consequences

- Easier: one-click start for creators; predictable per-hour cost once measured.
- Harder: pricing depends on model choice; that needs the owner's decision before launch.
- Revisit: model defaults after a week of real metering.

## Action Items

1. [x] Move model settings into plan definitions with deployment overrides.
2. [x] Implement audience-aware pacing in the director and the budget guardrails.
3. [x] Implement metering from `usage` and the price table.
4. [x] Add per-turn latency timestamps and p50/p95 health metrics.
5. [x] Build the curated voice list and per-channel voice selection; add a provider concurrency limiter.
6. [x] Add channel safety settings (strictness, topics) to the prompts and moderator.
