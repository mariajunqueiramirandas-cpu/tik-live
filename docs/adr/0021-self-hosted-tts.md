# ADR-0021: A self-hosted Brazilian Portuguese voice

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner
**Amends:** [ADR-0012](0012-ai-and-voice-pipeline.md) (voice layer: a second provider next to ElevenLabs)

## Context

Every spoken sentence goes to ElevenLabs, billed per character: about 30–40k
characters per active live hour ([ADR-0012](0012-ai-and-voice-pipeline.md#cost-model-estimates-to-be-replaced-by-metered-data)).
Prices are in reais and the first audience is Brazilian. Venduá, a sibling
project on the same kind of VPS (CPU only, no GPU), already built a
self-hosted Brazilian Portuguese TTS service for the same reason (its ADR
0045): Kyutai's Pocket TTS (Portuguese, 6 layers, CC-BY-4.0 weights) on a C++
engine of its own, 11× real time on 2 AVX2 cores, with a normalizer that
spells out prices, times and dates.

## Decision

**Copy Venduá's `services/tts` unchanged into `services/tts` and add it as a
third voice provider, `pocket`, next to `elevenlabs` and `none`.**

- **The service** is an internal sidecar, the `tts` compose profile
  (`lantern-tts:8793`, internal network only), behind a bearer secret, idle
  without it. Its README has the engine's design and every number; they were
  measured in Venduá on store replies.
- **The provider** (`PocketTts` in `apps/server/src/runtime/voice/tts.ts`)
  asks for one sentence at a time, as with ElevenLabs, in WAV rather than
  Ogg/Opus: every browser decodes WAV (Safari's Ogg/Opus support is recent),
  and the stream re-encodes the audio anyway, so one lossy pass is enough.
  The clip's length comes from the service's `x-tts-seconds`. A process-wide
  limiter (`POCKET_TTS_MAX_CONCURRENCY`, 8) stays under the service's own 16
  requests in flight; the service batches them itself.
- **Language.** The model only speaks Portuguese. A provider can now declare
  its language, and the host's system prompt then says to always speak it
  ("Always speak Brazilian Portuguese, whatever language a viewer writes in")
  instead of "reply in the viewer's language". Switching the voice while live
  rebuilds the prompt.
- **Voices.** The dashboard lists the service's voices (from its
  `/healthz`), with samples synthesized once per voice at
  `/api/voices/pocket/:voice/sample`. `rafael` is the default and the only
  native Brazilian speaker; the others are foreign speakers' voices speaking
  Portuguese. Plans without voice choice get `POCKET_TTS_VOICE`.
- **Configuration.** On when `POCKET_TTS_URL` and `POCKET_TTS_SECRET` are both
  set; the compose files set the URL, so the secret is the switch. New
  channels get ElevenLabs when its key is set, otherwise this voice.

## Options considered

- **ElevenLabs only (status quo).** Best quality and every language, billed
  per character, and every line leaves our servers.
- **Port the service (chosen).** No per-character cost and nothing leaves the
  VPS; Portuguese only, ~300 MB of RAM and the 2 cores compose gives it.
- **Pocket TTS's English model next to it.** Not packed or tested by the
  engine yet; a follow-up if English-speaking hosts need a free voice.

## Consequences

- A host on this voice speaks only Brazilian Portuguese; English-speaking
  channels stay on ElevenLabs or captions.
- Emotions don't change the delivery (ElevenLabs' stability and style have no
  equivalent here); the stage still shows them.
- TTS characters are still metered, but cost nothing per character on this
  provider: the cost table should tell the two apart once real usage is in.
- The engine is ~4,000 lines of C++ maintained in Venduá. A fix there is
  copied here; CI runs the service's tests (engine against its numpy
  reference) on every push.
- The image build downloads 360 MB from Hugging Face, pinned by sha256.
