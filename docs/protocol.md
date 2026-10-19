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
{ "v": 1, "t": "hello", "serverTime": 1760616000000, "name": "Blip", "look": { "character": "orb", "primary": "#7CF5FF", "secondary": "#FF5FD2", "background": "#0B0420" }, "disclosure": "Blip é uma IA" }
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

Optional `fx` (up to three of `EFFECTS` in `packages/shared/src/persona.ts`,
e.g. `["confetti"]`) plays reactions when the line starts. The host cues
them with tags like `[confetti]` in its text.

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

An on-screen alert. `kind` is `gift`, `follow`, `share`, `level`, `crown`,
`perk` or `raffle`; gift alerts also carry `giftName`, `count` and
`diamonds`, and `level` alerts (a viewer reached a new fan level,
[ADR-0037](adr/0037-fan-levels-and-passers-by.md)) carry `level`. `crown`:
the viewer just took first place among the gifters; `perk`: a gift just
unlocked a gift power, named in `perk` ("Dono da live",
[ADR-0039](adr/0039-gift-powers.md)); `raffle`: the viewer won the raffle
([ADR-0040](adr/0040-room-challenges-and-opinions.md)). Up to four alerts
stack on screen; each stays about six seconds.

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

#### `fx`

```json
{ "v": 1, "t": "fx", "fx": "fireworks", "intensity": 2 }
```

