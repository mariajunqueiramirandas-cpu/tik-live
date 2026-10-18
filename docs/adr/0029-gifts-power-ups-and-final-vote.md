# ADR-0029: A gift ranking, gift combos and power-ups, and chat's vote on the last segment

**Status:** Proposed
**Date:** 2026-10-18
**Deciders:** Project owner

## Context

ADR-0028 added an "up next" panel, a like ranking and a loop podium. The
owner asked for more: a heads-up display that looks better and stays out of
the way, a ranking of gifts that forgets gifts older than an hour, more
gift effects, gift power-ups, and a way for viewers to vote on the last
segment.

## Decision

**One heads-up column, kept small.** Top left under the disclosure badge,
340 px wide, so it stays left of the character in both layouts and ends
above where a game board starts (y 560). It's clear of TikTok's header,
right rail and comment area. It holds a slim glass "A seguir" pill with a
countdown chip, and one ranking card that takes turns (every 8 s, with a
crossfade) between top likers (15 minutes) and top gifters (diamonds, one
hour). While a vote is open, the card shows the vote instead. Both rankings
use the same `RollingBoard` and go to the stage as `leaders` messages.

**Gift combos.** Gifts within 5 s of each other build a "COMBO ×N" over the
character's head. Every fifth gift in a row showers gold and confetti, and
every tenth sets off fireworks. This is computed on the stage from the
alerts it already gets, so it needs no new message.

**Power-ups help everyone, never the gifter alone.** Diamonds sent while a
round is open add up. At 10 the round gets 10 more seconds, at 50 a hint (a
50/50 in a quiz, the hint early in scrambles and riddles, a narrower window
in guess the number), and at 100 double points for everyone who gets it
right. A boost that doesn't fit the game is skipped (no hint in a typing
race, no points in a poll). The gifter is thanked by name. They get no
points and no answer, which keeps ADR-0023's "never gift to win". The stage
shows a banner (`boost`), and the round's scene carries the lasting change.

**Chat picks the last segment's game.** In the last three minutes of the
second-to-last segment, the stage opens a vote between three minigames (a
different trio each loop). Viewers type 1, 2 or 3 (or the game's name), and
the first ballot counts. Ballots, like game answers, aren't queued for the
host. Moving into the last segment closes the vote, and the winner becomes
that segment's game. If nobody voted, it plays as planned. It's on by
default with at least two segments, and creators turn it off in the
Roteiro tab (`persona.finalVote`).

## Options considered

- **Separate panels for each ranking:** more to read and more screen; one
  card that takes turns keeps the column short enough to fit above a board.
- **Power-ups for the gifter only** (extra points, a free answer): pays to
  win. Rejected.
- **Vote on any segment:** the run of show still needs a shape; voting on
  the last segment's game gives chat a say without breaking it.

## Consequences

- Easier: gifts have a visible effect on the game everyone's playing, and
  the end of each loop is shaped by chat.
- Harder: a power-up banner covers the board for 2 s, and in a quiz a
  ballot "1" during an open round counts as an answer (the game reads chat
  first), so the vote waits for quiet moments in practice.
- Revisit: power-up thresholds per channel, and whether gift power-ups
  should have a cooldown on very busy streams.

## Action Items

1. [x] Rolling gift board, `leaders` message, HUD column with the ranking card.
2. [x] Gift combos; power-ups in `GameMaster.handleGift`, `boost` message, board changes.
3. [x] Final-segment vote: director, `vote` message, studio pane, Roteiro switch.
4. [ ] Watch a real stream: are the power-up thresholds right for TikTok's gift prices?
