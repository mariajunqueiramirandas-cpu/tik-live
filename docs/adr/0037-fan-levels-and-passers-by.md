# ADR-0037: Fan levels, and catching people scrolling past

**Status:** Proposed
**Date:** 2026-10-18
**Deciders:** Project owner
**Amends:** ADR-0012 (what the host's turns are for), ADR-0033 (what the host knows about a viewer)

## Context

The owner wants more people to stop on the stream while scrolling through
LIVEs, to stay longer, to come back, and to gift more. Someone swiping
through LIVEs gives a stream a second or two, with the sound on. The viewer
memory (ADR-0033) already keeps, per viewer and across streams, how many
streams they came to, how much they chatted, followed, shared and gifted,
but nothing on stage showed it.

## Decision

### Fan levels

Every viewer has a fan level, worked out from what the memory already
keeps, so there's nothing new to store (`brain/fans.ts`):

| | Points |
|---|---|
| Each stream they come to | 25 |
| A message (at most 30 per stream, so spam can't farm it) | 2 |
| Following (once) | 40 |
| A share (at most 3 per stream) | 15 |
| A diamond | 3 |

Level *n* starts at 25·*n*·(*n*−1) points: 50 for level 2, 150, 300, 500…
up to 99. A regular who chats reaches level 4 or 5 in ten streams; a Galaxy
(1,000 diamonds) is level 11.

- **On stage:** each level-up from level 2 is an alert, "duda subiu pro
  nível 7!", with stars, sparkles and a level-up sound.
- **The host:** from level 3, the director passes level-ups to the host,
  folded into the next reaction or a milestone turn, at most once every 90
  seconds and three names at a time, and the host congratulates them by
  name. Every viewer's "about" carries their level from level 2, so the
  host can treat high levels as VIPs and answer "qual meu nível?".
- **Gifts stay light:** in light gift mode (ADR-0032) the host never tells
  one viewer to gift to level up. In active mode it may say gifts make it
  grow fastest.
- A level-up is checked around each event the memory sees. A returning
  viewer whose stored history loads after their first message doesn't get
  a false level-up for the history.

### Catching people scrolling past

- **A call in a quiet moment.** A minute and a half in, then every four
  minutes, and sooner after three arrivals within 30 seconds (at most once
  a minute), a quiet moment opens with the host talking straight to people
  passing by ("ei, você que tá passando!") and a concrete reason to stay:
  - type your name and get a nickname;
  - ask the AI anything;
  - get your name rated;
  - games worth the podium are coming;
  - say where you're from.
  The stage shows the same offer big for nine seconds, in a bright banner
  under the character (`hook`). Not during a game; the support explanation
  goes first when both are due.
- **A stage that never looks frozen.** After 25 seconds with nothing moving
  (no gift, follow or share), the stage plays a small flourish: sparkles, a
  jump, stars, a spin, bubbles in turn. Not during a game or a podium.
- **Every reply opens strong.** The system prompt tells the host that most
  of its audience gives it a second or two, so every reply starts with its
  most interesting sentence, never a warm-up.

## Options considered

- **A loyalty store with points to spend:** more to build and explain, and
  rewards for gifts run into ADR-0032's light mode. A level is recognition,
  which is what drives regulars.
- **Store levels in their own table:** the counts are already stored;
  working the level out keeps one source of truth.
- **Count watch time toward the level:** TikTok doesn't report when a
  viewer leaves, so time watched can't be measured honestly.
- **A permanent banner:** banner blindness. A call that comes and goes,
  said out loud, gets noticed.

## Consequences

- Easier: regulars have something to climb across streams, and newcomers
  hear within seconds what they can do.
- Harder: more on screen for a moment. The banner sits between the
  character and the caption and gives way to games.
- Revisit: whether level-up alerts get noisy on very busy streams, and
  which offers keep people longest (worth measuring per offer).
