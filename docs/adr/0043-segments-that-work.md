# ADR-0043: The show leans toward the segments that work

**Status:** Proposed
**Date:** 2026-10-20
**Deciders:** Project owner
**Amends:** ADR-0035 (how the automatic run of show draws its segments)

## Context

The owner asked for a smarter host: one that knows which segments bring in
the most viewers, likes and gifts, and focuses on those. Until now the
director played every segment the same way. The automatic run of show
(ADR-0035) drew talk formats and games uniformly at random, gave each the
same minutes whatever happened, and nothing a stream taught carried over
to the next one.

## Decision

### Measure each segment against its own stream

The director meters the stream and the segment on air (`SegmentMeter`):
likes, diamonds, and viewers integrated over time. When a segment ends, its
take is scored against **the rest of the same stream so far**, in log2
lifts (+1 is twice the stream's average, -1 half):

- **viewers** (40%): the time-weighted average against the stream's, plus
  whether people came or left during the segment. A stream's first segment
  skips the second part: everyone is still arriving.
- **likes** (30%) and **diamonds** (30%) per minute against the stream's.

Measuring against the same stream means a busy Friday and a quiet Tuesday
count the same, so the record reflects the segment, not the night. A small
prior (3 likes, 2 diamonds a minute) keeps tiny numbers from looking huge,
each lift is capped at 4x either way so one whale's gift doesn't decide the
show, and takes under 2 minutes or with an empty room teach nothing.

### Remember it per channel

`SegmentScores` keeps a moving average per segment (recent takes count at
least 20%, so it follows a changing audience) in a new `segment_scores`
table: one row per channel, like `host_memory` (ADR-0033). A segment is
keyed by what it is: an automatic talk format by its title
(`talk:Resenha`), an automatic game by the game it actually played
(`game:trivia`, chat's vote included), a creator's segment by its id
(`segment:<id>`). Practice mode learns within the session but never saves:
a simulated audience reacts at random. Nothing new runs on the hot path and
there are no model calls; scores are in memory and flushed with the rest.

The score the show leans on is shrunk toward average until a segment has a
few plays (`plays / (plays + 2)`), and becomes a **focus weight** of
`2^(1.5 × score)`, clamped to 0.25–4.

### Use it

1. **The automatic run of show draws by weight.** Each loop's talk formats
   and games are a weighted shuffle (Efraimidis–Spirakis), so what works
   comes up sooner and more often, and its minutes stretch by up to 50%
   (weak ones trim by up to 25%). Unplayed formats sit at 1, and the floor
   of 0.25 keeps weak ones coming up now and then, so the show keeps
   exploring and a format can earn its way back. Without scores the plan is
   exactly ADR-0035's.
2. **Live focus.** Once a segment has run 60% of its time (and at least 3
   minutes), a segment pulling clearly more than the stream so far (+0.6,
   about +50%) gets half its length again (at most 5 minutes) when it's
   about to end, and the host is told to keep doing what's working. An
   automatic segment clearly losing the room (-0.75, about -40%) wraps up
   early; the one chat votes in keeps 3 minutes for the vote. A creator's
   own segments are only ever extended, never cut: their run of show is
   theirs.
3. **The host knows.** When a segment with a record starts (the opening
   and every segment change), the brief carries a "Track record" line: one
   of your best segments (and for what), or one that tends to lose the room
   (keep it punchy, bring chat in right away).
4. **The creator sees it.** The Desempenho tab lists "Quadros que mais
   rendem" (`GET /api/channels/:id/segments`): each segment's lift in
   viewers, likes and diamonds, how many times it played, and whether the
   show is leaning toward it.

## Consequences

- The automatic run of show gets better the more a channel streams, with
  no setup and no extra AI cost.
- Creators with a manual roteiro keep their order; they get live
  extensions, a host that knows their strong segments, and the numbers to
  rearrange the roteiro themselves.
- Lifts are correlations, not proof: a segment that happens to run when a
  raid arrives looks good. Averaging over plays, the caps and the shrinkage
  limit this, and the floor weight lets the show find out again.
- A segment extended live pushes the rest of the loop later; the up-next
  estimates follow.
- Revisit: the 40/30/30 weights (messages and follows aren't counted), the
  thresholds for live focus, and whether a creator should be able to turn
  live focus off or reset a channel's scores from the dashboard.
