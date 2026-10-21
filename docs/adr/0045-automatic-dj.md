# ADR-0045: An automatic DJ with Creative Commons tracks

**Status:** Proposed
**Date:** 2026-10-20
**Deciders:** Project owner

## Context

Creators want music playing the whole time the host is on the air, like a
radio: real recorded electronic music, not only the short synthesized pieces
of [ADR-0024](0024-music-as-code.md), and no AI deciding what plays. They ask
for "famous songs without copyright", which mostly doesn't exist: the hits
people know are all copyrighted, and TikTok mutes or ends a LIVE that plays
them. ADR-0024 rejected licensed and stock tracks for that reason and because
of files to host. A catalog whose license allows streaming answers both.

## Decision

**A built-in DJ plays a catalog of Creative Commons electronic tracks,
shuffled, non-stop, under the host's voice.**

- **The music:** 34 upbeat electronica, house and disco tracks by Kevin
  MacLeod (incompetech.com), about two hours before anything repeats
  (`DJ_CATALOG` in `packages/shared/src/dj.ts`). They're licensed
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): commercial use,
  streaming and redistribution are allowed as long as the music is credited.
  The stage shows the title and "Kevin MacLeod (incompetech.com) · CC BY 4.0"
  in the "now playing" chip for as long as a track plays.
- **The switch:** `persona.sound.dj`, off unless the creator turns it on, in
  Personagem › Voz or in the studio's "DJ automático" pane. While it's on and
  the host is running (standby included), the DJ plays.
- **The server decides, stages follow:** the runtime's `Dj`
  (`apps/server/src/runtime/dj.ts`) draws from a shuffle bag (every track once
  before a repeat, never the same one twice in a row) and sends the next track
  a 4 s crossfade before the current one ends, with the one after it. Every
  stage (OBS, the cloud broadcast, previews) plays the same track, a stage
  that connects mid-track seeks to where it is, and the studio shows it and
  can skip it (`dj_skip`).
- **Files:** the server fetches each track from incompetech.com once, keeps
  it on disk (`DJ_CACHE_DIR`, a temp directory by default) and serves it to
  the channel's stages at `/api/stage/:stageKey/dj/:id` with byte ranges. Only
  catalog ids can be asked for, so it's no open proxy. Serving same-origin
  matters: a cross-origin file without CORS headers would play silent through
  WebAudio, and the broadcast taps the WebAudio mix. The runtime warms the
  next track while the current one plays.
- **On the stage:** two media elements crossfade into each other, routed into
  the engine's mix after the speech analyser (they never move the mouth) and
  before volume, mute and the broadcast tap. Streaming instead of decoding
  keeps memory flat (a decoded five-minute track is over 100 MB). The DJ sits
  at about -10 dB under a compressor, ducks to 30% under speech, and fades out
  while one of the host's own pieces plays. A muted stage (a dashboard
  preview) doesn't stream; it picks the track up where it is when unmuted.
- **The host knows:** the system prompt says a DJ plays Creative Commons
  music and that it can't play famous songs; the brief names the track on,
  so the host can answer "what song is this?".

## Options considered

- **The creator's own playlist (links they add):** the most flexible, and
  rights are the creator's call, but most creators don't know which music
  they may stream, and a link that breaks or lies plays silence or something
  that gets the live muted. A later addition, next to the catalog.
- **NoCopyrightSounds and similar labels:** closer to "famous", but free use
  comes with conditions that vary by label and change over time (some forbid
  re-hosting the files or 24/7 music streams). Rejected for a built-in list.
- **Royalty-free stock (Pixabay and others):** free for commercial use, but
  the licenses restrict distributing the music on its own, and stock tracks
  are often registered for automatic claims. Rejected.
- **Endless synthesized music (extend ADR-0024):** copyright-clean by
  construction, but it doesn't sound like real songs. Kept for the host's own
  pieces.
- **The stage picks tracks by itself:** simpler, but every stage would play
  something different and the studio couldn't show or skip it. Rejected.

## Consequences

- Easier: real recorded music the whole show, at no cost per hour, with a
  license that allows it and the credit on screen.
- Harder: about 280 MB of files on the server, fetched from a third party the
  first time each plays. A track that can't be fetched is silence until the
  next one starts (the route answers 503 and tries the upstream again later). The catalog is
  pleasant, not famous.
- Risk: Creative Commons doesn't stop automated systems from flagging music
  by mistake. If TikTok ever mutes a stream over a catalog track, take that
  track out of `DJ_CATALOG`.
- Revisit: creator playlists (their own links, with a rights confirmation),
  a DJ volume slider, more artists under CC BY or CC0.

## Action Items

1. [x] Catalog, protocol (`dj`, `dj_skip`, snapshot `dj`) and persona switch.
2. [x] Runtime DJ, file cache and stage route.
3. [x] Stage decks with crossfade, ducking and the credit chip; studio pane.
4. [ ] Listen on a real stream: the DJ's level against the voice on phone
   speakers, and whether TikTok flags any track.
