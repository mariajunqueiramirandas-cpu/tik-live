# ADR-0039: Gift powers

**Status:** Proposed
**Date:** 2026-10-18
**Deciders:** Project owner
**Amends:** ADR-0032 (what a gift gets in light mode), ADR-0029 (who picks a game)

## Context

The owner wants gifters rewarded far more, in ways that are fun to watch:
picking the next segment, being treated like royalty. A gift so far got a
thank-you, an alert, a place on the gifters' card and, during a round, a
power-up for everyone. Creators who stream by hand sell this kind of moment
all the time ("rosa = flexão"); a host that can deliver it instantly, every
time, should too.

## Decision

**A gift unlocks a power on the show, right away and on screen.** Each power
includes the ones below it (`runtime/perks.ts`):

| Diamonds | Power | What happens |
|---|---|---|
| 5 | Fura-fila | For 3 minutes their messages are answered first, never passed over |
| 30 | Escolha do jogo | They pick the next minigame from three (one a party game); only their message counts, 30 s, or the show draws for them |
| 99 | Hino pessoal | The host composes and sings a short anthem about them (music on), or raps two lines |
| 199 | Dono da live | For 5 minutes a crown badge with their name, their messages go first, and the host treats them like royalty and does what they ask when it's safe |

- A viewer's gifts add up for a minute after their last one, so five roses
  sent one by one unlock what one five-diamond gift would. Unlocking spends
  the credit.
- A bigger fan can take the crown from the "dono da live"; the host plays up
  the coup.
- **The gift's thank-you carries the power.** The brief marks the gift
  ("unlocked Escolha do jogo … the card shows their options"), so thanking
  and announcing are one turn. A pick that has to wait behind another one
  opens later with its own announcement; the picked game starts once the
  host has said who chose it, before the segment's own game.
- A stage alert names the power ("duda desbloqueou Dono da live!"), and
  taking first place among the gifters gets one too ("assumiu o topo dos
  presentes!"), at most every 20 s.
- Now and then the ranking card shows the table of powers (every 7 minutes,
  every 4 in active gift mode), and the host's support explanation names a
  couple of them.
- `safety.giftPerks` turns all of it off (on when unset).

**In light gift mode,** the powers are the show's own rules, like game
power-ups: the host explains them to the whole room and never asks one
viewer by name to gift for one. In active mode it brings them up when it
asks for gifts, and a call to passers-by offers the pick. The moderator's
policy lists the powers as safe to explain and deliver.

## Options considered

- **A points store viewers spend:** ADR-0037 rejected it as too much to
  explain; tiers by diamonds are on one card.
- **Powers that change a game's odds:** gambling. Rejected (ADR-0038).
- **Only the biggest gifts:** most gifts are small; a five-diamond power
  gives a rose-sender something to feel.

## Consequences

- Easier: gifting has a visible, immediate result, and the most generous
  viewers shape the show.
- Harder: the host's turns are busier around gifts, and ADR-0032's light
  mode now promises something in exchange for a gift (the show's rules on
  the card). Creators who don't want that turn the powers off.
- Revisit: the thresholds against TikTok's gift prices, and whether the
  boss's requests need their own guardrails beyond the safety gate.

## Action Items

1. [x] `GiftPerks`, triage promotion and brief tags, the pick, the anthem, the crown.
2. [x] `perks`, `boss` messages, `crown` and `perk` alerts, `vote.by`.
3. [x] Safety page switch; moderator addendum.
4. [ ] Watch a real stream: which powers people buy, and whether "fura-fila" makes the rest of chat feel ignored.
