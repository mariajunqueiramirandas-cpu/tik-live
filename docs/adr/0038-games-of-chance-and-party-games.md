# ADR-0038: Games of chance and party games

**Status:** Proposed (the race and the wheel taken out by ADR-0043)
**Date:** 2026-10-18
**Deciders:** Project owner
**Amends:** ADR-0023 (the game kinds), ADR-0029 (gifts in a team battle)

## Context

Every minigame so far rewards knowing or typing something. The owner asked
for games that are almost pure luck, like betting on a horse race, and for
more ways for the whole room to take part at once. Luck levels the field
(a newcomer can win on their first minute), betting gives people a side to
cheer for, and games that run on likes push the stream's like count, which
TikTok reads as engagement.

## Decision

Four new kinds, made up in code like `number` and `math` (`GENERATED_KINDS`):
no questions to write, nothing to moderate, no wait before the first round.

| Kind | How chat plays | Points |
|---|---|---|
| `race` (Corrida maluca) | Bet on one of five racers by typing its number (one bet each, the first counts). After 25 s the race runs for about 15 s. | 3 × the racer's multiplier |
| `wheel` (Roleta da sorte) | Bet on one of four colors by number or name. After 20 s a strip of 20 tiles spins for 6.5 s. | 4 × the color's multiplier |
| `tug` (Cabo de guerra) | Join team 1 or 2 by typing it; every like, every "puxa" (once every 2.5 s) and every diamond pulls for your team, for 40 s. | 10 to everyone on the winning team, 10 more for its top puller |
| `potato` (Batata quente) | Type "pega" to grab the potato. Every second you hold it is a point; whoever holds it when the secret fuse (25 to 60 s) runs out loses all of theirs. | Seconds held, up to 30 |

- **The odds are honest.** A racer's multiplier is its real chance turned
  around (a 1-in-3 favorite pays ×3, a 1-in-10 long shot ×10), so every bet
  is worth about the same on average and long shots are worth the thrill.
  The wheel's odds are its own tiles: every tile is equally likely, nine of
  twenty are blue (×2), one is gold (×20). The result is drawn when the
  round is made; the stage gets the race's progress a few times a second
  and the wheel's landing tile when the spin starts, so it can animate it.
  The host never sees a result before it's revealed.
- **A new phase, `running`,** sits between `open` and `reveal` for the race
  and the wheel. Bets close when it starts (after the stream delay, as for
  answers); the host gets one cue to narrate it like a race caster.
- **Bets are free and pay points, never money.** Points go to the loop's
  ranking and podium like any other game's.
- **Gifts:** power-ups (ADR-0029) work as before where they make sense: more
  time to bet, double points; no hint in a game of chance, and no extra
  time on a secret fuse. **A tug of war is a team battle,** like TikTok's
  own LIVE battles: a gift pulls for the gifter's team (10 pulls a
  diamond). That's the one place a gift helps one side, and only a side the
  whole team shares; in games of chance gifts never touch the odds, since
  paying for a better chance to win is gambling.
- The new kinds join the automatic run of show, the vote on the last
  segment's game, and the studio's game picker.

## Options considered

- **Let gifts buy bets or boost a racer:** the most direct money-maker, and
  exactly what TikTok's rules on gambling forbid. Rejected.
- **Simulate the race live on the server with random steps:** the result
  would emerge instead of being drawn, but nothing a viewer can see changes,
  and a drawn result is testable and keeps the odds exact.
- **Pay out a share of a pot (parimutuel):** odds that move with the bets
  are hard to read on a phone in 25 seconds; fixed multipliers are shown
  from the start.

## Consequences

- Easier: luck games need no writer and start at once; likes now have a
  game of their own.
- Harder: four more scenes for the stage, and like events reach the game
  master.
- Revisit: whether tug of war's gift weight (10 pulls a diamond) drowns out
  likes on big streams, and the potato's 30-point cap.

## Action Items

1. [x] Generators, readers and the `running` phase in `GameMaster`.
2. [x] Scenes for the four kinds; lab samples; e2e accents.
3. [ ] Watch a real stream: how many people bet, and whether "pega" spam
   floods the chat the host reads.
