# ADR-0026: A turn engine over one cached conversation, on Claude Haiku 5.5

**Status:** Proposed
**Date:** 2026-10-17
**Deciders:** Project owner
**Amends:** ADR-0012 (models, cost model, budgets), ADR-0022 (what the director schedules), ADR-0025 (what the host knows each turn)

## Context

ADR-0025 gave every turn the last ~28 moments of the room, but each turn was
still a stateless request rebuilt from scratch. On a real stream that still
went wrong in ways the owner described as "dumb" and "going over things in
the wrong order":

1. **The history lied about order.** Viewer messages were logged when they
   arrived and the host's lines when they *finished playing*, so a reply
   generated before a message often showed up after it. The model saw
   itself ignoring people, or answering before being asked.
2. **Priority order leaked into conversation order.** Triage sorts by
   priority, so a newer question was answered first and an older one came
   back a turn later, after the conversation had moved on.
3. **Game moments overwrote each other.** The game master held one cue. A
   reveal that waited behind a reaction was replaced by the next round's
   question; the host read question 2 without ever announcing answer 1, and
   a game could end before its results were announced.
4. **Busy chat starved the run of show.** Reactions always outranked
   segment changes and milestones, so a busy stream stayed in one segment
   for the rest of the night.
5. **The host didn't know what didn't air.** Lines cut by a gift, blocked by
   the moderator or skipped by the owner simply vanished; the model believed
   it had said them.
6. **Nothing was cached but the system prompt.** Every turn paid full price
   for 1–2k tokens of history, so the window had to stay short, and the
   relative "N min ago" timestamps changed every turn anyway.

The owner also asked to build the host for **Claude Haiku 5.5**: the
fastest and cheapest current model (US$0.10 / US$0.50 per million input /
output tokens, cache reads US$0.01), with a 512-token minimum for caching,
mid-conversation system messages, adaptive thinking driven by `effort`,
no sampling parameters, no prefill, and no server-side refusal fallback.

## Decision

### One append-only conversation per stream (`Conversation`)

The show is a single Messages API conversation that only ever grows:

```
system   persona, rules, safety (cached)          tools: play_music (cached)
user     <last_stream>…</last_stream> <room>…</room>        ← turn 1
system   the director's brief for turn 1
assistant what the host said in turn 1
user     <room>…</room>                                      ← turn 2
system   brief 2
assistant reply 2
…
user     <room>…</room>   [cache breakpoint]                 ← this turn
system   brief for this turn
```

- **Room** (user turn): everything that happened since the host's last
  turn, oldest first, each viewer item with an id (`e12`): chat that passed
  triage, gifts (a combo is one line), follows, shares, returning viewers,
  show moments (game rounds, segments, music), and `<unsaid>` notes for the
  host's own lines that never aired (cut, blocked, skipped, or dropped as a
  repeat). What a viewer wrote, and their name, appear only here, escaped.
  What the host remembers about a viewer (`about="…"`) is shown the first
  time they appear and again only when it changes. On a busy stretch a room
  shows what the turn answers plus the newest chat, and counts the rest as
  scrolled by.
- **Brief** (system message): the facts and the task, from trusted data
  only: local time, audience, segment and time left, game state, music,
  whether the last line is still playing, and what to do in order ("thank
  e3 and e4 together, then answer e5, then e8"). It never quotes a viewer.
  Mid-conversation system messages are the operator's channel, so viewer
  text can't pose as the director. Models without them (any model not on
  the list in `host.ts`, or one that answers 400) get the brief as a
  `<director>` block at the end of the user turn instead.
- **Reply** (assistant turn): the sentences the host wrote, one per line,
  emotion tags when they change and effect tags after the words. Rendered
  once from what was queued, never edited later; what happened to a line
  afterwards comes back as an `<unsaid>` note in a later room.

Rendering happens once, when a turn starts. Old turns are never rebuilt, so
each request repeats the previous one byte for byte up to the new room. Two
cache breakpoints: the system prompt (tools and system) and the newest room.
Each request reads the whole conversation from the prompt cache and writes
only the last brief, reply and the new room.

No thinking blocks or tool calls are replayed: assistant turns are plain
text and a composed piece of music comes back as a show note. That keeps
the history append-only and clear of preserved thinking's history-editing
check.

### Folding (compaction) and the show summary

The chronicler (ADR-0025) now reads committed turns. It runs every ~4
minutes with 6 or more new turns (for viewer notes and the summary), and at
once when the conversation passes **16k tokens**; after a failure it waits
30 s before trying again. When it returns, turns it
covered leave the conversation, except the newest 8, and its summary
becomes the head (`<earlier>`). That rewrites the cache once per fold; at
~600 tokens a turn that's every ~20 busy turns. Without a chronicler, or if
it keeps failing, old turns are dropped past 32k tokens.

