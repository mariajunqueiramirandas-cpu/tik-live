# Realtime protocol

Two WebSocket endpoints carry everything live ([ADR-0008](adr/0008-realtime-protocol.md)):

| Endpoint | Who connects | Credential |
|---|---|---|
| `/ws/stage/<stageKey>?role=program\|preview\|broadcast` | Stage pages: OBS or TikTok LIVE Studio (`program`), the dashboard's monitor (`preview`), the cloud broadcaster (`broadcast`) | The stage key in the URL |
| `/ws/studio/<channelId>` | The dashboard's studio page for that host | The signed-in user (same cookie as the API); must own the channel |

The schemas live in `packages/shared/src/protocol.ts`. Messages the server
receives are validated with zod; anything that doesn't parse is dropped
without closing the connection. Messages over 16 KB are dropped. A contract
test (`packages/shared/test/protocol-doc.test.ts`) fails when a message type
is added to the schemas without a section here.

## Envelope

Every message is a JSON object with:

- `v`: the protocol version, currently **2**;
- `t`: the message type.

Clients send the version they speak. When the server's `hello` carries a
higher `v` than the client knows, or `reload: true`, the stage reloads its
page (at most once a minute, so a bad deploy can't put OBS in a reload loop).

## Stage

### Connection lifecycle

1. The stage opens the socket and sends [`ready`](#ready).
2. The server sends [`hello`](#hello), then the current [`segment`](#segment)
   and [`stats`](#stats) if a show is running.
3. Speech, alerts and stats flow until the socket closes.
4. On close the stage keeps its idle animation on screen and reconnects with
   exponential backoff: 0.5 s doubling to 10 s, each delay jittered to
   50–100%. After a [`hold`](#hold) it retries within about a second.

Close codes with a meaning:

| Code | Meaning | Stage behavior |
|---|---|---|
| `4001` | The stage link was replaced in the dashboard | Stops reconnecting, shows "This stage link was replaced" |
| `4004` | The host was deleted | Stops reconnecting |
| anything else | Network loss, server restart | Reconnects |

Only `program` and `broadcast` stages are "on air": their `spoken` messages
pace the host and their telemetry shows in the studio. Previews never pace
the show. When no on-air stage is connected, the server paces speech by
each line's estimated duration so the show keeps a realistic rhythm.

Speech is a queue on each stage ([ADR-0022](adr/0022-speech-timeline.md)).
The server sends lines with [`cue`](#cue) about one line ahead; the stage
plays them back to back in the order received, with a short breath between
them, so a new line never cuts off the one playing. The server keeps a
mirror of that queue: a line is over when an on-air stage reports it
[`spoken`](#spoken) (which also ends every line queued before it) or when
its duration plus a 4-second grace has passed since it reached the front.
Two on-air stages (OBS and the cloud broadcaster) each play every line in
full; the slower one is never cut off by the faster one's reports.

Version 2 replaced v1's interrupting `speak` for live speech with `cue` and
`drop`, and removed `prefetch`. A v1 stage page reloads when it sees the
v2 `hello`.

### Server to stage

#### `hello`

```json
{ "v": 2, "t": "hello", "serverTime": 1760616000000, "name": "Blip", "look": { "character": "orb", "primary": "#7CF5FF", "secondary": "#FF5FD2", "background": "#0B0420" }, "disclosure": "Blip is an AI host" }
```

First message on every connection. `look` is the persona's look
(`lookSchema` in `packages/shared/src/persona.ts`). `disclosure` is always
drawn on screen; it can't be turned off. Optional `reload: true` asks the
page to reload.

#### `cue`

```json
{ "v": 2, "t": "cue", "id": "c-1f3a", "text": "Five roses from Theo!", "emotion": "excited", "audioUrl": "/api/stage/<key>/audio/c-1f3a", "durationMs": 2400, "words": [0, 380, 790, 1020] }
```

Queue one line. The stage starts fetching and decoding `audioUrl` at once
and plays the line when the lines queued before it have finished: the
caption, the expression and the audio (or, when `audioUrl` is `null`, a
mouth animated from the text: captions-only mode) all start together. When
playback ends the stage replies with [`spoken`](#spoken) and the same `id`.

`words`, when present, is the start time in milliseconds of each word of
the text split on whitespace (`speechWords` in `packages/shared`), from the
voice's own alignment; the caption highlights each word as it's said. Without
it the stage estimates timing from word lengths and punctuation. Captions
follow the audio clock, not the frame clock, so a slow frame can't put them
behind the voice.

#### `speak`

```json
{ "v": 2, "t": "speak", "id": "demo-1", "text": "Hi Maria!", "emotion": "happy", "audioUrl": null, "durationMs": 1400 }
```

Same fields as [`cue`](#cue), but say it now: anything playing or queued is
cut off first. The live server doesn't send it; previews in the character
editor and the landing page demo use it.

#### `drop`

```json
{ "v": 2, "t": "drop", "ids": ["c-1f3b"] }
```

Take these lines out of the queue if they haven't started. A line already
playing finishes. The server sends it when something more important comes
up (a viewer's message during filler talk) so the host answers at the next
sentence boundary instead of after the whole monologue.

#### `stop`

Stop speaking now (the operator pressed pause or skip). Audio stops, the
queue empties and the caption clears at once.

#### `alert`

```json
{ "v": 2, "t": "alert", "kind": "gift", "name": "Theo", "giftName": "Rose", "count": 5, "diamonds": 5 }
```

An on-screen alert. `kind` is `gift`, `follow` or `share`; gift alerts also
carry `giftName`, `count` and `diamonds`. Up to four alerts stack on screen;
each stays about six seconds.

#### `segment`

```json
{ "v": 2, "t": "segment", "title": "Ask me anything" }
```

The show moved to a new segment; the stage shows its title.

#### `stats`

```json
{ "v": 2, "t": "stats", "viewers": 42, "likes": 1800 }
```

Audience numbers for on-screen counters. Droppable: when a client's send
buffer is over 1 MB, stats are skipped for it rather than queued.

#### `look`

```json
{ "v": 2, "t": "look", "name": "Blip", "look": { … } }
```

The persona's name or look changed in the dashboard. The stage morphs to it
without reloading.

#### `hold`

The server is restarting (graceful shutdown). Keep the last frame and
reconnect quietly; the host resumes on the next boot.

### Stage to server

#### `ready`

```json
{ "v": 2, "t": "ready", "role": "program", "engine": "1.0.0", "caps": { "webgl2": true, "audio": true } }
```

Sent on every (re)connect. `role` overrides the query parameter. `caps`
says whether WebGL2 and audio are available (OBS without "Control audio via
OBS" still reports audio; a machine without WebGL2 gets the 2D fallback).

#### `spoken`

```json
{ "v": 2, "t": "spoken", "id": "c-1f3a" }
```

The line with this `id` finished playing. Lines play in order, so it also
means every line queued before it is over. The server sends the next line
when it gets this (or after the line's duration plus a 4-second grace).

#### `telemetry`

```json
{ "v": 2, "t": "telemetry", "fps": 60, "frameP95": 4.2, "quality": 0, "renderer": "ANGLE (…)", "error": null }
```

Engine health, sent on connect, every 10 seconds, and at once after an
engine error: frames per second, 95th percentile
frame time in ms, quality level (0 is full quality; the governor steps down
to 2 when frames drop), the GPU renderer string, and the last engine error.
Shown under Health in the studio.

## Studio

### Connection lifecycle

1. The dashboard opens `/ws/studio/<channelId>`.
2. The server sends [`snapshot`](#snapshot) (the full state), then
   [`history`](#history) (recent lines and events).
3. Changes arrive as [`patch`](#patch) messages, coalesced on a 250 ms tick
   (at most 4 a second), plus discrete [`transcript`](#transcript),
   [`live-event`](#live-event), [`log`](#log) and [`notice`](#notice)
   messages.
4. The dashboard sends [`command`](#command) messages; each gets an
   [`ack`](#ack).
5. On disconnect the dashboard reconnects and receives a fresh snapshot;
   nothing needs replaying.

`patch`, `log` and `live-event` are droppable under backpressure (send
buffer over 1 MB); the next patch carries the current values anyway.

### Server to studio

#### `snapshot`

```json
{ "v": 2, "t": "snapshot", "state": { "status": "live", "paused": false, "standby": false, "thinking": false, "reactOnly": false, "segment": { … }, "stats": { … }, "nowSaying": null, "queue": [], "health": { … }, "session": { … } } }
```

The whole `RuntimeSnapshot`: status and its detail, pause, standby (waiting
for the TikTok account to go live), react-only mode (budget reached or
nobody watching), the current segment and the list to jump to, audience
stats, what the host is saying, the queue of things it may react to, counts
of filtered events by reason, and health (event source, connected stages by
role, engine telemetry, models in use, reply latency p50/p95, budget use,
cloud broadcast state), plus the current stream session.

#### `patch`

```json
{ "v": 2, "t": "patch", "state": { "stats": { "viewers": 43, … }, "thinking": true } }
```

Top-level `RuntimeSnapshot` fields that changed since the last tick. Each
field is replaced whole, not merged.

#### `history`

```json
{ "v": 2, "t": "history", "transcript": [ … ], "events": [ … ] }
```

The last 80 transcript lines and 150 audience events, oldest first, so the
room isn't empty after a reload.

#### `transcript`

```json
{ "v": 2, "t": "transcript", "line": { "id": "c-1f3a", "at": 1760616000000, "text": "Five roses from Theo!", "emotion": "excited", "status": "spoken" } }
```

A line the host spoke, or one the safety gate blocked (`status: "blocked"`
with a `reason`). `operator: true` marks lines typed by the owner with
[`say`](#say).

#### `live-event`

```json
{ "v": 2, "t": "live-event", "event": { "id": "e-9", "at": 1760616000000, "kind": "gift", "who": "Theo", "giftName": "Rose", "count": 5, "diamonds": 5 } }
```

An audience event as the studio's room shows it. `kind` is `chat`,
`question`, `gift`, `follow`, `share` or `join`. `filtered` holds the reason
when triage dropped it (spam, link, blocklisted term, prompt injection, …).

#### `log`

```json
{ "v": 2, "t": "log", "level": "warn", "msg": "TikTok connection lost; retrying", "at": 1760616000000 }
```

Operational log lines for the Health panel.

#### `notice`

```json
{ "v": 2, "t": "notice", "level": "warn", "code": "budget_warning", "message": "This host is close to its hourly AI budget.", "at": 1760616000000 }
```

Something the owner should see as a toast: budget thresholds
(`budget_warning`, `budget_reached`, `daily_cap_reached`), `paused` and
`resumed`, `turn_failed`, plan limits reached, cloud broadcast failures.
`code` is stable; `message` is for people.

#### `ack`

```json
{ "v": 2, "t": "ack", "id": "cmd-12", "ok": false, "error": "Start the host first." }
```

The result of a [`command`](#command), with the same `id`. An unparseable
command gets `id: "?"`.

### Studio to server

#### `command`

```json
{ "v": 2, "t": "command", "id": "cmd-12", "command": { "kind": "say", "text": "Back in five minutes!" } }
```

`id` is chosen by the client (1–64 characters) and echoed in the `ack`.
`command.kind` is one of the following.

##### `pause`

Stop speaking now and stop starting new turns. The stage gets `stop`.
Events keep arriving and queueing.

##### `resume`

Undo `pause`.

##### `skip`

Cut the current line; the host carries on with the next turn.

##### `say`

`{ "kind": "say", "text": "…" }` (1–300 characters): the host speaks this
line next, in its own voice. Lines typed by the owner skip the safety gate
and show as `operator` in the transcript; at most 10 a minute.

##### `segment`

`{ "kind": "segment", "id": "qa" }`: jump to a segment of the run of show.

##### `inject`

`{ "kind": "inject", "event": { "kind": "chat", "handle": "maria", "text": "hi!" } }`:
a test audience event (`chat`, `gift`, `follow` or `share`;
`injectEventSchema` in `packages/shared/src/events.ts`). It goes through
the same triage as real events, so it's the way to rehearse without going
live.
