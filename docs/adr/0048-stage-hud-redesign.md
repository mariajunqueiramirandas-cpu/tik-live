# ADR-0048: A stage HUD built to keep people watching

**Status:** Proposed
**Date:** 2026-10-21
**Deciders:** Project owner
**Amends:** ADR-0028 (the up next pill and the ranking card), ADR-0036 (the goal panel), ADR-0037 (the call to passers-by), ADR-0039 (the "dono da live" badge and gift power alerts), ADR-0040 (the challenge banner), ADR-0041 (the support ticker and the gift showcase), ADR-0045 (where the now-playing chip sits)

## Context

The owner says the stage's heads-up display is bad and bad at keeping
people's attention. Looking at it as a viewer on a phone, they're right:

- **Too small to read.** Labels were 15 to 19 px and values 21 to 25 px on
  the 1080 px stage, which is 5 to 9 pt on a phone. "METAS DA LIVE",
  "CURTIDAS", "A SEGUIR" and the ranking window couldn't be read at all.
- **No hierarchy.** Six panels of the same weight (dark glass with a thin
  gradient edge) sat in the top third of the screen and competed with each
  other. Nothing said where to look first.
- **Nothing pulled anyone forward.** The goals said "3.240 / 5.000", a ratio
  nobody does in their head. The countdown to the next game was a small
  chip. Nothing told a viewer what it would take to climb a ranking.
- **Viewers' names were an afterthought.** Alerts were bare lines of text
  next to the character, the same weight as everything else, when a
  viewer's own name on screen is the strongest reason to gift, follow and
  stay.
