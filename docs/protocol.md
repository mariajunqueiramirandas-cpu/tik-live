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

- `v`: the protocol version, currently **1**;
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

Only `program` and `broadcast` stages are "on air": their `started` and
`spoken` messages pace the host and their telemetry shows in the studio.
The server sends the next line only once **every** on-air stage that got the
current one has finished it, so the show never runs ahead of the slowest
stage on air ([ADR-0022](adr/0022-host-turn-taking.md)). Previews never pace
the show. When no on-air stage is connected, the server paces speech by
each line's estimated duration so the show keeps a realistic rhythm.

### Server to stage

#### `hello`

```json
{ "v": 1, "t": "hello", "serverTime": 1760616000000, "name": "Blip", "look": { "character": "orb", "primary": "#7CF5FF", "secondary": "#FF5FD2", "background": "#0B0420" }, "disclosure": "Blip is an AI host" }
```

First message on every connection. `look` is the persona's look
(`lookSchema` in `packages/shared/src/persona.ts`). `disclosure` is always
drawn on screen; it can't be turned off. Optional `reload: true` asks the
page to reload.

#### `speak`

```json
{ "v": 1, "t": "speak", "id": "c-1f3a", "text": "Five roses from Theo!", "emotion": "excited", "audioUrl": "/api/stage/<key>/audio/c-1f3a", "durationMs": 2400 }
```

