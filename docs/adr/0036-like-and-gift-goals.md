# ADR-0036: Like and gift goals on stage

**Status:** Proposed
**Date:** 2026-10-18
**Deciders:** Project owner
**Amends:** ADR-0028 (like milestones), ADR-0032 (talking about gifts)

## Context

The owner asked for a like goal and a gift goal. Goals give the room
something to do together: everyone can see how far it is, and reaching it
is a moment. Until now the stream celebrated fixed like milestones (100,
500, 1,000...) that nobody could see coming, and gifts had no shared target.

## Decision

**Two goals, always running.** `StreamGoals` keeps a like goal and a gift
goal (counted in diamonds, like the gift ranking). When the count reaches
the target, the goal is reached and the next one is set right away, so the
bar is never stuck full. One jump that passes several targets (a big gift)
celebrates the highest one, once.

**Targets.** In the Roteiro tab the creator turns the goals on or off
(`persona.goals.show`, on when unset) and may set a target for each. A
target is the first goal and the step to the next ones (5,000, then 10,000,
15,000...). Unset, the targets climb a ladder: 500, 1,000, 2,500 likes up to
100,000 and then every 100,000; 100, 250, 500 diamonds up to 10,000 and
then every 10,000. A new target from the studio applies at once, without
celebrating what's already in; turning the goals on mid-stream does the
same. Joining a stream that already has likes takes them as a baseline. A
new stream starts both goals over.

**On stage.** A panel top right, across from the segment title and above
the alerts, clear of the orb at rest and during games: "METAS DA LIVE" and
one bar per goal with the count and the target ("3.240 / 5.000"). Progress
goes out as a `goals` message, coalesced to a few a second like the like
counter; a goal reached goes out at once. That bar turns gold and reads
"META BATIDA!" for four seconds, with hearts or fireworks, confetti and a
fanfare, then shows the next goal.

**The host.** Each turn's brief carries the goals ("likes 3,240 of 5,000
(goal 2); gifts 120 of 500 diamonds (goal 1)"), and the system prompt says
to mention them now and then, above all when one is close. A quiet moment
can cheer chat on toward them. A goal reached is a milestone turn, or folds
into the reaction already coming (the gift that reached it, say). While
the goals are on, the like goal replaces the fixed milestones, so the room
gets one celebration, not two; with them off, the milestones come back.

**Gifts stay light.** In light mode (ADR-0032) the gift goal is something
to cheer on together: the host talks about it to the whole room, never to
one viewer by name. The moderator's policy says cheering the room on toward
the goal on screen is safe; asking a viewer by name for a gift still isn't.
In active mode the host may rally the room for it as part of asking for
gifts.

## Options considered

- **Goals in the ranking card's rotation:** no room in the left column
  would be needed, but a goal only works if people can watch it fill.
- **Fixed goals that stop when reached:** a full bar for the rest of the
  stream is dead space; the next goal keeps the room going.
- **Keep the like milestones alongside the like goal:** two parties for
  nearly the same thing, with a creator's target, at odd numbers.
- **Count gifts, not diamonds:** a rose and a lion would count the same.

## Consequences

- Easier: the room always has something to push toward, and the host has a
  reason to mention likes and gifts that isn't begging.
- Harder: the top-right corner now has a panel. A very long segment title
  may come close to it; titles are already capped at 640 px.
- Revisit: whether the targets should follow the audience size (a goal of
  500 likes is hard for 3 viewers and trivial for 3,000), and whether goals
  should carry over a restart within a stream.
