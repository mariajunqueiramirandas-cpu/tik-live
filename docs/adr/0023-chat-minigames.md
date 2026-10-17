# ADR-0023: Chat minigames, game scenes and stage reactions

**Status:** Proposed
**Date:** 2026-10-17
**Deciders:** Project owner

## Context

Hosts filled time with segment prompts ("ask a would-you-rather question"),
which turned into the model asking questions in prose and then losing track
of the answers. Viewers had nothing to *do* on stream besides chat, and the
stage looked the same whatever was happening. Creators asked for games
viewers can play from chat, a distinct look for each game, and much bigger
reactions to gifts and big moments.

## Decision

**Games are run by code, voiced by the host.** A `GameMaster` per channel
(`apps/server/src/runtime/games`) owns the rules: rounds, timers, which chat
messages are answers, scoring and the leaderboard. The host model never
judges answers and never sees an open round's answer; it gets a cue at each
moment (round open, reveal, final scores) and says it in its own voice. A
plain offline line comes with every cue for the scripted host.

- Eight kinds (`GAME_KINDS`): trivia, poll ("this or that"), word scramble,
  guess the number, true or false, quick math, riddles, fastest finger.
  Number and math rounds are generated in code; the others are written by
  Claude with structured output, validated round by round with zod, checked
  by the same safety gate as speech (they're shown on screen and read out),
  and topped up from a small built-in bank in English and Portuguese when
  writing fails, is slow (20 s) or a round is blocked.
- Chat that reads as an answer during an open round (a letter, T/F, a number,
  a word close to the target) is consumed by the game and not queued for the
  host; everything else stays ordinary chat. Answers are read forgivingly
  (accents, articles, "letra b").
- Games start from a segment (`segment.game`, starts a few seconds into the
  segment, again after a 40 s break while time remains, and holds the
  segment change until it ends) or from the studio (`game_start`).
- Game turns have priority 45: above gifts' barge-in (35), below a reaction
  already under way (50).

**Each game has its own stage scene** (`game` message, `gameSceneSchema`):
the server sends the full scene on every change, throttled to four a second,
with times relative to receipt. The stage owns the look.

**Reactions are a vocabulary, not free text.** `EFFECTS` (confetti, hearts,
fireworks, spin, shake, …) can be cued by the host with tags in its lines
(`[confetti]`, at most two per line), sent on their own (`fx`, for wins and
milestones), or played by the stage itself for gifts (tiers by diamonds),
follows, shares and likes. `EMOTIONS` grew from 9 to 14. Short synthesized
sounds (`sfx`) mark gifts and game moments; creators can turn them off.

## Options considered

- **Let the model run games in prose** (the old segment prompts): no state, so
  no scoring, no timers, and the model can leak or misjudge answers.
- **Model-judged answers:** flexible for open questions, but slow, costly per
  message and gameable by prompt injection. Rejected; riddles accept a list of
  answers instead.
- **Pre-rendered scene videos:** heavy, can't show live tallies. Rejected.

## Consequences

- Easier: adding a game is a content type, an answer reader, a scene and a
  bank entry; games are fully testable with a fake clock.
- Harder: the stage has many more scenes to keep legible on a phone, and the
  engine stays within its bundle budget.
- Revisit: per-viewer points across streams (season leaderboards); gifts as
  power-ups in games (careful: never "gift to win").

## Action Items

1. [x] `GameMaster`, answer readers, offline bank, Claude writer with moderation.
2. [x] Director: answers bypass triage, game cues, segment games, effects and sounds.
3. [x] Protocol: `game`, `fx`, `sfx` messages; `speak.fx`; studio `game_start` / `game_stop`.
4. [x] Studio games pane; segment minigame settings.
5. [ ] Watch a real stream: answer-reading false positives (chat swallowed as answers).
