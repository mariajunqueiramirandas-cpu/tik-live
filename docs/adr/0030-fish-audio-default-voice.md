# ADR-0030: Fish Audio Drama 3, through OpenRouter, is the default voice

**Status:** Proposed
**Date:** 2026-10-18
**Deciders:** Project owner
**Amends:** [ADR-0012](0012-ai-and-voice-pipeline.md) (the voice layer and its cost),
[ADR-0021](0021-self-hosted-tts.md) (which voice new hosts get)

## Context

The voice is the largest variable cost after Claude and the part of the show
viewers notice first. ElevenLabs is billed per character on plans bought in
dollars; the self-hosted Pocket TTS is free but speaks only Portuguese, with
the same delivery for every emotion, and needs its own container.

On 2026-10-18 every speech model on OpenRouter (35) was tried on five lines a
Brazilian live host says (a greeting, a gift thank-you, a quiz question, a
line full of numbers and a goodbye). The 17 setups that can speak Brazilian
Portuguese were each run 10 times, from a US cloud machine. Cost is what
OpenRouter billed, and naturalness and accent were judged by an
audio-understanding model listening as a Brazilian viewer. Per live hour
(35,000 characters, ADR-0012) and per sentence (median time until the whole
clip arrives):

| Model | Per live hour | Per sentence | Judged |
|---|---|---|---|
| **Fish Audio Drama 3** | **US$ 0.07** | 1.17 s | Brazilian on every line; with emotion directions the best of the test |
| MAI-Voice-2.1-Flash (Microsoft) | US$ 0.53 | 0.68 s | Six native pt-BR voices, flatter, no emotion control |
| Eleven v4 Turbo (ElevenLabs) | US$ 0.70 | 1.44 s | Most natural in Artificial Analysis's arena, ten times the cost |
| Gemini 3.8 Flash Lite TTS | US$ 0.41 | 2.47 s | Natural, too slow for a live host |

The others were ruled out by accent (HeyGen, Fish S2.1 Pro, Grok and Voxtral
sounded foreign or European with their stock voices), price (MiniMax, US$ 2.10
an hour) or latency (Kokoro took about 40 s per line through OpenRouter).
Drama 3 was released on 2026-10-13 as a preview; it ranks 10th in Artificial
Analysis's Speech Arena (1244 Elo), well above every other model this cheap.

## Decision

**Add a fourth voice provider, `fish`: Fish Audio's Drama 3 through
OpenRouter's speech API. With `OPENROUTER_API_KEY` set it is the first
provider, so new hosts get it.**

- **The provider** (`FishTts`, `apps/server/src/runtime/voice/fish.ts`)
  posts one sentence at a time to `{OPENROUTER_BASE_URL}/audio/speech` with
  `model` (`FISH_TTS_MODEL`, `fish-audio/drama-3`), `voice` and
  `response_format: "mp3"`. Drama 3 answers 44.1 kHz mono MP3 at a constant
  128 kbps with no ID3 header, so a clip's length comes from its size,
  exactly. A process-wide limiter (`FISH_TTS_MAX_CONCURRENCY`, 8) protects
  the account's rate limit.
- **Always a voice id.** Without one, Drama 3 picked a different speaker from
  one sentence to the next.
- **Emotions are acted.** Each line starts with a direction in brackets:
  `excited`, `laughing`, `sad`, `shy, soft` and so on, one per emotion
  (`FISH_DIRECTIONS`); neutral lines get none. English directions were
  followed a little more often than Portuguese ones.
- **Text is spoken text.** `speakable()` ports the self-hosted voice's
  normalizer (prices, percentages, times, dates, phone numbers, units,
  ordinals) and adds what a live host needs: numbers agree with the noun
  that follows ("mil duzentas e cinquenta curtidas", "duas mil lives"),
  "7x8" is "sete vezes oito", and "@" before a name is silent. Square and
  angle brackets are removed, so a viewer's nickname can't direct the voice.
  The caption on stage keeps the line as written. A line with nothing to say
  (only emoji) airs as captions without a request.
