# ADR-0007: Multi-tenant channel runtime

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

v0.1 runs exactly one show per process, configured from environment
variables. The SaaS must run many channels at once, each with its own
persona, TikTok connection, memory, safety settings and stage clients. It
must also survive restarts: "fully autonomous" means a channel that was
running before a deploy is running again seconds after, with nobody clicking
anything.

The v0.1 pieces are already well factored (source → triage → director → host
brain → safety ∥ TTS → speech pipeline → stage) and tested. They need to
become per-channel instances fed by configuration from the database instead of
environment variables.

## Decision

Run channel runtimes **inside the `app` process**, managed by a
**`RuntimeManager`** that reconciles desired state to actual state.

- **`ChannelRuntime`** wraps one channel's object graph:
  - event source (TikTok or simulator);
  - `Triage`, `Director`, the host brain, `SafetyGate`, the TTS provider and `SpeechPipeline` (ported from v0.1);
  - a `StageHub` that implements `SpeechOutput` and `StageNotifier` over the channel's WebSocket topic;
  - a `StudioFeed` that publishes snapshots and events;
  - write-behind stores for viewers, samples, utterances and usage ([ADR-0005](0005-data-layer.md)).

  Its lifecycle is `starting → running → stopping → stopped`, plus `failed`.
  Every component is constructed from the channel row, so config changes apply
  by restarting the runtime ("hot apply" for safe fields like blocklist and
  segments can come later).
- **`RuntimeManager`**:
  - On boot, loads every channel with `desired_state = running` and starts
    them in batches of 5 (no thundering herd on TikTok or Claude).
  - On API start or stop: writes `desired_state`, then reconciles that channel.
  - Supervises each runtime: an uncaught error inside a runtime marks it
    `failed`, publishes the reason to the studio, and restarts it with
    exponential backoff (5 s → 5 min). Errors never escape to other runtimes
    or the process.
  - On SIGTERM: stops accepting starts, flushes every runtime's stores, and
    tells stage clients to hold the last frame. It does **not** change
    `desired_state`, so the next boot resumes them.
- **Plan enforcement** at start: concurrent running channels, remaining live
  hours this month, and feature flags (cloud broadcast, premium voice). A
  minute ticker accrues `runtime_seconds` and stops a channel gracefully,
  with a studio notice, when its owner runs out of hours.
- **Cost guardrails** per runtime: a token budget per hour derived from the
  plan; the director slows down filler turns when the budget runs low
  ([ADR-0012](0012-ai-and-voice-pipeline.md)).
- **Standby:** while TikTok reports the account offline, the runtime holds
  its connection loop but makes no AI calls (as in v0.1).

## Options Considered

### Option A: In-process runtimes with a reconciling manager (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low to medium |
| Cost | Cheapest: a runtime is mostly idle I/O, a few MB of memory |
| Scalability | Dozens to low hundreds of channels per process; bounded by event volume and network, not CPU |
| Team familiarity | Direct evolution of v0.1 |

**Pros:** no inter-process protocol; the stage hub, runtime and API share
memory, so studio snapshots are cheap; fastest to build and debug.
**Cons:** one process is a shared fate. A runaway runtime (a CPU spin) can
slow others. Mitigated by supervision and by keeping CPU-heavy work
(broadcast rendering) out of process.

### Option B: One worker per channel (Bun Workers or child processes)

| Dimension | Assessment |
|---|---|
| Complexity | Medium to high |
| Cost | More memory per channel (one JS heap each) |
| Scalability | Better isolation; still one machine |
| Team familiarity | Medium |

**Pros:** crash and CPU isolation per channel.
**Cons:** message-passing layer for stage, studio and DB access; harder
debugging; little benefit while runtimes are I/O-bound.

### Option C: A separate runtime service and a message bus (Redis or NATS)

| Dimension | Assessment |
|---|---|
| Complexity | High |
| Cost | Extra infrastructure |
| Scalability | Horizontal, across machines |
| Team familiarity | Medium |

**Pros:** the scale-out story for many servers.
**Cons:** premature for one VPS; adds sticky routing for stage sockets and
cross-node pub/sub.

## Trade-off Analysis

Channel runtimes spend almost all their time waiting on network I/O (TikTok,
Claude, TTS). Process isolation buys little until we outgrow one machine, and
it costs a protocol layer we'd have to build and debug now. Option A keeps
every component behind interfaces (`EventSource`, `SpeechOutput`,
`StageNotifier`, stores), so moving runtimes to workers (B) or another service
(C) later replaces wiring, not logic.

## Consequences

- Easier: building and testing (a runtime can be constructed in a test with fakes, as in v0.1); fast studio updates.
- Harder: process restarts interrupt every channel at once (they resume in under 10 s; stage clients hold the last frame and reconnect).
- Revisit: move to B when one process can't keep up, or C when we need more than one server. Trigger: event-loop lag p99 above 50 ms under normal load.

## Action Items

1. [ ] Port v0.1 modules into `apps/server/src/runtime/` and make every dependency injectable from a channel config.
2. [ ] Implement `ChannelRuntime` (lifecycle, supervision hooks, flush on stop).
3. [ ] Implement `RuntimeManager` (boot reconcile, batching, backoff, graceful shutdown, plan checks, hour accrual).
4. [ ] Expose event-loop lag and per-runtime health in `/readyz` and the studio.
5. [ ] Tests: start/stop, crash and restart with backoff, boot resume, shutdown flush, hour exhaustion.
