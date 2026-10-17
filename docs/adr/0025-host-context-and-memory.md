# ADR-0025: What the host knows each turn

**Status:** Proposed
**Date:** 2026-10-17
**Deciders:** Project owner
**Amends:** ADR-0012 (prompt contents)

## Context

On a real stream the host looked careless: it asked the same question twice,
introduced itself again, insisted it was the middle of the night at 2 pm
because its theme was a "late-night radio", refused to sing, and the
moderator blocked a harmless line ("what beat is your head asking for?",
said after a viewer asked for a funk song) as a veiled threat. Each turn is a
stateless request, and the turn message held only the host's last eight lines
and the newest events: no conversation, no clock. The moderator saw each
sentence alone.

## Decision

Every turn now carries:

- **Room history:** the last ~28 moments of the room (chat that passed
  triage, gifts, follows, the host's own lines, show moments like game
  rounds and segment changes), interleaved, with "N min ago", as escaped
  untrusted data. Lines still queued are listed separately so the reply
  continues from them.
- **Local time** in the host's time zone (`persona.timezone`, set from the
  creator's browser when the host is created, editable), or UTC flagged as
  such.
- **The show so far:** every ~4 minutes, when there's enough new material, a
  low-effort structured call (the "chronicler") folds the room into a short
  running summary and up to six harmless notes about viewers (never personal
  data), which the viewer memory keeps across streams.
- **Game state** when a game runs (never an open round's answer).

The system prompt gains "being a good host" rules: read the history, don't
repeat questions or introductions, answer what was asked first, treat the
theme as a performance and believe viewers about their own time and place,
do playful requests (sing, rap, voices) with original lines.

The moderator gets **context**: the chat the line replies to, what the host
just said, and whether it's a game turn, plus a policy line not to build dark
readings out of idioms, slang, wordplay and music talk. It still judges the
sentence, not the chat.

## Consequences

- Easier: continuity, fewer false blocks, a host that matches the hour.
- Harder: turn messages are longer (about 1–2k more input tokens, uncached);
  the chronicler adds a call every few minutes on active streams.
- Revisit: tune `HISTORY_ENTRIES` and the chronicler cadence against cost per
  hour; persist the show summary for "last time on the show" openings.
