# ADR-0046: Gifts first, every time, and hype mode on stage

**Status:** Proposed
**Date:** 2026-10-21
**Deciders:** Project owner
**Amends:** ADR-0022 (what a gift may interrupt), ADR-0023 (gift reactions on stage), ADR-0026 (the director's order), ADR-0032 (gift moments)

## Context

The owner wants gifts to be the top priority every time, and wants a gift
to feel like a real reward: something loud and over the top, with gaming
and meme culture in it (RGB lights, MLG sunglasses), so people feel it was
worth it.

Gifts already ranked high, but not first. A gift waited for:

- **game moments, the owner's requests and segment changes**, which the
  director picked before any reaction;
- **a reaction or a game round already under way**: a gift could only cut
  filler, a segment intro, the show turn or a milestone;
- **a "dono da live" message to the host by name**, which could outscore
  a 1-diamond gift in triage (up to about 130 against 100);
- and a gift waiting more than **2 minutes** was dropped unthanked.

On stage, small gifts (under 10 diamonds) got a few sparkles; most of the
show happened only from 100 diamonds up.

## Decision

### Gifts come first

- **Triage:** a gift scores from `GIFT_PRIORITY` (1000) up, above anything
  a message can reach, and waits up to **10 minutes** for its thank-you.
- **A turn of their own:** a new turn kind, `thanks`, covers the gifts
  waiting (biggest first) and nothing else. The director picks it right
  after the opening, ahead of game moments, the owner's requests, segment
  changes, the busy-chat show turn and every reaction. A game round waiting
  for the floor holds everything but it. Chat waits for the next turn.
- **Interrupting:** a gift's urgency is 90. It cuts any turn at the next
  sentence boundary except another gift's moment: `thanks` (100) and a
  gift power being delivered, such as a gifter's anthem (`perk`, 95). A
  gift that arrives during a thank-you gets the next turn.
- **The host's brief** for a `thanks` turn says gifts come first and asks
  for the loudest moment of the stream: the name shouted, a legendary
  title, Brazilian hype ("MITOU!", "+1000 de aura"), and the new `[mlg]`
  effect tag for big gifts. The system prompt says nothing goes ahead of a
  gift. A goal or level-up the gift reached rides along on the same turn.

### Hype mode on stage

Every gift sets it off from its alert, on top of the tier's particles, so
no new protocol message is needed (`Hype` in
`packages/engine/src/stage/hype.ts`, part of the effects chunk):

- an **RGB LED strip** around the stage's edge, a rainbow running around
  it with light chasing along the strip;
- **lasers** sweeping from the four corners, in cycling colors;
- pixel **"deal with it" sunglasses** sliding down onto the host's eyes
  (onto the middle of the line for a voice-only host);
- **meme stamps** slammed onto the stage in rainbow letters, in Brazilian
  internet slang plus the MLG classics: "MITOU!", "BRABO!", "+1000 DE
  AURA", "INSANO", "DEAL WITH IT", "OH BABY A TRIPLE", "360 NO SCOPE";
- **hitmarkers** popping around the host;
- and two new synthesized sounds the director sends with every gift: an
  **air horn** and a **hitmarker** click.

How much depends on the gift's tier (`hypeFor`):

| Tier | Lights | Lasers | Glasses | Stamps | Hitmarkers |
|---|---|---|---|---|---|
| 1 to 9 diamonds | 3.5 s | none | 3 s | 1 | 3 |
| 10 to 99 | 5.5 s | 3.5 s | 4.5 s | 2 | 5 |
| 100 to 999 | 8.5 s | 7 s | 7 s | 3 | 9 |
| 1000 and up | 13 s | 12 s | 11 s | 4 | 14 |

A combo of gifts in a row adds 0.6 s a gift (up to 6 s) and more
hitmarkers; three in a row bring the lasers out even for roses, and five
add a stamp. Big gifts (100 and up) get the brighter lights and the whole
list of stamps. The host can call it with `[mlg]`.

Readability and comfort:

- The lights pulse gently twice a second and never strobe (no flashes
  over three a second).
- Lights are drawn under everything ahead of the character, stamps under
  the gift banner, so the gifter's name always reads. During a game the
  stamps are smaller and stay beside the character, off the board.
- The edge light draws four 150 px strips, never a full-screen pass, and
  nothing draws when hype mode is off, so software rendering in the cloud
  broadcaster pays for it only during a gift.

## Options Considered

### Option A: A turn of its own for gifts, hype mode in the engine (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: one turn kind, one engine module, two sounds |
| Cost | No model calls added; GPU work only while hype mode is on |
| Scalability | Unchanged |
| Team familiarity | Same layers and patterns as the other effects |

**Pros:** a gift is never behind anything; the reaction is on screen the
moment the alert arrives; no protocol change.
**Cons:** a gift can cut a game round's narration short (the board still
shows it); chat waits one turn more when gifts arrive.

### Option B: Keep gifts inside the next reaction, only raise their score

**Pros:** smallest change.
**Cons:** game moments, requests and segment changes still go first, and
the gifter shares the moment with chat.

### Option C: Server-driven effects (a new `hype` message)

**Pros:** the server could tune hype per channel.
**Cons:** a second message for every gift, and the stage already knows the
diamonds from the alert.

## Trade-off Analysis

The owner asked for gifts first every time, so a narrated game moment or a
reply to chat may wait or be cut at a sentence boundary for one. Game
boards, votes and the turns themselves keep working; only the host's words
about them move later. Hype mode is client-side so it starts with the alert,
with no round trip.

## Consequences

- Every gift, from a single rose, gets lights, sunglasses, a stamp, an air
  horn and a turn of its own.
- Chat replies come one turn later when gifts are waiting.
- A gift power being delivered (an anthem) still plays to the end.
- Tests: director, triage and engine tests cover the order, the
  interruptions and hype levels; the lab's effect list includes `mlg`.

## Action Items

1. [x] `thanks` turns, gift urgency 90, `GIFT_PRIORITY`, 10-minute gift TTL.
2. [x] Hype mode on stage, the `mlg` effect, `airhorn` and `hitmarker` sounds.
3. [ ] Watch the next streams' chat response times with heavy gifting; if chat waits too long, cap `thanks` turns to one every few seconds.
