# ADR-0011: Design direction

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

The owner wants an "incredible" frontend built with Anthropic's
frontend-design guidance, which asks for a distinct identity grounded in the
subject rather than a templated SaaS look. This ADR is the design plan that
guidance calls for: subject, audience, tokens, layout concepts and
principles, reviewed against generic defaults before any code is written.

**Subject:** AI host characters that run TikTok LIVE streams on their own.
**Audience:** TikTok creators and small creator agencies. They are
mobile-native and often run streams late at night, sometimes overnight.
**Primary jobs:**

- **Landing page:** make it obvious in seconds that the host is alive and
  reacting, then get a sign-up.
- **Dashboard:** design a character people want to watch, and run a live
  show with confidence: see what's happening, step in instantly, trust that
  nothing embarrassing goes out.

**Working product name:** **Lantern**: a light that keeps watch in the dark,
like the glowing host on stage. This is a proposal (see the open questions in
the [plan](../architecture/plan.md#open-questions)); the name lives in one
constant.

## Decision

### Color: the deep-water palette, where color carries meaning

The stage already lives in a bioluminescent deep-sea world. The dashboard
extends it, and **elevation is depth**: surfaces get lighter and more violet as
they rise toward the "surface", instead of using drop shadows.

| Token | Hex | Role |
|---|---|---|
| `abyss` | `#0B0420` | Page background (deepest water) |
| `trench` | `#140A33` | Sunken surfaces: inputs, wells, the transcript track |
| `shelf` | `#1E1247` | Raised surfaces: panels, menus, dialogs |
| `ink` | `#F4F0FF` | Primary text |
| `haze` | `#A397D6` | Secondary text, hairlines at reduced opacity |
| `glow` | `#7CF5FF` | Live state, primary actions, focus |
| `bloom` | `#FF5FD2` | The character and brand moments only, used sparingly |
| `offering` | `#FFD15C` | Money only: gifts, diamonds, revenue, plan prices |
| `alarm` | `#FF6B6B` | Stop and danger: the kill switch, errors |

Color is semantic. Cyan means "live or act", gold means "money", magenta
means "the character", red means "stop". A color never appears just for
decoration. Text pairs meet WCAG AA (`ink` and `haze` on `abyss`, `trench`
and `shelf`).

v1 is dark-only. A control room for night streams is the main use, and it
matches the stage the creator is broadcasting.

### Type

| Face | Role | Why this one |
|---|---|---|
| **Bricolage Grotesque** (variable, optical size) | Display: headlines, the character's name, big live numbers | Quirky, warm, characterful: it reads like a personality, not a bank. Optical sizing keeps it crisp from 24 px to 96 px. Already used on the stage, so the brand and the show match. |
| **Atkinson Hyperlegible Next** | UI and body: labels, chat, transcripts, forms | Designed for legibility with distinct letterforms. When reading chat fast, `Il1` and `O0` in usernames must never be confused. Tabular figures for stats. |

- Scale: ratio 1.25 from a 15 px UI base (dense tool) and a 17 px landing body.
  Steps: 12, 15, 19, 23, 29, 37, 46, 57, 72, then 88 for the landing headline only.
- Sentence case everywhere. No all-caps labels, no tracked-out eyebrows above
  headings, no monospace for data (Atkinson's tabular numerals do that job).
- Line length under 72 characters for running text.

### Layout concepts

**Landing**: the hero *is* the product. A live engine running in demo mode,
reacting to a scripted chat that rises along its edge like TikTok comments.

```
┌──────────────────────────────────────────────────────────────┐
│ Lantern                                   Sign in  [Start]   │
│                                                              │
│  A host that never        ┌──────────┐                       │
│  logs off.                │  (Blip)  │  maria.codes: hiii    │
│                           │   ◕‿◕    │  joe: are you real?   │
│  Lantern runs your TikTok │ "I'm an  │  ✦ luna sent a Rose   │
│  LIVE on its own: reads   │  orb, Joe│                       │
│  chat, thanks gifts by    │  and..." │                       │
│  name, keeps 3 a.m. alive.└──────────┘                       │
│  [Create your host]                                          │
├──────────────────────────────────────────────────────────────┤
│  How a night goes   9 pm ─── 11 pm ─── 3 am ─── 8 am recap   │  (a real sequence, so time markers are earned)
├──────────────────────────────────────────────────────────────┤
│  Safe by design: filtered chat · moderated lines · kill switch│
│  Pricing                                                     │
└──────────────────────────────────────────────────────────────┘
```

**Studio** (the control room): three zones. The stage monitor is the one bold
element; everything else is quiet.

```
┌ Channels ┐┌──────────────────────────────────────────────────────────┐
│ ● Blip   ││ Blip   ● Live 1:42:10      312 watching  ✦ 4,210         │
│ ○ Nova   │├───────────────┬───────────────────────────┬──────────────┤
│          ││               │ The room                  │ [ Pause host ]│
│          ││   ┌───────┐   │ joe: are you real?        │              │
│          ││   │ stage │   │   Blip: Real-ish! I'm an  │ Say something │
│          ││   │ 9:16  │   │   orb who lives here.     │ [__________]  │
│          ││   │engine │   │ ✦ maria sent 5 Roses      │              │
│          ││   └───────┘   │   Blip: Maria! Five roses! │ Segment       │
│          ││ Now saying…   │ ⊘ blocked: link removed   │ ◉ Hangout     │
│          ││               │                           │ Up next (3)   │
└──────────┘└───────────────┴───────────────────────────┴──────────────┘
```

"The room" interleaves what viewers did with what the host said, in time
order like a chat. The creator reads cause and effect at a glance.

**Character editor:** the form on the left autosaves; the engine preview on
the right reacts to every change (colors morph live, and "Try a line" makes
the character speak a sample in the chosen emotion).

```
┌───────────────────────────────────┬──────────────────────┐
│ Identity   Voice   Look   Show   Rules │   ┌──────────┐     │
│                                   │   │ preview  │     │
│ Name        [Blip              ]  │   │  engine  │     │
│ Who is it?  [a tiny glowing orb…] │   └──────────┘     │
│ How it talks[short, punchy…    ]  │  [Try a line ▾]    │
│                          Saved ✓  │                    │
└───────────────────────────────────┴──────────────────────┘
```

**Channels home:** a list of channels as rows (state, viewers sparkline,
last stream, quick go-live), not a grid of identical cards.

### Principles

1. **The character is the hero.** Each screen has one living element, the
   engine canvas. Chrome stays quiet around it.
2. **Depth is elevation.** Lighter means higher. No decorative shadows or
   gradients on chrome.
3. **Color means something** (see the palette above).
4. **Motion answers events.** Gifts arriving, going live, saving, a
   command acknowledged. One orchestrated moment on the landing page; no
   entrance animations on every section; everything respects reduced motion.
5. **Speak like the creator.** "Go live", "Pause the host", "Your host said",
   "Blocked before it was said". Never internal terms like "runtime",
   "triage" or "cue".
6. **Calm under pressure.** The kill switch is always visible, big, and
   instant. Errors say what happened and what to do.

## Options Considered

### Option A: Deep-water identity, extended from the stage (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: a custom token system |
| Cost | Design and CSS time |
| Scalability | Tokens-first; new screens inherit the rules |
| Team familiarity | n/a |

**Pros:** the product, stage and brand feel like one world; color carries
meaning; distinctive.
**Cons:** dark-only for v1.

### Option B: Light, neutral SaaS look (white surfaces, one brand color)

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Low |
| Scalability | High |
| Team familiarity | High |

**Pros:** familiar.
**Cons:** indistinguishable from countless tools; clashes with a night-time
control room and with the stage being previewed.

### Option C: Loud "creator-economy" neon gradients

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Low |
| Scalability | Medium |
| Team familiarity | Medium |

**Pros:** energetic.
**Cons:** competes with the character for attention; tiring during long sessions.

## Trade-off Analysis: review against generic defaults

Following the design guidance, the plan was checked against the looks that
generated designs fall into. Where a first instinct matched one, it was revised:

| Default it risked | Revision |
|---|---|
| Near-black background with one bright accent | Violet-tinted depth layers and a four-hue semantic palette; the dominant visual is the living character, not accent-colored chrome |
| SaaS card kit (identical rounded cards) | Channels are rows; the studio is panes and a timeline; radius varies by role (controls 8 px, panels 14 px, stage 20 px) |
| Hero with a big number, small label and gradient | The hero is the running engine |
| Monospace for small data labels | Atkinson Hyperlegible tabular numerals |
| All-caps eyebrows and meta joined with middle dots | Banned in the copy rules |
| Numbered markers as decoration | Used only where the content is a real sequence (the "how a night goes" timeline) |

## Consequences

- Easier: every new screen has clear rules for color, type and motion.
- Harder: the character preview has to look great at small sizes in the dashboard (covered by the engine's resolution independence).
- Revisit: a light theme if creators ask for daytime use.

## Action Items

1. [ ] Implement `tokens.css` (color, type scale, spacing on a 4 px grid, radii, motion durations and easing).
2. [ ] Self-host and preload both fonts with metric-matched fallbacks.
3. [ ] Build primitives on the tokens and review them on one page before building screens.
4. [ ] Take screenshots of each screen at 390 px, 1280 px and 1600 px and critique them against the principles before calling a screen done.
