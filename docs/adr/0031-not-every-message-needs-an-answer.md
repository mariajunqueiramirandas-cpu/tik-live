# ADR-0031: Not every message needs an answer, and chat can't hold the show

**Status:** Proposed
**Date:** 2026-10-18
**Deciders:** Project owner
**Amends:** ADR-0022 (what triage queues), ADR-0026 (the director's order of business)

## Context

The owner saw two problems on real streams:

1. **The host answered everything.** Viewers talk to each other in chat
   ("@ana viu o jogo?"), laugh ("kkkkk") or just say "ok". Every message
   that passed triage's safety rules was queued, so the host butted into
   conversations that weren't for it and replied to laughs. With a single
   message waiting, the brief didn't even let it skip one.
2. **The host couldn't move on.** On a busy chat, reactions (priority 50)
   always came before anything else. The host answered person after person
   and the run of show only moved when a segment was 30 s overdue.

## Decision

### Triage hears asides without queueing them

Plain chat (not a TikTok question, and not naming the host) is *overheard*
when it

- @mentions someone (a viewer talking to another viewer), or
- is only laughter (kkk, haha, rsrs, lol), emoji, punctuation, or a one-word
  "ok".

Overheard chat passed the safety rules, so it goes into the host's room
like any other message (the host knows what the room is talking about), but
it isn't queued: nothing asks the host to answer it, and it doesn't cut a
filler short. Triage returns `{ queued: false, overheard: true }`.

### The host may pass

The system prompt says viewers talk to each other and the host should leave
those conversations alone. When a reaction covers only chat (no gift,
follow or milestone to celebrate), the brief allows `[pass]`: a reply of
just `[pass]` has no speakable text, so nothing airs and the turn doesn't
commit; its room comes back in the next turn. "Skip a message that doesn't
need you" now covers viewers talking to each other.

### A busy chat gives the show a turn

After **four reactions to chat in a row**, while more chat is waiting, the
next turn belongs to the show: the segment change if it's due, otherwise a
new `show` turn (priority 20, like a segment change: chat doesn't cut it,
gifts do). It thanks the gifts and follows waiting, nods to the room as a
whole, and gets on with the segment (or the game). Plain chat that piled up
is let go (it's in the room the host sees); questions stay queued for the
next reaction. Any turn other than a reaction resets the count.

## Consequences

- Fewer, better replies on busy streams, and segments start on time.
- A message that only @mentions another viewer won't be answered even if it
  was meant for the host; naming the host still gets through.
- A `[pass]` still costs a model call; its room is read again next turn.
