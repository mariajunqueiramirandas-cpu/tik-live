# ADR-0033: Host memory that's cheap, fast and accurate

**Status:** Proposed
**Date:** 2026-10-18
**Deciders:** Project owner
**Amends:** ADR-0025 (viewer notes), ADR-0026 (the conversation's head and how old turns fold)

## Context

The owner asked for a much better memory for the host: cheap, fast and
accurate. Before this, the host remembered four things:

- **the conversation**, word for word, until it outgrew its budget; then all
  but the newest 8 turns folded into
- **a show summary** (under 150 words) the chronicler writes every few
  minutes, together with
- **viewer notes**: up to 5 free-text notes per viewer, kept across streams;
- **the last stream's summary**, for the next opening.

That lost or garbled things viewers notice:

1. **Notes piled up and contradicted each other.** "has a cat" and later
   "has a dog" both stayed, and nothing stopped the chronicler from writing
   a note nobody said, or putting one viewer's words on another.
2. **The host's own character drifted.** It improvises its favorite food,
   its team, a backstory. Once those turns folded, or the stream ended, it
   said something else next time.
3. **Folding lost the plain facts.** With a summary, the turns that left
   kept only what 150 words had room for. Who the host had talked with and
   which questions it had asked the room were gone, so "don't ask the same
   question twice" stopped holding on a long stream.
4. **A regular could be greeted as new.** A viewer's stored record loads in
   the background when they first show up. When their first event was the
   message the next turn answered (turns start within 200 ms), the room
   described them as "first stream with us".

## Decision

Nothing new runs on the hot path, and there are no new model calls: all
extraction rides on the chronicler call the show already makes (Haiku,
low effort, at most every 4 minutes). All memory is read from an in-memory
cache and written back in the background.

### Viewer facts by topic, backed by a quote

The chronicler returns each note with a **topic** ("pet", "favorite food",
"team") and a **quote**: a few words copied from that viewer's own message,
or from a show line (a game they won). A note is kept only when the quote
is really there (`grounded`: word for word, or four in five words, ignoring
accents and punctuation), so a note can't be made up or put on someone
else. Notes are stored as `topic: fact` in the existing `notes` column. A
new note on a topic replaces the old one, so the host never reads two
answers to the same thing. Up to 8 per viewer, and the host reads the newest
4 in the viewer's `about`.

### What the host said about itself (`HostFacts`)

The chronicler also returns **host facts**: what the host said about itself,
with a quote that must be in the host's own lines. They're kept per channel
in a new `host_memory` table (up to 24, and when it's full the one mentioned
least recently goes). **The first thing the host said on a topic stands**:
saying it again just keeps it fresh. The facts go at the top of the
conversation's head as `<about_you>`, at the start of every stream and
every time old turns fold. The head only changes then, so the prompt cache
is unaffected.

### The recap survives every fold

Turns that leave the conversation always go into the recap, word for word,
whether or not a summary covers them: who the host talked with, the biggest
gifts, viewers' questions, what happened on the show, and now **the
questions the host asked the room** ("You already asked the room: …"). The
head is `<about_you>`, then the summary, then the recap.

### A turn waits for memory that's still loading

Before it drafts the room, a turn waits up to 150 ms for viewer records
still loading. A slow store costs one turn's description of a regular,
never the turn itself.

## Consequences

- Cheaper than the alternatives: no embeddings, no retrieval calls, no
  per-turn memory tokens beyond what the `about` and the head already
  carried. The chronicler's output grows by a few hundred tokens.
- Accuracy is enforced in code, not just asked of the model: unquoted facts
  are dropped, topics replace instead of piling up, and the recap doesn't
  depend on a summary.
- A note the chronicler can't back with a quote is lost, even when it was
  true (something a viewer *did*, with no message saying it). Game wins are
  covered by show lines.
- Host facts can't be edited from the dashboard yet. A creator who wants a
  fresh character has to clear `host_memory` for the channel. A studio pane
  that shows and edits them is the natural next step.
- Revisit: the 4-in-5 quote threshold, and whether viewer topics need a
  fixed vocabulary if the chronicler varies its wording ("pet" / "pets").