- **Cut text and collisions.** The ticker cut its lines ("Presentes pagam
  as conta…"), long calls to passers-by shrank to 30 px and then were cut,
  and the now-playing chip sat where the alerts stack.

## Decision

Rebuild every HUD element on one kit (`packages/engine/src/text/kit.ts`) and
one layout, with the protocol unchanged: the server sends the same messages.

### Principles

1. **Readable on a phone.** Nothing a viewer needs is under 22 px on the
   stage (about 8 pt); names and numbers are 26 px and up, the countdown 34.
2. **One hero at a time.** The character and its caption are the hero. Side
   panels are calm until something happens in them; the one call to action
   under the character (a challenge, a call to passers-by, the gift showcase)
   is the only thing in that spot.
3. **Every panel gives a reason to stay or act.** An open loop or a target:
   what's next on a draining ring, what's left for each goal, what takes the
   crown, how to climb the likers, what to type for a vote.
4. **Names are the stars.** Alerts are name cards with the name big.
5. **Urgency escalates.** Things move when something happens and get louder
   as a moment gets close; nothing blinks for its own sake.
6. **The board wins in a game.** Side panels fold to their essentials and
   end above the board.

### The look

- **Cards** are deep, nearly opaque surfaces with a soft glow in their color
  and a **colored tab** on top that names them ("TOP DOADORES", "METAS DA
  LIVE", "VOTE: DIGITE 1 A 3"): dark capitals on a bright pill, like a
  sports broadcast package. Color keeps its meaning (ADR-0011): gold for
  money, pink for likes, cyan for "do it now", green for the raffle.
- Sprites gained a **zoom** spring (drawn around their center) and a
  horizontal **slide**, for pops and entrances without repainting.

### The layout (1080 × 1920)

```
 y 196   Segment title (46 px)                      ┌ Goals ────────┐
 y 262   [✦ Luma é uma IA] [▮▮ now playing]         │ ♥ FALTAM 1.760│
 y 316   ┌ Up next ring ─┐                          │ ◆ FALTAM 380  │
         │ (2:31) Quiz   │                          └───────────────┘
         ├ Ranking card ─┤                          ┌ Support ticker┐
         │ 👑 duda  25 mil│       (character)        └───────────────┘
         │ ...           │                          ┌ name card ────┐
         │ Roube a coroa │                          ┌ name card ────┐
         └───────────────┘
         ┌ Dono da live ─┐
 y 900   ┌──────────── spotlight: challenge, call or showcase ─────┐
 y 1060                   caption (unchanged)
```

Both side columns are 330 px wide with a 44 px margin, clear of the
character (x 375 to 705 at rest).

### What each element does now

- **Show bar:** the segment title, bigger, and the AI badge under it (still
  drawn last but one and never hidden). The **now-playing chip** moved next
  to the badge, so it never collides with the alerts and stays put during
  games (its credit line is still on screen while a track plays).
- **Up next:** a card with a **countdown ring** that drains from the moment
  the item was set. The label says what it is ("PRÓXIMO JOGO", "A SEGUIR",
  "PÓDIO DA RODADA"). Calm in the host's color; gold under a minute; under
  ten seconds the seconds are big, the ring turns hot and pops every second;
  once due it says "COMEÇA JÁ JÁ" with a play mark.
- **Ranking card:** names at 26 to 32 px. The likers end with "Toque na
  tela pra subir"; the gifters end with "Roube a coroa" and the diamonds it
  takes (first place's count, "25,3 mil+"). The vote's tab says what to
  type. Long support lines wrap to two rows.
- **Goals:** each goal is a thick bar that fills with a spring and says
  **what's left** inside it ("FALTAM 1.760"), with the percent beside the
  label. From 80% the percent becomes a "QUASE!" pill and a light runs along
  the bar; reaching the goal turns the tab and bar gold with a pop.
- **Support ticker:** under the goals, same width; lines wrap to two rows
  instead of being cut, and each new line slides in.
- **Name cards (alerts):** the viewer's name big, what they did under it in
  the alert's color ("enviou Rose ×5", "começou a seguir", "ativou Dono da
  live!", "assumiu a coroa!"), and a mark in a solid disc. They slide in
  from the edge with a pop and stack under the ticker, as many as fit above
  the spotlight (up to three; one during a game).
- **Spotlight:** the call to passers-by gets a cyan tab that speaks to them,
  **"ACABOU DE CHEGAR?"**, and long calls wrap to two lines at 28 px or more
  instead of being cut. The challenge bar says what's left ("640 / 1.000 ·
  FALTAM 360") and its timer turns hot and pops each second in the last ten.
  The gift showcase uses the same tab and type sizes.
- **During a game** (past halfway into game layout): the ranking card keeps
  only its tab and first place (a vote keeps its leading option), the goals
  become two bars with their marks inside, the ticker drops its tab, and the
  "dono da live" and the spotlight give way to the board as before.

## Options Considered

### Option A: One kit, side columns plus a spotlight, hooks in every panel (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: every HUD element repainted, one new module for the kit |
| Cost | None at runtime beyond a few repaints a second while something moves |
| Scalability | New panels inherit the kit and the layout rules |
| Team familiarity | Same sprite and layer patterns as before |

**Pros:** readable on a phone; one visual language; every panel pulls the
viewer forward; no protocol or server change.
**Cons:** the side columns hold fewer characters per name (long names shrink,
then get cut).

### Option B: Keep the panels, raise the font sizes

**Pros:** smallest change.
**Cons:** bigger text in the same six look-alike boxes is still six boxes
competing; nothing would give a reason to stay.

### Option C: Move most panels into one rotating "info" slot

**Pros:** the least on screen at once.
**Cons:** the goals, the countdown and the rankings are the open loops that
keep people watching; hiding them most of the time loses that.

## Trade-off Analysis

The stage is a TV show more than a dashboard. Option A keeps the features
the owner asked for over many ADRs (rankings, goals, ticker, powers) on
screen, but gives them hierarchy and turns each one into a reason to act.
Its one real cost is width: 330 px columns cut very long names, which the
old 340 px ones did too.

## Consequences

- Easier: a viewer can read every panel on a phone, and knows at a glance
  what's next, how close the goals are and how to get on screen.
- Harder: the layout depends on the column budget above the game board
  (y 556); a new left-column card must have a compact form for games.
- Revisit: watch real streams for whether the "QUASE!" threshold (80%) and
  the ten-second countdown beat feel right, and whether the name cards
  should stay up longer during gift storms.

## Action Items

1. [x] `text/kit.ts`: the look, layout constants, marks, text fitting, words and numbers.
2. [x] Side panels (`text/hud.ts`) and the spotlight (`text/spotlight.ts`) on the kit, with compact forms for games.
3. [x] Sprite zoom and slide; the now-playing chip beside the badge.
4. [x] Unit tests for the new words and numbers; e2e pixel checks for the new positions and the fold in games.
5. [ ] Watch a real stream on a phone and tune the thresholds above.