*Amended 2026-10-18.* A live turn failed with "The request body is not valid
JSON: unexpected end of hex escape at line 1 column 39960". The body wasn't
cut: the API's JSON parser
refuses a `\uD83D`-style escape (the first half of an emoji) that isn't
followed by its second half, and `JSON.stringify` writes exactly that when a
string was sliced through an emoji. Viewer names were clipped to 30 UTF-16
units (`displayName`), so a nickname full of emoji put half of one into a
room. A failed turn doesn't commit, so the next one sent the same room again,
and viewer memory stored clipped lines the same way, so the request would
keep failing. So:

- **Text is clipped by character, never through one** (`clip` in
  `@tik-live/shared`), and every Claude API request goes through
  `wellFormedDeep`, which turns any unpaired surrogate left anywhere into
  U+FFFD.
- **Every live event is sanitized** on the way in (`sources/sanitize.ts`),
  whatever its source: invisible and bidi characters, tag-character text,
  zalgo, floods, control characters and line breaks are removed, text is
  NFKC-folded, numbers are clamped. Display names are also read through the
  fonts people use to stand out (small caps, negative circled and squared
  letters, Cyrillic look-alikes in a Latin word, overlays, decorative frames,
  spaced-out letters).
- **Escalating reset.** If the API still refuses a request body (a 400 naming
  it, or a 413), the next attempt keeps half as many turns word for word,
  down to the summary and recap only, so whatever in the history it can't
  take leaves; a successful turn resets this.
- **Recap instead of forgetting.** Turns that leave without a summary to fold
  into go into a recap in the head (`<earlier turns="N">`): who talked (most
  recent first), the biggest gifts, the last questions, what happened on the
  show, and the host's last line. Recaps merge across drops and stay capped,
  so the host keeps the thread of the show without an extra model call.
- **Request size backstop.** Before sending, the turn engine adds up the
  conversation's UTF-8 bytes, this turn's room and brief, and the host's
  fixed overhead (`requestOverheadBytes`: system prompt and tools). Over
  140 KB (above where the hard limit normally keeps it) it compacts first and
  rebuilds the brief so it only points at turns still shown.
- The fold point moved up a little (14k to 16k tokens, 28k to 32k, 6 to 8
  turns kept), so the host remembers more of the show.

The summary is stored on the stream session (`stream_session.summary`). The
next stream opens with it as `<last_stream>`, so the host can say "last time
Ana won the trivia" (ADR-0025's revisit item).

### The turn engine (`TurnEngine`)

Owns the conversation and runs one turn at a time: draft the room, build
the brief, stream the reply into speech, commit. It also:

- **keeps the conversation honest:** lines the director cuts for a gift
  (`speech.drop`), the moderator blocks, or the owner skips come back as
  `<unsaid>` notes, and stop counting as said;
- **guards against repeats:** a line the host said in the last 10 minutes
  (same words, or 90% the same with 6+ words) is dropped before it reaches
  the voice, and the host is told; catchphrases and game turns are exempt;
- **shows each room once:** a turn that ends in silence (`[pass]`, or only
  lines it had said already) is committed as `[pass]`, because the host read
  that room; left uncommitted, the next turn showed the same messages again
  as new and the host answered them late;
- **never speaks an id:** `e12` is stripped from speech;
- **meters cut-off replies:** input usage is read from the stream's
  `message_start` event, and output (which the API reports only when a
  message ends) is estimated from the characters streamed, so a reply cut
  for rambling or barge-in still counts toward budgets;
- **only points at what the model can read:** a brief or an owed-question
  note names an id only if it's in a room still in the conversation, and
  messages that scrolled by on a busy stretch leave the queue with the turn
  that hid them.

### The director's order of business

1. the opening, once per stream; whoever woke the show up is greeted there
   rather than answered again right after it;
2. game moments, **queued in order** (a round, its answer, the next round,
   the results); a round that ends before the host read it skips straight
   to the answer, and the game waits for the host to announce an answer
   before the next round or the results;
3. what the owner asked for in the studio;
4. a segment change that's 30 s overdue *because chat kept the host
   talking* (not because the room was empty);