Say one line: show the caption, set the expression, play `audioUrl` (or
animate the mouth from the text when it's `null`, which is captions-only
mode). When playback starts the stage replies with [`started`](#started),
and when it ends with [`spoken`](#spoken), both with the same `id`.

A `speak` that arrives while another line is playing **waits** for that line
to end; it never cuts it off. Only [`stop`](#stop) cuts a line. If more than
three lines are waiting (the stage fell far behind), the stage skips the
oldest waiting one and reports it as `spoken`.

#### `prefetch`

```json
{ "v": 1, "t": "prefetch", "audioUrl": "/api/stage/<key>/audio/c-1f3b" }
```

Audio for the next line, sent while the current one plays. Fetch and decode
it now so the next `speak` starts without a gap.

#### `stop`

Stop speaking now (the operator pressed pause or skip). Audio stops, lines
waiting to be spoken are discarded, and the caption clears at once.

#### `alert`

```json
{ "v": 1, "t": "alert", "kind": "gift", "name": "Theo", "giftName": "Rose", "count": 5, "diamonds": 5 }
```

An on-screen alert. `kind` is `gift`, `follow` or `share`; gift alerts also
carry `giftName`, `count` and `diamonds`. Up to four alerts stack on screen;
each stays about six seconds.

#### `segment`

```json
{ "v": 1, "t": "segment", "title": "Ask me anything" }
```

The show moved to a new segment; the stage shows its title.

#### `stats`

```json
{ "v": 1, "t": "stats", "viewers": 42, "likes": 1800 }
```

Audience numbers for on-screen counters, sent at most four times a second
(a burst of likes is coalesced into the latest numbers). Droppable: when a
client's send buffer is over 1 MB, stats are skipped for it rather than
queued.

#### `look`

```json
{ "v": 1, "t": "look", "name": "Blip", "look": { … } }
```

The persona's name or look changed in the dashboard. The stage morphs to it
without reloading.

#### `hold`

The server is restarting (graceful shutdown). Keep the last frame and
reconnect quietly; the host resumes on the next boot.

### Stage to server

#### `ready`

```json
{ "v": 1, "t": "ready", "role": "program", "engine": "1.0.0", "caps": { "webgl2": true, "audio": true } }
```

Sent on every (re)connect. `role` overrides the query parameter. `caps`
says whether WebGL2 and audio are available (OBS without "Control audio via
OBS" still reports audio; a machine without WebGL2 gets the 2D fallback).

#### `started`

```json
{ "v": 1, "t": "started", "id": "c-1f3a", "durationMs": 2380 }
```

The line with this `id` started playing; `durationMs` is the length of the
decoded audio (or of the silent envelope in captions-only mode). Until a
stage sends this, the server gives it the line's estimated duration plus 4
seconds to fetch and decode; after it, the real duration plus 1.5 seconds.

#### `spoken`

```json
{ "v": 1, "t": "spoken", "id": "c-1f3a" }
```

The line with this `id` finished playing. The host speaks again once every
on-air stage that got the line has sent this (or disconnected, or ran out of
the time described under [`started`](#started)).

#### `telemetry`

```json
{ "v": 1, "t": "telemetry", "fps": 60, "frameP95": 4.2, "quality": 0, "renderer": "ANGLE (…)", "error": null }
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
{ "v": 1, "t": "snapshot", "state": { "status": "live", "paused": false, "standby": false, "thinking": false, "reactOnly": false, "segment": { … }, "stats": { … }, "nowSaying": null, "queue": [], "health": { … }, "session": { … } } }
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
{ "v": 1, "t": "patch", "state": { "stats": { "viewers": 43, … }, "thinking": true } }
```

Top-level `RuntimeSnapshot` fields that changed since the last tick. Each
field is replaced whole, not merged.

#### `history`

```json
{ "v": 1, "t": "history", "transcript": [ … ], "events": [ … ] }
```

The last 80 transcript lines and 150 audience events, oldest first, so the
room isn't empty after a reload.

#### `transcript`

```json
{ "v": 1, "t": "transcript", "line": { "id": "c-1f3a", "at": 1760616000000, "text": "Five roses from Theo!", "emotion": "excited", "status": "spoken" } }
```

A line the host spoke, or one the safety gate blocked (`status: "blocked"`
with a `reason`). `operator: true` marks lines typed by the owner with
[`say`](#say).

#### `live-event`

```json
{ "v": 1, "t": "live-event", "event": { "id": "e-9", "at": 1760616000000, "kind": "gift", "who": "Theo", "giftName": "Rose", "count": 5, "diamonds": 5 } }
```

An audience event as the studio's room shows it. `kind` is `chat`,
`question`, `gift`, `follow`, `share` or `join`. `filtered` holds the reason
when triage dropped it (spam, link, blocklisted term, prompt injection, …).

#### `log`

```json
{ "v": 1, "t": "log", "level": "warn", "msg": "TikTok connection lost; retrying", "at": 1760616000000 }
```

Operational log lines for the Health panel.

#### `notice`

```json
{ "v": 1, "t": "notice", "level": "warn", "code": "budget_warning", "message": "This host is close to its hourly AI budget.", "at": 1760616000000 }
```

Something the owner should see as a toast: budget thresholds
(`budget_warning`, `budget_reached`, `daily_cap_reached`), `paused` and
`resumed`, `turn_failed`, plan limits reached, cloud broadcast failures.
`code` is stable; `message` is for people.

#### `ack`

```json
{ "v": 1, "t": "ack", "id": "cmd-12", "ok": false, "error": "Start the host first." }
```

The result of a [`command`](#command), with the same `id`. An unparseable
command gets `id: "?"`.

### Studio to server

#### `command`

```json
{ "v": 1, "t": "command", "id": "cmd-12", "command": { "kind": "say", "text": "Back in five minutes!" } }
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
line next, in its own voice, right after the sentence on stage and ahead of
anything the host had queued. Lines typed by the owner skip the safety gate
and show as `operator` in the transcript; at most 10 a minute.

##### `segment`

`{ "kind": "segment", "id": "qa" }`: jump to a segment of the run of show.

##### `inject`

`{ "kind": "inject", "event": { "kind": "chat", "handle": "maria", "text": "hi!" } }`:
a test audience event (`chat`, `gift`, `follow` or `share`;
`injectEventSchema` in `packages/shared/src/events.ts`). It goes through
the same triage as real events, so it's the way to rehearse without going
live.
