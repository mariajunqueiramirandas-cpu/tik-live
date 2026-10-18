# ADR-0022: Host turn-taking and speech pacing

**Status:** Proposed
**Date:** 2026-10-17
**Deciders:** Project owner

## Context

With fast chat and gift bursts the host fell apart: it started new lines
before finishing the current sentence, captions and the mouth drifted out of
sync with the audio, and reactions lagged further and further behind. The TTS
engines were not the cause. Tracing a burst through the pipeline found these
problems in how lines and turns were scheduled:

1. **Stages cut lines short.** A `speak` stopped whatever the stage was
   playing. The server sent the next line once the *first* on-air stage said
   `spoken`, or when a timer ran out. That timer started when the line was
   sent, before the stage had fetched and decoded the audio. With OBS and the
   cloud broadcaster both connected, the faster stage set the pace and the
   slower one, which is the one TikTok viewers see, had its sentences cut off.
   With only a studio preview open, every line was cut by the next one a
   moment before it ended.
2. **Two clips could play at once.** If a `speak` arrived while the previous
   line's clip was still loading, the stage's `AudioEngine` could start both.
   The orphaned clip kept playing while the mouth and caption followed the
   other line. This was the broken "word sync".
3. **Turns couldn't give way.** A three-sentence filler kept going while a gift
   arrived. Its thank-you waited behind the filler and anything queued after it.
4. **The model didn't know what it was about to say.** The next turn is
   generated while the last one is still playing. The prompt listed only lines
   already spoken, not lines still queued, so new replies repeated or
   contradicted them.
5. **Bursts weren't batched.** A ten-rose combo from one viewer became ten
   queue items. Replies were just as long during a burst as in a quiet room.
   Dropped lines kept their TTS requests running, and every like sent a stats
   message to every stage.

## Decision

The **sentence is the unit of speech**. Once a sentence starts on a stage it
plays to the end. The host changes course only between sentences, and only
the kill switch (pause, skip, stop) cuts a sentence.

### Stage (engine)

- `Speaker` keeps a queue of lines. A `speak` that arrives while a line is
  playing waits behind it. `stop` clears the queue. If more than three lines
  are waiting, the oldest waiting line is skipped and reported as `spoken`, so
  a stalled stage can't hold up the show.
- The caption and expression switch when a line *starts*, not when it
  arrives.
- `AudioEngine` gives each play a token. A clip that finishes loading after a
  newer play or a stop is never started. A line's `stop()` only stops that
  line.
- New stage → server message `started { id, durationMs }`, with the decoded
  audio's real length ([protocol](../protocol.md#started)).

### Server pacing (`StageHub`)

- A line is done when **every** on-air stage that received it has reported
  `spoken` or disconnected. The show never runs ahead of the slowest stage on
  air.
- Deadline: the estimated duration plus 4 s until a stage starts the line.
  After `started`, it becomes the real duration plus 1.5 s.
- Stats are coalesced to at most four messages a second.

### Speech pipeline

- `drop(match)` removes lines that are still queued (never the one on stage)
  and aborts their TTS requests.
- `upcoming()` returns the line on stage plus the queued lines. The next turn's
  prompt gets these as recent lines, because the reply will play after them.
- Operator lines (`say`) go right after the current sentence, ahead of the
  host's queued lines, in the order typed.
- When a line starts, the next line's audio is prefetched if it's ready.

### Director (turn scheduler)

- One turn is generated at a time. The next one starts when the previous
  turn's last sentence is on stage, so events that arrive in the meantime are
  batched into it.
- Each turn kind has a priority: filler 10, segment change 20, milestone 30,
  opening 40, reaction 50. Each queued event has an urgency: gift 35,
  chat or question 15, others 0. When an event outranks the turn in progress,
  the director stops generating that turn and drops its queued lines,
  including the next one if it's still waiting for its audio. The
  sentence on stage finishes, and the reaction starts on the next tick with
  no gap. A reaction is never cut short by another event.
- A reaction covers the top four events plus up to eight in total, with other
  gifts and thank-yous folded in. When more is waiting, the turn is marked
  `brief`: the prompt asks for one or two sentences that thank people
  together, and the host stops after two sentences.
- Triage merges gifts from the same viewer with the same gift name into one
  item, adding up the counts and diamonds. A viewer who shares again within
  five minutes isn't thanked again.
- A reaction to chat gets about one sentence per message (plus one for the
  thank-yous and one for flavor, within the persona's limit), answer first,
  and no question back to the room while people are waiting. The host stops
  one sentence past that.
- Questions are never just lost. A question (or a message to the host by
  name) stays in the queue for a minute instead of 25 s; one the host moved
  past, or that expired while it was busy with a game or a segment change,
  comes back at the next free moment as its own short reaction, saying who
  asked.
- After the host asks the room something, dead air waits the stream delay
  (`STREAM_DELAY_MS`) longer: replies can't arrive before viewers have
  heard the question.

## Options Considered

### Option A: Sentence-boundary scheduling with stage-side queues (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: changes in five modules, one new protocol message |
| Cost | Lower: dropped lines stop TTS, briefer replies under load |
| Scalability | Unchanged |
| Team familiarity | Builds on the existing pipeline |

**Pros:** no cut sentences on any stage; urgent events get through quickly; no
new infrastructure.
**Cons:** a slow on-air stage slows the show for every stage, which is the
right trade-off when that stage is what goes to air.

### Option B: Interrupt mid-sentence for urgent events

**Pros:** the fastest reaction to gifts.
**Cons:** cut-off speech is exactly what we're fixing; it sounds broken on
stream.

### Option C: Stream one continuous audio track per turn (streaming TTS)

**Pros:** gapless prosody across sentences, and word timings from the
provider.
**Cons:** you can't drop part of a turn or put an operator line in the middle
of one; it needs provider support Pocket TTS doesn't have yet. It's still
worth doing later, on top of A.

## Trade-off Analysis

A host that finishes its sentence and then turns to a gift sounds natural. One
that stops mid-word does not. Doing all interruptions between sentences keeps
reactions within about one sentence of the event and never sounds broken.
Pacing by every on-air stage costs a little speed when stages differ, but
it keeps what goes to air in sync.

## Consequences

- Easier: reasoning about what's on stage (one line at a time, everywhere);
  adding new kinds of turns, which only need a priority.
- Harder: stages and server both have queues, so tests cover both.
- Revisit: real word timings (provider alignment or forced alignment) for
  captions; streaming TTS (option C) once a provider supports it.

## Action Items

1. [x] Stage `Speaker` queue, `started` message, `AudioEngine` play tokens.
2. [x] `StageHub` pacing by every on-air stage, re-armed on `started`; stats coalescing.
3. [x] `SpeechPipeline.drop` / `upcoming` / operator lines first; TTS aborted for dropped lines.
4. [x] Director priorities, barge-in between sentences, batching and brief turns; gift merging in triage.
5. [ ] Measure first-audio latency under a simulated burst in staging (studio health panel, p50/p95).