- **Voices** are a list in configuration, not fetched. Six are built in
  (`apps/server/src/voices/fish-voices.ts`), all from Fish's public library
  and made with Fish's voice designer from a written description, so none
  imitates a real person. Each was checked for a native Brazilian accent,
  the same speaker on every line, and live-host energy: Bia (the default),
  Joana, Carol, Theo, Samuel and Lucas. Fish's own Matilde was left out
  because she was heard with a European accent. `FISH_TTS_VOICES`
  (`id=Name,...`) replaces the list with voices the operator has rights to;
  `FISH_TTS_VOICE` must be on it. Hosts can only save listed voices
  (`400 voice_not_found`); an id that drops off the list gets the default
  voice. Samples come from `GET /api/voices/fish/:voice/sample`, synthesized
  once per voice per process (about US$ 0.0001 each).
- **The default.** Providers are ordered `fish`, `elevenlabs`, `pocket`; new
  hosts get the first one this server has. Existing hosts keep their
  setting. A host whose provider the server no longer has (a key removed)
  now speaks with the server's default provider instead of going silent,
  which is what the dashboard already showed it was using.
- **Failures.** One retry, after 400 ms, for a timeout (8 s per attempt), a
  network error, `408`, `429` or `5xx`; a `Retry-After` over 2 s isn't
  waited out. `400` (a voice or text Fish refuses) isn't retried. `401`,
  `402` and `403` (key, credits, spend limit) are the operator's to fix and
  are logged as errors. Any failed line airs as captions, and the studio
  gets a `voice_failed` notice, at most once every ten minutes (the
  pipeline's new `onTtsFailed` hook works for every provider).
- **Cost.** US$ 2 per million UTF-8 bytes of what is sent, directions
  included (`TTS_PRICES` in `packages/shared`). Each clip carries its
  estimated cost, which goes into `usage_daily.cost_usd`, the stream's cost
  and the daily spend cap, like Claude's.

## Options Considered

### Option A: Drama 3 through OpenRouter as the default (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low: one HTTP call per sentence, no container |
| Cost | About US$ 0.07 to 0.10 per live hour |
| Scalability | Bounded by the OpenRouter account's rate limit; the limiter protects it |
| Team familiarity | Same shape as the ElevenLabs provider |

**Pros:** cheapest voice that sounds Brazilian; acts emotions; any language if
ever needed. **Cons:** a preview model; one more outside account; community
voices.

### Option B: MAI-Voice-2.1-Flash

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | About US$ 0.53 per live hour |
| Scalability | Azure-backed |
| Team familiarity | Same shape |

**Pros:** fastest (0.68 s), six native pt-BR voices from Microsoft. **Cons:**
seven times the cost; no emotion control through OpenRouter. The natural
fallback if Drama 3 disappoints: another provider of the same shape.

### Option C: ElevenLabs (status quo) or Pocket TTS as the default

ElevenLabs sounds best but costs ten times more per hour on its own plans.
Pocket costs nothing per character but delivers every emotion the same way
and needs the sidecar. Both stay available.

## Trade-off Analysis

The voice is heard on every line, so naturalness and cost both matter more
than a few hundred milliseconds. Drama 3 is a little slower than the
moderation that runs beside it (0.4 to 0.8 s), which delays only a turn's
first line; later lines are synthesized while earlier ones play. Its price
lets the voice cost less than the host's brain.

## Consequences

- Easier: a live hour of voice costs about as much as a few seconds of
  Opus; the host sounds happy, sad or embarrassed when it is.
- Easier: voice spend shows up in analytics and counts against the daily cap.
- Harder: Drama 3 is a preview, so a degraded or withdrawn model is a real
  risk. Failures fall back to captions with a notice, and switching a host to
  another provider takes one click.
- Harder: a voice's first line takes about 2 s while Fish loads it.
- Harder: the built-in voices belong to their authors on Fish's platform and
  could be removed; `FISH_TTS_VOICES` lets the operator move to voices they
  control. Their commercial use is an owner decision
  ([decisions needed](../decisions-needed.md#13-voice-provider-and-voice-rights)).
- Revisit: after a week of real streams, compare first-line latency and
  `voice_failed` notices with ElevenLabs; consider streaming the audio, since
  Drama 3's first byte arrives in about 0.4 s.

## Action Items

1. [x] `FishTts`, `speakable()`, the emotion directions and the retry policy.
2. [x] Configuration, the built-in voices, samples and voice validation.
3. [x] Fish first among providers; hosts on a provider the server lost fall back to the default.
4. [x] Voice cost in usage, analytics and the daily cap; `voice_failed` notices.
5. [ ] The owner decides on the voice provider and the built-in voices' commercial use.