A reaction on its own, not tied to a line: a game win, the end of a game, a
like milestone. `fx` is one of `EFFECTS` (particle bursts like `confetti`,
`hearts`, `fireworks`, `notes`, and character moves like `spin`, `jump`,
`shake`). Optional `intensity`, 0.25 to 3 (default 1), scales it. Gifts,
follows, shares and likes don't need this: the stage plays their effects
from [`alert`](#alert) and [`stats`](#stats) on its own.

#### `game`

```json
{ "v": 1, "t": "game", "scene": { "kind": "trivia", "round": 1, "rounds": 5, "phase": "open", "remainingMs": 25000, "durationMs": 25000, "question": "Which planet is the largest?", "options": ["Saturn", "Jupiter", "Neptune", "Earth"], "answers": 0, "tally": null, "correct": null, "winners": [] } }
```

A chat minigame's scene ([ADR-0023](adr/0023-chat-minigames.md)), or
`"scene": null` to return to the show's normal stage. Each game kind has its
own scene (`gameSceneSchema` in `packages/shared/src/game.ts`): `trivia`,
`poll`, `scramble`, `number`, `truefalse`, `math`, `riddle`, `fastest`, the
party games `race`, `wheel`, `tug` and `potato`
([ADR-0038](adr/0038-games-of-chance-and-party-games.md)), `scoreboard` at
the end of a game, and `podium` at the end of a loop of the
run of show ([ADR-0028](adr/0028-up-next-likes-and-loop-ranking.md)): the
top three of the loop's ranking, with `places` (first place first) null
until each is revealed and `suspense` naming the place the drumroll is
building up to. Round scenes may carry `boosts` (the power-ups gifts
unlocked, see [`boost`](#boost)), and a quiz may carry `removed` (options a
50/50 took away). The full scene is re-sent on every change
(live counts at most four times a second), so the stage updates in place.
`remainingMs` and `durationMs` are relative to when the message arrives;
answers are never in the scene before `phase` is `reveal`. A stage that
connects mid-game gets the current scene right after `hello`.

The party games: in `race` and `wheel`, `stage` is `bets` while chat bets
(`phase` `open`), then `running` while the race runs or the strip spins and
`finish` at the result (both `phase` `reveal`). A race's `racers[].progress`
(0 to 1) comes a few times a second while it runs. A wheel's `landing` (the
`strip` tile it stops on) and `spinLeftMs` (relative to receipt) arrive
with the first `running` scene, so the stage animates the spin on its own
and lands on that tile. In `tug`, `rope` goes from -1 (team 1 pulled it all
the way) to 1 (team 2). In `potato`, `durationMs` is 0: the fuse is secret,
so the board shows no timer, only `heat` (time so far over the longest fuse)
and how long the `holder` has had it (`heldMs`, counted up on stage).

#### `boost`

```json
{ "v": 1, "t": "boost", "boost": "double", "by": "duda" }
```

A gift just powered up the open game round for everyone
([ADR-0029](adr/0029-gifts-power-ups-and-final-vote.md)): `time` (+10 s),
`hint` (the hint shows early; in a quiz, two wrong options go away; in
guess the number, the window narrows), or `double` (double points this
round). The stage shows a banner for the moment; the round's own scene
carries the lasting change (`boosts`, a quiz's `removed` options, the new
`durationMs`).

#### `vote`

```json
{ "v": 1, "t": "vote", "vote": { "title": "Jogo do quadro final", "options": ["Quiz", "Charadas", "Dedo mais rápido"], "tally": [4, 1, 9] } }
```

Chat's vote on the minigame the run of show's last segment plays
([ADR-0029](adr/0029-gifts-power-ups-and-final-vote.md)): open during the
last three minutes of the second-to-last segment, with the live tally (at
most once a second). Viewers type the number. The stage's ranking card shows
the vote instead of the rankings while it's open; `"vote": null` when it
closes. Sent right after `hello` to a stage that connects mid-vote.

With `by`, it's one viewer's pick of the next game instead (a gift power or
the raffle's prize, [ADR-0039](adr/0039-gift-powers.md)): only that viewer
chooses, so `tally` is empty and the card names them. A pick goes over
chat's vote while it's open.

#### `support`

```json
{ "v": 1, "t": "support", "card": { "title": "Blip é uma IA ao vivo", "lines": [{ "way": "like", "text": "Curta a live" }, { "way": "follow", "text": "Siga para não perder" }, { "way": "share", "text": "Compartilhe com amigos" }, { "way": "gift", "text": "Presentes pagam as contas da IA" }] } }
```

How viewers can support the show ([ADR-0032](adr/0032-gifts-and-supporting-the-show.md)):
a title and up to four lines, each with a `way` (`like`, `follow`, `share`
or `gift`) that picks its icon. The stage's ranking card shows it for about
20 seconds every few minutes, and while the host explains it; an open
`vote` stays on top. `"card": null` puts the rankings back. Sent right
after `hello` to a stage that connects while it's up.

#### `perks`

```json
{ "v": 1, "t": "perks", "card": { "title": "PODERES DO PRESENTE", "rows": [{ "diamonds": 5, "text": "fura-fila no chat" }, { "diamonds": 30, "text": "escolhe o próximo jogo" }, { "diamonds": 99, "text": "ganha um hino da IA" }, { "diamonds": 199, "text": "dono da live por 5 min" }] } }
```

The gift powers on offer ([ADR-0039](adr/0039-gift-powers.md)): what a gift
of so many diamonds unlocks, cheapest first, up to five rows of about 22
characters. The stage's ranking card shows it for about 18 seconds every
few minutes; it shares the slot with `support` (the latest wins) and an
open `vote` stays on top. `"card": null` puts the rankings back. Sent right
after `hello` to a stage that connects while it's up.

#### `boss`

```json
{ "v": 1, "t": "boss", "boss": { "name": "duda", "leftMs": 300000 } }
```

Who's the "dono da live" ([ADR-0039](adr/0039-gift-powers.md)): a gold badge
with a crown, the name and a countdown from `leftMs` (relative to receipt),
which steps aside while a game board is up. `"boss": null` when the reign
ends. A new one replaces the badge. Sent right after `hello`, with the time
left from then, to a stage that connects during a reign.

#### `challenge`

```json
{ "v": 1, "t": "challenge", "challenge": { "kind": "likes", "title": "DESAFIO DAS CURTIDAS", "detail": "toque na tela sem parar", "value": 312, "target": 500, "remainingMs": 28000, "durationMs": 45000, "result": null, "winner": null } }
```

A challenge for the whole room ([ADR-0040](adr/0040-room-challenges-and-opinions.md)):
`likes` (likes to `target` before the clock runs out), `chat` (messages
with a word) or `raffle` (chat enters by typing a word; `target` is 0 and
`value` counts entries). A banner under the character with a bar and a
countdown from `remainingMs`; the hook banner steps aside while it's up, and
both give way to a game board. New counts come at most four times a
second. When it ends, `result` is `won` or `lost` (and a raffle names its
`winner`) for a few seconds, then `"challenge": null` takes it down. Sent
right after `hello` to a stage that connects while it's up.

#### `hook`

```json
{ "v": 1, "t": "hook", "text": "COMENTA SEU NOME E GANHA UM APELIDO" }
```

A big call to people scrolling past ([ADR-0037](adr/0037-fan-levels-and-passers-by.md)),
in a bright banner under the character, while the host says it out loud.
It drops in, bobs while it's up and gives way to a game board. `"text":
null` takes it down (after about nine seconds). Sent right after `hello` to
a stage that connects while it's up.

#### `goals`

```json
{ "v": 1, "t": "goals", "goals": [{ "kind": "likes", "value": 3240, "target": 5000, "level": 2 }, { "kind": "gifts", "value": 120, "target": 500, "level": 1 }] }
```

The stream's like and gift goals ([ADR-0036](adr/0036-like-and-gift-goals.md)):
for each, the count so far (`gifts` counts diamonds), the target and which
goal it is (`level` 1, 2...). The stage shows them top right as two bars.
Progress is coalesced to a few messages a second; a goal reached goes out
at once, with `level` one higher and the next `target`, and the stage
shows "META BATIDA!" on that bar for a few seconds. An empty list hides the
panel (the creator turned the goals off). Sent right after `hello` to a
stage that connects while they're shown.

#### `schedule`

```json
{ "v": 1, "t": "schedule", "items": [{ "kind": "game", "title": "Quiz: futebol", "inMs": 154000 }, { "kind": "segment", "title": "Papo da madrugada", "inMs": 600000 }] }
```

What's coming up on the show, soonest first, for the stage's "A seguir"
panel ([ADR-0028](adr/0028-up-next-likes-and-loop-ranking.md)): up to four
items, each a `segment`, a segment's `game`, or the loop's `podium`, with
`inMs` relative to when the message arrives (the stage counts down on its
own clock). Times are estimates: a segment waits for a game in progress and
a quiet moment, so an overdue item has `inMs` 0 ("já já"). Sent when the
list or a time changes, and right after `hello` to a stage that connects;
an empty `items` hides the panel.

#### `leaders`

```json
{ "v": 1, "t": "leaders", "board": "gifts", "windowMin": 60, "rows": [{ "name": "duda", "value": 25300 }, { "name": "lu.desenha", "value": 1200 }] }
```

A ranking for the stage's card, most first (up to five; the stage shows
three): `board` `likes` counts likes over the last 15 minutes
([ADR-0028](adr/0028-up-next-likes-and-loop-ranking.md)), `gifts` counts
diamonds over the last hour ([ADR-0029](adr/0029-gifts-power-ups-and-final-vote.md)).
Anything older than `windowMin` no longer counts, so a board changes as
things expire. Each board is sent at most once a second, and right after
`hello`; empty `rows` takes that board off the card. The card takes turns
between the two boards.

#### `music`

```json
{ "v": 1, "t": "music", "track": { "title": "Batidão", "bpm": 130, "bars": 2, "repeat": 4, "swing": 0, "parts": [{ "instrument": "kick", "pattern": "x . . x . . x . . . x . . . . .", "volume": 0.9 }] } }
```

Play a piece of music, synthesized on the stage from its score
([ADR-0024](adr/0024-music-as-code.md); `musicTrackSchema` and the step
language in `packages/shared/src/music.ts`), replacing any piece already
playing; `"track": null` stops it. Music goes through the stage's audio
output (so OBS and the cloud broadcast carry it), ducks under speech, and
never moves the character's mouth. The whole piece lasts at most 45 s. A
stage that connects while a piece still has more than 8 s to go gets it
after `hello`, from the top.

#### `sfx`

```json
{ "v": 1, "t": "sfx", "sound": "win" }
```

A short synthesized sound for a show moment (`SOUNDS` in
`packages/shared/src/music.ts`): gifts, follows and shares, game rounds
opening and revealing, wins, the end of a game. Not sent when the creator
turned sound effects off.

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
stats, what's up next (`upNext`, with seconds to go), the top likers of the
last 15 minutes and top gifters of the last hour (`leaders`), the stream's
like and gift goals as the stage shows them (`goals`, empty when they're
off), the loop's minigame ranking (`ranking`: rows,
games played this loop, and whether its podium is being revealed), the open
vote on the last segment's game (`vote`, with votes per option), what the
host is saying, the queue of things it may react to, counts
of filtered events by reason, and health (event source, connected stages by
role, engine telemetry, models in use, how much of the host's recent input
came from the prompt cache (`health.brain.context`, null until the first
turn), reply latency p50/p95 with the median of each stage
(`health.latency.stages`: waiting for the turn, the model writing, the
voice, and waiting for the line before it), budget use, cloud broadcast
state), plus the current stream session.

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
{ "v": 1, "t": "notice", "level": "warn", "code": "budget_warning", "message": "Este apresentador está perto do orçamento de IA desta hora.", "at": 1760616000000 }
```

Something the owner should see as a toast: budget thresholds
(`budget_warning`, `budget_reached`, `daily_cap_reached`), `paused` and
`resumed`, `turn_failed`, `voice_failed` (a line aired as captions because the
voice didn't answer; at most every ten minutes), plan limits reached, cloud
broadcast failures.
`code` is stable; `message` is for people.

#### `ack`

```json
{ "v": 1, "t": "ack", "id": "cmd-12", "ok": false, "error": "Coloque o apresentador no ar primeiro." }
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

##### `game_start`

`{ "kind": "game_start", "game": { "kind": "trivia", "rounds": 5, "topic": "space" } }`:
start a chat minigame (`gameConfigSchema` in `packages/shared/src/game.ts`;
`rounds` 1–10, `topic` optional). Rejected while another game is running.
Its state shows up in the snapshot's `game` field.

##### `game_stop`

End the running game now; the stage returns to the normal show. While the
loop's podium is being revealed, this ends the podium instead (and the
ranking starts over).

##### `music_play`

`{ "kind": "music_play", "library": "lofi-night" }` plays a piece from
`MUSIC_LIBRARY`; `{ "kind": "music_play", "prompt": "funk carioca, 130 bpm" }`
asks the host to compose one in that style on its next turn and introduce it.
Rejected when the creator turned music off. The snapshot's `music` field says
what's playing.

##### `music_stop`

Stop the music on stage.

##### `reset`

Clears the stage without ending the stream: cuts the line being said and drops
the queue, ends any game or podium, stops the music, and restarts the stream's
counters and leaderboards. Viewer memory is kept.