5. reactions: gifts, follows, shares and returning viewers first, then up
   to three messages, **oldest first**. Messages older than the newest one
   answered are passed over (they're still in the room the host saw);
   questions among them come back in the next quiet moment ("you didn't get
   to e7 earlier") if they were sent under 90 s ago, unless a reply the host wrote after seeing it already
   named whoever asked: the host sees the questions it moved past and often
   answers them anyway, and asking again made it answer twice. A pending
   like milestone rides along;
6. a like milestone on its own;
7. the segment change, on time, in a quiet moment;
8. filler: the game's, an owed question, or the next of six rotating ideas
   (a fresh question, a hot take, a callback to something a viewer said, a
   tiny story, welcoming newcomers, a one-word challenge).

Barge-in, priorities and pacing are unchanged from ADR-0022.

### Claude Haiku 5.5 everywhere

Every plan's host and moderator default to `claude-haiku-5-5` (the
chronicler and game writer use the same models). Requests send no
`temperature`, no prefill and no `fallbacks` (Haiku 5.5 has no server-side
fallback); refusals are logged and the turn ends. Effort stays `low`
(`HOST_EFFORT`), pinned per host, since changing it invalidates the cache.
The moderator's policy gained calibration examples, which also lifts it
over the 512-token caching minimum. `HOST_MODEL` / `MODERATION_MODEL`
still move every host to another model; the layout adapts.

### Cost model (Haiku 5.5, a busy hour: ~450 turns, ~1,100 moderated sentences)

| Call | Per unit | Per hour |
|---|---|---|
| Host turn: ~11k tokens read from cache, ~450 written, ~150 fresh, ~150 out | ≈ US$0.00026 | ≈ US$0.12 |
| Folds: ~18 cache rewrites of ~6k tokens | | ≈ US$0.01 |
| Chronicler: ~15 calls | ≈ US$0.0006 | ≈ US$0.01 |
| Moderation: ~700 cached + ~130 fresh in, ~60 out | ≈ US$0.00005 | ≈ US$0.06 |
| **Total** | | **≈ US$0.20** |

The old stateless prompt on Haiku would have cost about the same for a
fraction of the context (1–2k uncached history tokens a turn). Budgets
count fresh input, cache writes and output, about 0.7M tokens in that hour,
so hourly token budgets move to 1.5M / 2.5M / 4M (Free / Creator / Pro);
daily spend caps are unchanged. The studio's health panel shows how much of
recent turns' input came from the cache ("Show memory").

## Options Considered

### Option A: Append-only conversation with a director's brief, Haiku 5.5 (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: a conversation, a turn engine, a cue queue |
| Cost | Lowest: almost all input read from cache at US$0.01 per million |
| Scalability | Unchanged; conversation size is bounded per host |
| Team familiarity | Builds on ADR-0022 and ADR-0025 |

**Pros:** the model sees the real order of events and its own lines; whole
stretches of the show in context for a fraction of the cost; operator
instructions on the operator channel.
**Cons:** a fold rewrites the cache; a summary loses detail.

### Option B: Keep stateless turns, fix ordering in the rendered history

**Pros:** fewer moving parts.
**Cons:** still pays full price for history every turn, so the window stays
short; the relative timestamps and per-turn viewer descriptions keep the
prompt from ever caching.

### Option C: Server-side compaction (`compact-2026-01-12`)

**Pros:** no folding code.
**Cons:** beta; triggers far later than we want (we keep ~15k tokens, not
150k); we'd lose the viewer notes and the stored summary the chronicler
produces anyway.

## Consequences

- Easier: continuity across a whole stream and into the next; reasoning
  about order (the conversation is the order); cost per busy hour around
  US$0.20.
- Harder: anything that changes a rendered room or reply breaks the cache
  (tests check byte stability); the director's brief and the system prompt
  are now a contract the model learns from.
- Revisit: measure `cache_read_input_tokens` and first-audio latency on a
  real busy stream; tune the 16k fold point and the 8 kept turns; consider
  per-message effort (beta) for game and opening turns.

## Action Items

1. [x] `Conversation`: rooms, briefs and replies rendered once; draft/commit; folding; reset per stream.
2. [x] `TurnEngine`: turns, `<unsaid>` notes, repeat guard, id stripping, metering from stream events.
3. [x] `ClaudeHost`: conversation messages with two cache breakpoints, system-message briefs with an inline fallback, cache stats.
4. [x] Director: the order of business above, owed questions, rotating filler ideas, milestone folding, overdue segments.
5. [x] Game master: an ordered cue queue; the game waits for the host's announcements.
6. [x] Haiku 5.5 defaults per plan, new token budgets, moderator examples; `stream_session.summary` and the `<last_stream>` opening.
7. [ ] Check cache hit rate and latency in the studio on a real stream.
