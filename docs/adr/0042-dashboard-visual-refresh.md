# ADR-0042: Dashboard visual refresh

**Status:** Proposed
**Date:** 2026-10-20
**Deciders:** Project owner
**Amends:** ADR-0011 (palette values, UI typeface, the studio's stage monitor)

## Context

The owner said the dashboard looked bad and asked for it to be much better.
Screenshots at 1440 px and 390 px showed why:

- **Everything was the same purple.** `abyss`, `trench` and `shelf` were
  saturated violets close in lightness, so panels, inputs and the page
  blurred together and the meaning colors had nothing calm to stand on.
- **Numbers looked broken.** Atkinson Hyperlegible Next draws zero with a
  slash and has no plain alternate, so every count read "1Ø assistindo",
  "R$ 49,9Ø", "557/2ØØØ". A live control room is mostly numbers.
- **Small text was 12 px** in hints, the room, the status strip and lists.
- **The studio was boxy.** Every host line sat in its own bordered box, the
  status strip was a long sentence in a box, and the stage monitor, the
  one living thing on screen, was small and plain.
- **Small bugs:** host swatches shrank to dots in flex rows (character
  picker), chart and sparkline fills were flat grey blocks, a disabled
  primary button turned muddy teal.

## Decision

Keep ADR-0011's direction (dark night studio, depth is elevation, color
means something, the character is the hero) and fix how it's executed.

### Palette: a near-neutral night, so meaning colors carry

| Token | Was | Now | Role |
|---|---|---|---|
| `abyss` | `#0B0420` | `#0A0912` | Page; also inputs, which now sit *below* the page they're on |
| `trench` | `#140A33` | `#100E1B` | Sunken: sidebar, room, lists |
| `shelf` | `#1E1247` | `#181525` | Raised: panels, menus, dialogs |
| `reef` | `#2A1A5E` | `#221E33` | Hover |
| `lift` | — | `#2C2742` | Pressed, selected, meter tracks |
| `ink` | `#F4F0FF` | `#F4F2FA` | Primary text |
| `haze` | `#A397D6` | `#ADA8C6` | Secondary text |
| `mist` | `#8A80BA` | `#8F89AC` | Tertiary text (AA on every surface but `lift`, where it isn't used for text) |

`glow`, `offering` and `alarm` are unchanged; `bloom` moves from `#FF5FD2`
to `#FF6FD8` to clear AA as text on `shelf`. Raised surfaces get a 1 px top
highlight (`--edge`) instead of a heavier border. Shadows stay reserved for
things that float (menus, dialogs, toasts: `--float`).

### Type: Reddit Sans for UI and body

Reddit Sans replaces Atkinson Hyperlegible Next in the dashboard. It keeps
what the ADR-0011 choice was for (a tailed `l`, so `Il1` in usernames stays
distinct; tabular figures) and draws a plain zero. Bricolage Grotesque stays
for display. The stage keeps Atkinson, which the engine rasterizes; a face
only downloads on a page that uses it. Small text moves from 12 px to 13 px
(`--t-13`); `--t-17` is added for ledes and large buttons.

### The host's own colors: the one bold thing

Host pages set `--host-a` and `--host-b` from the character's look. They
light the stage monitor's bezel while the host is on air, the avatar's
halo, the active tab underline, the top of the page and the live row on the
home list. They're decoration only, never text, so a host's colors don't
need a contrast check. Live is still `glow`; the avatar wears a `glow`
tally ring while on air.

### Studio

- The stage monitor sits in a bezel that takes the character's light on air.
- The room drops per-line boxes: the host's lines get a `bloom` edge and
  tint with the name above, gifts a gold wash, time breaks become rules.
- The status strip becomes pills; the reply-time breakdown moves to a
  tooltip (and stays in the accessible name). On phones it scrolls sideways.
- Each tool in the controls column is separated by a hairline.

## Consequences

- Easier: hierarchy reads at a glance; numbers look right; every host page
  feels like that host's.
- Harder: two UI-ish typefaces in the project (Reddit Sans for the
  dashboard, Atkinson for the stage).
- Revisit: a light theme is still out of scope (ADR-0011).

## Action Items

1. [x] New palette and tokens (`--lift`, `--edge`, `--float`, `--host-a/b`, `--t-13`, `--t-17`).
2. [x] Reddit Sans self-hosted with a metric-matched fallback.
3. [x] Primitives (buttons, inputs, segmented, chips, slider, banners, overlays) on the new tokens.
4. [x] Shell, home, host header, studio, new host, billing, charts.
5. [x] Screenshots at 1440 px and 390 px reviewed before and after.
