# ADR-0041: An always-on support ticker and a gift showcase

**Status:** Proposed
**Date:** 2026-10-20
**Deciders:** Project owner
**Amends:** ADR-0032 (the support card), ADR-0039 (the gift powers card)

## Context

The owner wants the stage to be much better at showing what a gift gets,
and wants some text that asks for support on screen all the time. Until
now both were only up for a moment: the "apoie a live" card (ADR-0032)
and the gift powers card (ADR-0039) took turns with the rankings in the
left column for 18 to 20 seconds every few minutes. That column ends
above where a game board starts, so the powers card had to stay small,
with 17 to 21 px text that's hard to read on a phone.

## Decision

### The support ticker, always on

A new stage message, `ticker`: a title ("APOIE A LIVE") and up to twelve
short lines. The stage shows it top right, under the goals (or in their
place when there are none), the same width as the goals, and turns to
the next line every 4 s with a crossfade and a little hop. Dots in its
header show how far along the lines it is. The server sends it once, and
again only when what it says changes, so it costs nothing per line.

The lines (`runtime/ticker.ts`) are all the show's own rules:

- what gifts pay for: "Presentes pagam as contas da IA";
- what every gift gets: the gifter's name on the live, a spot on the top
  gifters card with a crown for first place, a power-up for everyone
  during a game;
- each gift power with its price, when gift powers are on;
- liking, following and sharing.

Gift lines come up most. In light mode a free way to help follows each of
the first gift lines; a channel that asks actively puts two gift lines
between each free one. `persona.support` turns the ticker off with the
support card.

The alerts used to start just under the goals; they now stack under the
ticker. During a game only two fit above the board, so the oldest fades
when a third comes in.

### The gift showcase

The `perks` card moves out of the left column to a big banner under the
character, in the challenge's place: "O QUE SEU PRESENTE FAZ" in gold,
what every gift gets on the right ("Todo presente: seu nome na live + Top
Doadores", a new optional `every` field), and one tile per power in two
rows, each a price chip and what it unlocks in 18 to 25 px text. The
biggest power is gold and crowned. The tiles pop in one after another,
then the banner bobs like the hook.

Because it no longer takes the rankings' place, it can come up more
often: every 5 minutes (first at 2.5) in light mode, every 3 (first at
1.5) in active mode, for 15 s. It waits while a game, a challenge or a
call to people scrolling past has the spot, and the stage moves it aside
if one comes up while it's showing.

## Consequences

- Something on screen always says how to support the show and what a gift
  gets, during games too.
- The ticker is a general, honest message to the whole room, like the
  support card; it never names a viewer and never says the show stops
  without gifts. It lists only what the show really does.
- The left column is left to the rankings, a vote and the support card.
- The goal panel is 40 px wider so the ticker under it has room for its
  text; both stay right of the character in a game (x 676 and up).
