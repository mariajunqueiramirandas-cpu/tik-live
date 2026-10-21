# ADR-0050: The stage's safe frame, measured on a phone

**Status:** Proposed
**Date:** 2026-10-21
**Deciders:** Project owner
**Amends:** ADR-0049 (the safe frame's numbers, where everything sits), ADR-0023 (where the game board and the in-game caption sit)

## Context

ADR-0049 kept everything a viewer reads inside a safe frame whose numbers
were guesses: there's no official spec for where TikTok LIVE's own UI sits,
so it assumed TikTok might crop 96 px off each side, cover the top 236 px,
and start its comment feed near y 1180.

The owner then sent a screenshot of a real stream on an Android phone
(920 × 2000, a 20:9 screen). Mapping it back to stage coordinates through
the game board's known edges (x 84 and 996) and its header (y 622):

- TikTok shows the stream at **full width**, scaled 0.851, starting just
  under its header. **Nothing is cropped at the sides.**
- TikTok's row of chips (game ranking, the rose goal, the room's topic)
  covers the stream from **y 13 to 79**. The header above it sits outside
  the stream.
- Its "entrou" notice row starts at **y ~1325**, and the comment feed covers
  everything under it, nearly the full width, down to the input bar.

What that screenshot showed was wrong:

- In a game, the board's last row, its footer ("0 respostas · digite V ou
  F") and the host's caption (at y 1512) sat under the notices and the
  comments, unreadable.
- At rest, the HUD left about 150 px unused at the top and wasted width on
  side margins TikTok doesn't crop.

## Decision

Use the measured frame: **x 48 to 1032, y 100 to 1310** (`HUD` in
`packages/engine/src/text/kit.ts`, `safeBottom: 1310`).

At rest:

- Title at y 104, the AI badge and now playing at y 164, side cards from
  y 222, 300 px wide (were 272).
- The character back to full size (r 165) at y 504.
- The moment stage at y 702 to 850; the caption from y 872, back to its
  original sizes (64, 56, 48 px), ending by y 1090 at three lines.

In a game:

- The character at y 326, r 92 (was y 430, r 105); side columns 372 px wide
  beside it; up next's pill bigger (72 px, its time in 26 px type, which
  was too small to read on the phone).
- The board moves up and gets shorter: its header at y 474 (was 622), its
  body from y 556 to its footer at y 1176 (was 708 to 1460).
- The in-game caption sits right under the board at y 1206, two lines of
  44 px at most, ending by y 1305 (was y 1512, under the comments).
- Scenes with fixed sizes now fit the shorter board:
  - Trivia gets two tighter steps before any answer is cut to one line.
  - The four-option poll gets slimmer bars.
  - Math's chalkboard is shorter.
  - Tug of war's panels and rope sit closer.
  - Hot potato's potato is smaller.
  - The scoreboard and the podium are placed from the board instead of
    fixed y values.
- Hype stamps in a game move up beside the character.

An e2e test now draws every kind of board, the full HUD and a long caption,
and checks that nothing new shows up below y 1325, at rest or in a game.

## Options Considered

### Option A: Move and shorten the board, caption under it (chosen)

**Pros:** everything readable on the phone; one scene file changes; boards
keep their designs.
**Cons:** boards are about 18% shorter, so long questions and answers use
the smaller of their type sizes more often.

### Option B: Scale the whole board down

**Pros:** no per-scene changes.
**Cons:** everything on the board, the answers people type included, gets
smaller and narrower; the scenes already fit text to their space better
than a uniform scale would.

### Option C: Put the in-game caption over the board

**Pros:** the board keeps its height.
**Cons:** covers what people are answering.

## Consequences

- Easier: the layout matches what viewers actually see on a 20:9 phone,
  the most common shape now.
- Harder: phones with a 16:9 screen (rare now) show the stream filling the
  screen, so TikTok's header covers more of the top there; the title row
  may sit under it.
- Revisit: check an iPhone (19.5:9) the same way, and TikTok LIVE Studio's
  own layout guide.

## Action Items

1. [x] `HUD` from the measured frame; the character, the caption, the board and the in-game caption moved.
2. [x] Scenes with fixed sizes fit the shorter board.
3. [x] An e2e test for nothing below y 1325.
4. [ ] Measure an iPhone screenshot the same way.
