# ADR-0028: Up next, a 15-minute like ranking, and a loop ranking with a podium

**Status:** Proposed
**Date:** 2026-10-18
**Deciders:** Project owner

## Context

Viewers who join mid-stream can't tell what the show will do next: the run
of show (segments and their minigames) lived only in the studio. Likes were
counted only as a stream total, so the people tapping hardest got no
recognition. And game scores lived and died with each game: someone who
played well across a whole show never saw it add up to anything.

## Decision

**Up next.** The director, which owns the run of show, lists what's coming
(`Director.upNext`): the current segment's next game (when it would start,
by the same rules that start it), the loop's podium when the loop is about
to end, and the following segments, up to four items. Times are absolute on
the server and sent to the stage as `schedule` (time left on receipt, like
game timers) only when the list or a time changes; the stage counts down on
its own clock and shows "já já" once an item is due. They're estimates: a
segment change waits for a game in progress and a quiet moment. The studio
gets the same list in the snapshot (`upNext`).

**Top likers.** A `RollingBoard` keeps every like event of the last 15 minutes
in arrival order with a running total per viewer; anything older than the
window is dropped as time passes, so the board is about who is tapping now.
Names go through the same filter as spoken names (blocklisted or
injection-looking names read "visitante"). The stage gets the top five as
`likers` at most once a second and shows three; the studio shows them too.

**Loop ranking and podium.** A loop is one pass through every segment of
the run of show (a show with a single segment loops each time it runs out).
`LoopRanking` adds up every point any game awards during the loop. When the
last segment ends, the segment change waits while the top three are
revealed on stage, one place at a time: a drumroll and a beat of suspense
from the host, then third place, again for second, and a bigger moment for
first (fanfare, fireworks, confetti). Each step waits for the host to finish
talking, with a ceiling so a stuck host can't stall the show. The reveal is
a `podium` game scene, so it reuses the game layer's layout and the game
cue path to the host, who only ever sees the places already on screen.
Then the ranking starts over. Nobody scored: no podium, the loop just
restarts. A stream ending resets both rankings; "Parar jogo" in the studio
ends a podium early.

## Options considered

- **Show the whole run of show on stage:** more to read than a phone screen
  allows; the next item or two is what viewers need.
- **Like ranking over the whole stream:** rewards whoever came early and
  never changes; a sliding window keeps it live.
- **Rank loop points live on stage all the time:** gives the ending away;
  the studio shows it, the stage saves it for the podium.
- **Reveal all three places at once** (the per-game scoreboard): no
  suspense, which was the point.

## Consequences

- Easier: viewers see what's next and when, regulars have two rankings to
  climb, and every game feeds a bigger moment at the end of the loop.
- Harder: the stage's top-left area now has two panels; long names are cut
  to fit, and the panels sit clear of the game board and the alerts.
- Revisit: persisting rankings across streams (season leaderboards, as
  ADR-0023 suggested), and whether the like window should be configurable.

## Action Items

1. [x] `RollingBoard`, `LoopRanking`, director schedule and loop end, stage hub replay on connect.
2. [x] Protocol: `schedule`, `leaders`, the `podium` scene, snapshot `upNext`, `leaders`, `ranking`.
3. [x] Stage panels and the podium scene; studio panes.
4. [ ] Watch a real stream: is 15 minutes the right like window, and are the podium pauses too long?
