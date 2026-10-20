# ADR-0042: Take out the betting games

**Status:** Proposed
**Date:** 2026-10-20
**Deciders:** Project owner
**Amends:** ADR-0038 (the race and the wheel)

## Context

ADR-0038 added two games chat bets on, a horse race (`race`, "Corrida
maluca") and a wheel (`wheel`, "Roleta da sorte"). Bets were free and paid
points, but the owner asked to take the horse race and every betting game
off the show.

## Decision

- `race` and `wheel` are gone from `GAME_KINDS`, the stage's scenes, the
  automatic run of show, the vote on the last segment's game, a viewer's
  own pick, the studio's game picker, the host's prompt and the
  moderator's policy. The tug of war and the hot potato stay: nobody bets
  on them.
- The `running` phase and the betting `stage` (`bets`, `running`,
  `finish`) only served those two games, so they're gone too.
- **Saved shows keep working.** Migration `0003_retire_betting_games`
  turns a saved segment's `race` or `wheel` into `random`, and
  `RETIRED_GAME_KINDS` does the same for anything that still names one (a
  persona sent from an old dashboard, a row read before the migration).

## Consequences

- Easier: two fewer scenes, and game rounds go straight from `open` to
  `reveal` again.
- A stage page loaded before this change still knows how to draw a race;
  it never gets one again.
