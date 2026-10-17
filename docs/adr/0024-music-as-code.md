# ADR-0024: Music as code

**Status:** Proposed
**Date:** 2026-10-17
**Deciders:** Project owner

## Context

Viewers keep asking the host to sing or "drop a beat". The host could only
say it can't play music. Playing recorded or licensed music on TikTok LIVE
risks mutes and strikes, and generating audio with a separate music model
adds a vendor, cost and latency.

## Decision

The host **writes music as a tiny score and the stage synthesizes it.**

- A step-sequencer language (`packages/shared/src/music.ts`): parts per
  instrument (lead, pluck, bass, pad, bell, keys, kick, snare, hat, clap,
  perc), sixteenth-note steps (`.` rest, `-` hold, `x` hit, `C4`, chords
  `C4+E4+G4`), bpm, bars, swing, repeats. At most 8 parts, 8 bars and 45 s.
- The host gets a `play_music` **tool** on its normal turn (strict schema,
  eager input streaming, validated with zod before use). It's fire-and-forget:
  the turn ends with the call, nothing is sent back. The tool is offered only
  when the creator allows music (`persona.sound.music`); the runtime
  rate-limits host pieces to one per 90 s, skips them during an open game
  round, and checks the title (shown on stage) with the safety gate.
- The stage synthesizes with plain WebAudio nodes on its audio output, so OBS
  and the cloud broadcast carry it; music ducks under speech and doesn't drive
  lip sync.
- A small `MUSIC_LIBRARY` gives the studio one-click pieces and shows the
  language by example. The studio can also ask the host to compose in a style.

## Options considered

- **Licensed or stock tracks:** rights questions per region, files to host,
  nothing the host can make up on the spot. Rejected.
- **An AI music model (audio out):** better sound, but another vendor, seconds
  of latency, cost per second and moderation of audio. Revisit later.
- **The host writes WebAudio JavaScript:** maximal freedom, but running
  model-written code on every stage is a security hole. Rejected; the score is
  data, parsed by a strict grammar.

## Consequences

- Easier: music costs a few hundred output tokens, is instant, and is
  copyright-clean by construction (originals only, enforced by prompt).
- Harder: synthesized instruments sound simple; mixing must keep the voice on top.
- Revisit: sung vocals over the beat (TTS with timing), richer instruments.

## Action Items

1. [x] Music language, library and protocol (`music`, `sfx`).
2. [x] Host `play_music` tool, validation, rate limits, studio controls.
3. [x] Stage synthesizer and sound board.
4. [ ] Listen on a real stream: loudness against the voice on phone speakers.
