# ADR-0049: A stage HUD built to keep people watching

**Status:** Proposed (the safe frame's numbers amended by [ADR-0050](0050-safe-frame-measured-on-a-phone.md))
**Date:** 2026-10-21
**Deciders:** Project owner
**Amends:** ADR-0009 (where the character sits), ADR-0028 (up next and the ranking card), ADR-0032 (where the support card shows), ADR-0036 (the goal panel), ADR-0037 (the call to passers-by), ADR-0039 (the "dono da live" badge and gift power alerts), ADR-0040 (the challenge banner), ADR-0041 (the support ticker and the gift showcase), ADR-0045 (where the now-playing chip sits)

## Context

The owner says the stage's heads-up display is bad and bad at keeping
people's attention, and asked for a complete overhaul. Looking at it as a
viewer on a phone, they're right:

- **Too small to read.** Labels were 15 to 19 px and values 21 to 25 px on
  the 1080 px stage, which is 5 to 9 pt on a phone.
- **No hierarchy.** Six panels of the same weight (dark glass with a thin
  gradient edge) sat in the top third of the screen and competed with each
  other. Nothing said where to look first.
- **Everything at the edges.** A viewer's eye sits on the character and its
  caption; the panels were all at the edges, which people learn to skip.
- **Nothing pulled anyone forward.** The goals said "3.240 / 5.000", a ratio
  nobody does in their head. The countdown to the next game was a small
  chip. Nothing told a viewer what it would take to climb a ranking.
- **Viewers' names were an afterthought.** Alerts were bare lines of text,
  when a viewer's own name on screen is the strongest reason to gift,
  follow and stay.
- **Under TikTok's own UI.** The caption ran to y 1300, into the area where
  TikTok draws its comment feed; panels started 44 to 64 px from the sides,
  which a tall phone crops when TikTok fills the screen with a 9:16 stream.
- **Cut text and collisions.** The ticker cut its lines ("Presentes pagam
  as conta…"), long calls to passers-by were cut, and the now-playing chip
  sat where the alerts stack.

## Decision

Rebuild the HUD around one idea: **calm edges, busy center**. Everything
draws with one kit (`packages/engine/src/text/kit.ts`); the protocol is
unchanged, so the server sends the same messages.

### Principles

1. **Inside TikTok's safe frame.** Anything a viewer must read stays in
   x 96 to 984 and y 236 to 1180: below TikTok's header and chips, above its
   comment feed, clear of what a 20:9 phone crops. One constant each
   (`HUD` in the kit) to tune once checked on a phone.
2. **Readable on a phone.** Names and numbers are 22 to 30 px and up; the
   countdown 34. Small type (17 to 19 px) only for labels a mark already
   explains.
3. **One hero, one call to action.** The character and its caption are the
   hero. Right under the character is the **moment stage**: one card at a
   time, the only thing that asks the room to do something.
4. **Every element gives a reason to stay or act**: what's next on a
   draining ring, what's left for each goal, what takes the crown, how to
   climb the likers, what to type for a vote.
5. **Names are the stars**, at the center when they climb, beside the
   character when they act.
6. **Urgency escalates; the edges stay still.** Motion answers events and
   grows as a moment gets close.
7. **The board wins in a game.** Side cards fold and end above the board.

### The layout (1080 × 1920)

```
 y 228   Segment title (44 px)
 y 288   [✦ Luma é uma IA] [▮▮ now playing · credit]
 y 346   ┌ Kings ───────┐                    ┌ Goals ────────┐
         │ 👑 duda      │                    │ ♥ FALTAM 1.760│
         │    ◆ 25,3 mil│      character     │ ◆ FALTAM 380  │
         │ ♥ mari.souza │    (540, 556),     └───────────────┘
         │    ♥ 1.834   │      r 150         ┌ support line ─┐
         └──────────────┘                    └───────────────┘
         ┌ Dono da live ┐                    ┌ name card ────┐
         └──────────────┘                    ┌ name card ────┐
 y 748   ┌──────────────── MOMENT STAGE (one card) ──────────────┐
 y 896   └───────────────────────────────────────────────────────┘
 y 910                     caption (up to 3 lines)
 y 1110  ─────────────── (TikTok's comment feed below) ───────────
```

The character moves up from y 720 (r 165) to y 556 (r 150) so the stage and
a three-line caption fit above TikTok's comment feed. In a game it still
moves to y 430 (r 105) above the board.

### The edges

- **Title and chips:** the segment's title, then the AI badge (a legal
  requirement, drawn last but one, never hidden) with the now-playing chip
  beside it (its credit line stays on screen while a track plays).
- **The kings** (left): the top gifter and the top liker **both at once**,
  each with a mark in a disc, the name big and the count under it. No more
  taking turns. Whoever isn't there yet is an invitation ("Seja o
  primeiro!", "Toque na tela!"). A soft gold glow while someone holds the
  crown flares when a gift comes in. A vote or one viewer's pick takes the
  card's place while it's open; the vote's tab says what to type.
- **The goals** (right): two thick bars with their marks, filling with a
  spring and saying what's left ("FALTAM 1.760"). Near a goal (80% and up)
  a light runs along the bar; reaching it turns the bar gold with a pop.
- **The support line** (ADR-0041, always on): under the goals, one line at
  a time, wrapping to two rows instead of being cut.
- **Name cards** (alerts): under the support line, the viewer's name big,
  what they did under it in the alert's color ("enviou Rose ×5", "ativou
  Dono da live!", "assumiu a coroa!"). They slide in with a pop; two fit at
  rest.
- **The "dono da live"** under the kings, with how long the reign has left
  on its own line.

### The moment stage

One card at a time, centered under the character, in this order:

1. A **challenge or raffle** (server): its bar says what's left ("640 /
   1.000 · FALTAM 360"); its timer turns hot and beats in the last 10 s.
2. A **call to passers-by** (server), under a cyan tab that speaks to them:
   **"ACABOU DE CHEGAR?"**. Long calls wrap to two lines.
3. **Up next's last seconds**: in the final ten seconds (and while due) it
   goes ahead of everything below.
4. **How to support the show** (server, moved here from the ranking card's
   place): the title and the four ways to help in two columns.
5. The **gift showcase** (server).
6. The stage's **own moments**, decided by a small queue (`MomentQueue`):
   - **"QUASE LÁ!"** when a goal is 80% done: "FALTAM 580 CURTIDAS PRA
     BATER A META!" with the bar and a light along it. At most every 30 s
     while it stays close.
   - **A ranking's top three side by side** when it changes: the gifters
     when a gift comes in or the top three move (with "Roube a coroa: ◆ 25,3
     mil+"), the likers when first place changes (with "Toque na tela pra
     subir!").
   - When the stage has been quiet for 45 s, the rankings come back in turn
     as a reminder.
   - Each moment stays 6 s; a goal close to done goes first; anything that
     waited more than 20 s behind a banner is dropped as old news.
7. **Up next** rests there otherwise: the countdown ring, what it is
   ("PRÓXIMO JOGO") and its title, big. Gold under a minute.

During a game the stage gives way to the board, and up next becomes a
pill atop the left column.

### During a game

The columns widen to 324 px beside the smaller character: up next as a
pill, the kings at one line each, the goals' bars, and the support line,
which gives its spot to a name card when one comes in. Everything ends
above the board (y 556).

### Motion

Sprites gained a **zoom** spring (drawn around their center) and a
horizontal **slide**, for pops and entrances without repainting. Anything
that fills or sweeps repaints at most 15 to 30 times a second while it
moves, and the goal bars snap small steps (likes arrive a few times a
second in a storm), so the cloud broadcaster, which paints in software,
pays little: with the whole HUD up during a simulated like storm, a frame
costs 0.3 ms on average (1 ms at p95) in headless Chromium, as before.

## Options Considered

### Option A: Calm edges, a busy center (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium-high: every HUD element repainted, the character moved, a moment queue |
| Cost | None at runtime beyond a few repaints a second while something moves |
| Scalability | New calls to action go into the stage's order; new edge cards inherit the kit |
| Team familiarity | Same sprite and layer patterns as before |

**Pros:** what asks the room to act is where people look; the edges are
glanceable; everything fits inside TikTok's safe frame; nothing is cut; no
protocol or server change.
**Cons:** the rankings' second and third places only show on the stage
from time to time; the support card is not shown during a game.

### Option B: Keep the side columns, make them bigger and clearer

This was the first version of this ADR's work.

**Pros:** smaller change; every panel always visible.
**Cons:** still six things at the edges competing; the center (under the
character) empty most of the time; the caption still under TikTok's
comments.

### Option C: Everything rotates through one slot

**Pros:** the least on screen at once.
**Cons:** the goals, the kings and up next are the open loops that keep
people watching; hiding them most of the time loses that.

## Trade-off Analysis

A TikTok LIVE is watched on a phone, eyes on the face and the words. Option
A puts the one thing to do right there, keeps the state of the room (who's
on top, how close the goals are) small and still at the edges, and moves
the whole HUD inside the area TikTok leaves clear. Its costs are a busier
stage to reason about (hence a tested queue with a fixed order) and less
room per side card (272 px), which cuts very long names.

## Consequences

- Easier: a viewer can read everything on a phone and knows at a glance
  what's next, how close the goals are and how to get on screen; the
  caption no longer sits under TikTok's comments.
- Harder: the stage's order is a design decision in code (`stage/text.ts`);
  a new call to action must take a place in it.
- Not changed here: the game boards still run to y 1500, into the area
  TikTok's comment feed covers; making them fit the safe frame is a
  separate change.
- Revisit: the safe frame's numbers (no official spec for TikTok LIVE;
  these are conservative), the "QUASE LÁ!" threshold (80%), the 45 s
  reminder, and how long name cards stay up in a gift storm.

## Action Items

1. [x] `text/kit.ts`: the look, the safe frame, marks, text fitting, words and numbers.
2. [x] The edges (`text/hud.ts`) and the moment stage (`text/spotlight.ts`), with folded forms for games.
3. [x] Sprite zoom and slide; the character moved up; the caption above TikTok's comments; the now-playing chip beside the badge.
4. [x] Unit tests for the queue and the words; e2e pixel checks for the new positions, the stage and the fold in games.
5. [ ] Check the safe frame on a phone with TikTok's UI on top (a private test LIVE) and tune `HUD`.
6. [ ] Fit the game boards inside the safe frame.
