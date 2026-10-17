# ADR-0022: A speech timeline that holds up under bursts

**Status:** Proposed
**Date:** 2026-10-17
**Deciders:** Project owner
**Amends:** [ADR-0008](0008-realtime-protocol.md) (speech messages, protocol v2),
[ADR-0009](0009-stage-engine.md) (speech playback and captions),
[ADR-0012](0012-ai-and-voice-pipeline.md) (turn scheduling, deadlines, word timing)

## Context

With a busy room (fast chat, gift bursts), the host fell apart: it started
new sentences without finishing the last one, captions drifted away from
the voice, replies came late, and sometimes it went quiet. Each symptom
traced to the v1 design, which handled one line at a time:

| Symptom | Cause in v1 |
|---|---|
| Sentences cut off mid-word | On the stage, every `speak` stopped whatever was playing. The server sent the next line when the first on-air stage reported `spoken`, so with two on-air stages (OBS and the cloud broadcaster) the slower one was cut off every line. A stage that started late (fetch and decode) was cut off by the 4-second fallback. |
| Non-sequiturs ("new stuff" mid-thought) | The next turn started while the last line was still playing, but the prompt only listed lines that had *finished*, so the model didn't know what it was in the middle of saying. When the moderator blocked sentence two of a reply, sentence three still played, out of context. |
| Captions out of sync | The caption reveal ran on the engine's frame clock, whose step is clamped to 50 ms. When frames slowed down (gift particles, software GL in the broadcaster), captions fell behind the audio. Word timing was a guess from word length. |
| Slow, gappy speech | Every sentence waited for a round trip: stage reports `spoken`, server sends `speak`, stage fetches and decodes, then plays. |
| Late reactions | A viewer's message arriving during a filler monologue waited for the whole monologue. Each new turn waited for the queue to empty, then for the model. |
| Silence for minutes | The host stream, the moderator and ElevenLabs had no deadlines (the SDK's default timeout is 10 minutes, with retries). One hung call held the turn, or the line at the front of the queue. |

## Decision

Treat speech as a **timeline**: an ordered queue of sentences, grouped into
turns, mirrored between the server and every stage. Lines are only ever
added at the end or taken back before they start. Nothing cuts a line off
mid-word except the kill switch.

### Stage: a queue on the audio clock (protocol v2)

- `cue` appends a line to the stage's queue. The stage fetches and decodes
  its audio immediately and plays it right after the line before, with a
  140 ms breath on the audio clock. `speak` (cut off and play now) remains
  for previews and the landing page demo only.
- `drop` takes back queued lines that haven't started. A line already
  playing finishes.
- `stop` (kill switch) still cuts everything.
- Captions follow the playback position on the audio clock (`elapsed()` on
  the playback handle). With `words` (word start times from the voice) the
  highlighted word is the one being said; without them the estimate weighs
  word length and the pause after punctuation.
- A play that is superseded while its audio loads never starts (a token in
  `AudioEngine`), so a stale line can't play over a new one.
- `prefetch` is gone: queued cues prefetch themselves. The version is now 2;
  v1 pages reload when they see the v2 `hello` (the existing mechanism).

### Server: turns, lookahead and preemption

- **Lookahead of one.** The speech pipeline keeps the line playing plus the
  next one on the stage, so the next line is decoded before it's needed.
  The stage hub keeps a mirror of the stage queue: a `spoken` report for a
  line ends every line before it, and the fallback timer (duration + 4 s
  grace when an on-air stage is connected) runs only for the line at the
  front.
- **A turn is one thought.** Lines carry their turn. When a sentence is
  blocked, the rest of that turn is dropped (reported as "skipped after a
  blocked line"), and the director stops generating it.
- **Priorities.** Filler 10, reactions 40, segment changes and milestones
  45, opening 50, operator lines 100. A queued viewer event (chat,
  question, gift, follow, share) aborts a filler turn being written and
  takes back its lines that haven't started. The line playing finishes, so
  the host answers at the next sentence boundary.
- **Just-in-time turns.** The director starts the next turn when the speech
  still queued will run out in about the time a turn takes to reach the
  stage (a smoothed measurement, 1.2–6 s), instead of when the queue is
  empty. Replies are about fresher events, and speech doesn't pile up.
- **The prompt knows what's playing.** Lines still queued or playing go into
  the turn as "(saying now)", so the model picks up from them instead of
  repeating or contradicting them.
- **Gift bursts merge.** The same viewer sending the same gift again before
  the thank-you joins the queued gift ("5 Roses"), so a burst gets one
  thank-you instead of five.

### Deadlines everywhere

| Call | Deadline | When it passes |
|---|---|---|
| Host turn, first sentence | 12 s | Turn abandoned; counts as a failure (backoff 2 s doubling to 30 s) |
| Host turn, whole | 30 s | Turn cut off where it is |
| Moderator, per sentence | 6 s, no retries | Moderator failure: the line is dropped (or spoken if `MODERATION_FAIL_OPEN`) |
| Voice, per sentence | 12 s | That line plays in captions only |

The director races the host's generator against its abort signal, so even a
brain that ignores the signal can't hold the show. The moderator also shares
one request between identical sentences in flight.

### Voice timing

ElevenLabs is called on its `with-timestamps` endpoint: the response carries
per-character timing, turned into word start times for the stage, and the
real duration of the speech. Each sentence also sends the turn's previous
sentence as `previous_text`, so intonation carries across sentence
boundaries. Pocket TTS reports no timing; its lines use the stage's
estimate.

## Options considered

### Option A: Queue on the stage, timeline on the server (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: a protocol version, a queue on each side |
| Latency | Removes the per-sentence round trip; first audio unchanged |
| Robustness | Lines can't cut each other off; multi-stage safe |

### Option B: Keep one line at a time, tune timeouts and prefetch

Smaller change, but the round trip between sentences stays, and any
mismatch between stages still cuts lines off. It treats the symptoms.

### Option C: Stream one continuous audio track per turn

The lowest-latency option (streaming TTS), but captions, emotions and
safety are per sentence, a blocked sentence would have to be cut out of a
running stream, and the self-hosted voice doesn't stream. Worth revisiting
for first-audio latency later; the timeline here is compatible with it.

## Consequences

- Easier: a busy room sounds like one person finishing their thoughts;
  captions track the voice even when frames drop; a hung API call costs
  seconds, not minutes.
- Harder: the server and stages each hold a queue that must agree. The
  mirror self-corrects on every `spoken` report and on the fallback timer.
- Edge case: a line taken back with `drop` at the instant the stage starts
  it still plays on that stage, and the transcript doesn't list it.

## Action items

1. [x] Protocol v2: `cue`, `drop`, `words`; remove `prefetch`; document in `docs/protocol.md`.
2. [x] Stage `Speaker` queue on the audio clock; captions from playback position and word timings.
3. [x] Turn-aware speech pipeline with lookahead, priorities and per-turn atomicity.
4. [x] Director: just-in-time turns, filler preemption, generation watchdog, "(saying now)" context.
5. [x] Deadlines for the moderator and the voice; ElevenLabs timestamps and `previous_text`.
6. [x] Merge gift bursts in triage.
7. [ ] Measure first-audio latency and inter-sentence gaps in staging against the ADR-0012 budget.
