# ADR-0008: Realtime protocol

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

Three kinds of client need live data:

1. **Stage clients** (OBS browser sources, the cloud broadcaster, previews)
   receive speech cues, alerts, segment changes and stats. They report when
   each cue finished playing, which paces the host. They authenticate with a
   channel's secret stage key, not a user identity.
2. **Studio clients** (the dashboard) receive runtime snapshots, the
   transcript, blocked lines, incoming live events, logs and health. They send
   commands: pause, resume, skip, say, segment, inject test events.
3. The **dashboard's embedded preview** is a stage client in `preview` role:
   it renders but never acknowledges playback.

v0.1 used untyped JSON messages over `ws`. In a SaaS, a malformed or
malicious message must not crash a runtime, old clients must keep working
across deploys, and the dashboard should feel instant.

## Decision

**Transport:** WebSockets on Bun via Hono's `upgradeWebSocket`, with Bun's
native pub/sub for fan-out:

| Endpoint | Auth | Topic |
|---|---|---|
| `GET /ws/stage/:stageKey?role=program\|preview\|broadcast` | Stage key (HMAC lookup) | `stage:<channelId>` |
| `GET /ws/studio/:channelId` | Resolved identity ([ADR-0018](0018-defer-authentication.md)) and channel ownership | `studio:<channelId>` |

**Messages** are JSON. Their types are defined once in `packages/shared` as
zod discriminated unions. Every message carries `v` (protocol version, starts
at 1) and `t` (message type). The server validates **every inbound** message
with zod and drops invalid ones with a counter; it never throws into the
runtime. Outbound types are shared with clients for compile-time safety.

| Direction | Messages |
|---|---|
| server → stage | `hello` (persona look, protocol version, server time), `speak` (cue id, text, emotion, audio URL, duration), `stop`, `alert` (gift, follow, share), `segment`, `stats`, `hold` (server restarting: keep the last frame) |
| stage → server | `ready` (role, engine version, capabilities), `spoken` (cue id), `telemetry` (fps, frame-time p95, quality level; every 10 s) |
| server → studio | `snapshot` (full state on connect), `patch` (changed snapshot fields, coalesced to at most 4 per second), `transcript`, `blocked`, `live-event`, `log`, `notice` (plan limits, failures), `ack` (command id, ok or error) |
| studio → server | `command` (id, kind: `pause`, `resume`, `skip`, `say`, `segment`, `inject`) |

**Delivery rules**

- **Snapshots and patches:** studio clients get a full snapshot on connect and
  on every reconnect, so they never need to replay history. Patches are
  coalesced at 250 ms.
- **Backpressure:** if `ws.getBufferedAmount()` passes 1 MB, the server skips
  patches for that client (the next one carries current state) and drops
  `log` messages. It never drops `speak`, `stop` or `ack`.
- **Audio** is not sent over the socket. `speak` carries
  `/api/stage/:stageKey/audio/:cueId`, an immutable MP3 served over HTTP from
  an in-memory cache (TTL 2 minutes). The stage prefetches it while the
  previous cue plays.
- **Heartbeats:** server ping every 20 s; clients reconnect with exponential
  backoff and jitter (0.5 s → 10 s). The stage engine keeps rendering idle
  animation while disconnected and shows nothing broken on screen.
- **Command acks:** every studio command has a client-generated id and gets an
  `ack`. The dashboard applies commands optimistically (for example, the pause
  button flips immediately) and reconciles on `ack` or the next `patch`.
- **Versioning:** the server speaks the newest version and the previous one.
  A stage client on an unsupported version gets `hello` with
  `reload: true`, and the page reloads itself (OBS sources pick up new deploys
  without the creator doing anything).

## Options Considered

### Option A: Typed WebSocket protocol on Bun pub/sub (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Minimal; one socket per client |
| Scalability | Bun pub/sub fans out in native code; thousands of sockets per process |
| Team familiarity | Evolution of v0.1 |

**Pros:** bidirectional (acks, telemetry, commands); one connection per view;
native fan-out; shared types.
**Cons:** we own reconnection and resync logic (kept small by snapshot-on-connect).

### Option B: Server-Sent Events plus REST for commands

| Dimension | Assessment |
|---|---|
| Complexity | Low to medium |
| Cost | Minimal |
| Scalability | Good |
| Team familiarity | High |

**Pros:** simple; automatic reconnects; proxy-friendly.
**Cons:** the stage needs to send playback acks and telemetry at high rate;
two channels per client; no binary option later.

### Option C: A realtime service (Ably, Pusher, Liveblocks)

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Per-message and per-connection fees |
| Scalability | Excellent |
| Team familiarity | Medium |

**Pros:** no socket infrastructure to run.
**Cons:** recurring cost on high-frequency traffic; external dependency on the
critical speech path; latency hop.

## Trade-off Analysis

The stage-to-server acknowledgement is on the critical path for speech pacing,
so a bidirectional, low-latency channel is required, and keeping it in-process
avoids a network hop. Snapshot-on-connect plus coalesced patches gives the
dashboard its instant feel without event-sourcing complexity.

## Consequences

- Easier: one protocol definition shared by server, engine and dashboard; safe against bad input; deploys don't break live OBS sources.
- Harder: protocol changes need version discipline (covered by contract tests in `packages/shared`).
- Revisit: binary encoding (MessagePack) only if telemetry or patch volume shows up in profiles.

## Action Items

1. [ ] Define the message unions and version constant in `packages/shared/src/protocol/`.
2. [ ] Implement `StageHub` and `StudioFeed` with validation, coalescing and backpressure.
3. [ ] Implement the client-side connection helper (backoff, jitter, resync) shared by engine and dashboard.
4. [ ] Contract tests: every message type round-trips through its schema; unknown or old versions are handled.
