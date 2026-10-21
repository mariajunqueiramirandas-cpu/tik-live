# TikTok LIVE Studio: the Stream Deck control socket

TikTok LIVE Studio runs a local socket.io server so the Elgato Stream Deck
plugin can drive it. The Local Bridge Agent (`apps/bridge`) uses the same
server. This page is the reference for that protocol.

**Version studied:** TikTok LIVE Studio 1.38.0 (`studio/release/1.38`),
Windows. Read from the unpacked app code (nothing modified) plus a read-only
live capture that only sent `join_room` and `sync_settings`. Minified names
and file names below change between builds; the event names, action ids, and
field names have been stable across the versions we've used.

Evidence levels used below:

- **live**: seen on a running Studio.
- **code**: read in Studio's code, not exercised.

## Where it lives

| Part | Location (1.38.0) |
|---|---|
| Server, constants, auth | `resources/app/electron/main.js` (main process). Constants module `sd_ls_common`; room class handling `join_room`; server class with `listen`, `/token` and the auth middleware. |
| Action handlers and `sync_settings` builder | `resources/app/static/js/async/79789.0297f726.js` (renderer), `StreamDeckService` with `loadActions()`, `callAction()`, `startListening()`/`stopListening()` |

The main process forwards every action to the renderer's `StreamDeckService`,
which does the real work by publishing the same internal hotkey events the
app's own UI uses.

## Connecting

| Item | Value |
|---|---|
| URL | `ws://127.0.0.1:<port>/socket.io/?EIO=4&transport=websocket` (Engine.IO 4, socket.io 4, default namespace) |
| Ports | First free port from `[28189, 39728, 34246, 42205, 38534, 40825, 40622]`, in that order. If all are taken Studio falls back to an OS-assigned port that a client can't discover. **code**; 28189 **live** |
| Bind | All interfaces (`0.0.0.0` and `[::]`). Engine.IO's `allowRequest` rejects any peer that isn't `127.0.0.1`, `::1`, or `::ffff:127.0.0.1`. **live** |
| Handshake check | WebSocket subprotocol must be exactly `streamdeck_ttls_v1`. With any other or no subprotocol, the namespace connect is refused with `44{"message":"invalid"}`. **live** |
| Origin | Not checked anywhere. **code** |
| Token mode | If the remote-config flag `streamdeck_websocket_auth_enabled` is true, the subprotocol check is replaced by a single-use token sent as `auth.token` or the `authorization` header. Tokens come from `GET /token`, which only answers when an Elgato device (`VID_0FD9`) is plugged in. The flag is off by default. **code** |
| Page gate | Nothing is served unless Studio is on its main page (`mainPageMode === "MAIN"`). During loading or login, actions return `-1` and no state is pushed. **code** |
| Start-up | The server starts with the app, with no user setting to disable it. Until the renderer has finished initialising (i18n plus a 5 s sleep), `sync_settings` is sent **with no payload**. **code** |

> **Risk for us:** TikTok can turn token mode on remotely. If it does, our
> subprotocol-only handshake is refused and every bridge command fails until
> the agent supports tokens, and tokens need a Stream Deck plugged in.

Frame sequence a client sends (this is what the bridge does):

```
<- 0{"sid":...}                      Engine.IO open
-> 40                                socket.io connect
<- 40{"sid":...}                     connect ack
-> 42["stream_deck/join_room"]
-> 42["stream_deck/sync_settings"]
<- 42["stream_deck/sync_settings","<JSON string>"]
<- 2   /  -> 3                       Engine.IO ping/pong
```

Object payloads are **JSON strings inside the socket.io array**, in both
directions. Studio calls `JSON.parse` on them and uses `{}` if parsing fails.

## Events

Client to Studio:

| Event | Payload | What Studio does |
|---|---|---|
| `stream_deck/join_room` | none | Joins room `stream_deck`, starts the renderer's state listeners, and registers a `disconnect` hook on this socket that **stops the listeners** (see below). **code** |
| `stream_deck/leave_room` | none | Leaves the room. **code** |
| `stream_deck/sync_settings` | none | Broadcasts the cached state to the room. **live** |
| `stream_deck/action_emit` | `{"action":"com.tiktok.livestudio.<id>","context":"<any string>","payload":{...}}` | Runs the action, then broadcasts the ack `stream_deck/<context>` with `{"code":n}`. **code** |
| `stream_deck/device_status_emit` | `{"status":"connected"\|"disconnected"}` | Shows a toast and logs telemetry. No state change. **code** |

Studio to client (all broadcast to the whole room):

| Event | Payload | When |
|---|---|---|
| `stream_deck/sync_settings` | Full state snapshot, JSON string | On request, and **on every real change** to any field. Each push is the whole object, never a diff. **live** (on request), **code** (on change) |
| `stream_deck/<context>` | `{"code":0}` or `{"code":-1}` | After each `action_emit`. |
| `stream_deck/join_room` | none | When any client joins. |

### Room quirks

All verified in Studio's code; the leave-and-join refresh was also checked
on a running Studio.

- **Any disconnect stops pushes for everyone.** Every socket's `disconnect`
  calls `stopListening()` on the shared renderer service, so pushes stop for
  **all** clients until someone sends `join_room` again. Keep one
  long-lived socket, and re-join now and then in case another client (such
  as the real Stream Deck plugin) disconnected.
- **Never join twice on one socket.** Each `join_room` registers the
  socket's `sync_settings`, `device_status_emit` and `action_emit` handlers
  again without removing the old ones, so every later action would run
  twice (and `livestartend` is a toggle). `leave_room` disposes them; to
  refresh, send `leave_room` then `join_room`.
- **Re-joining is cheap.** `join_room` restarts the renderer's listeners
  (`startListening()` drops the previous ones first) and recomputes the
  cached snapshot.
- **Handlers exist only after the join settles.** The join handler awaits
  the room join before registering the socket's handlers, so a request in
  the same breath as `join_room` can be lost. Ask for `sync_settings` until
  a snapshot arrives, and send actions only after that.

## Ack codes

| Code | Meaning |
|---|---|
| `0` | Success. For some actions this only means "dispatched": see the table. |
| `-1` | Failed: unknown or unregistered action, a missing or mismatched payload field, not on the main page, feature not available, or an exception. |
| no ack | Possible for `recording`, whose handler waits for the state change with no timeout. Always time out on the client. |

Because acks are broadcast to the room, use a unique `context` per command.

## Actions

The payload of `action_emit` is passed to the handler as is. Most handlers
read `payload.settings.<field>`; the volume setters also read a top-level
`payload.mutationValue`.

"Toggle" means the action flips state and has no target value. To set a
state, read it from `sync_settings` first and only send when it differs.

| Action id (`com.tiktok.livestudio.`…) | Payload | Effect | Ack semantics | Bridge uses it |
|---|---|---|---|---|
| `livestartend` | none | **Starts or ends the live** (toggle) | `0` once dispatched; not a confirmation | yes |
| `livepauseresume` | none | Pause/resume, only while live and streaming (toggle) | `0` only after the status changes (1 s wait) | yes |
| `highlight` | none | Saves a 60 s highlight clip, if `highlight_able` | `0` once dispatched, `-1` if not able | yes |
| `recording` | none | Starts or stops local MP4 recording (toggle) | `0` after the change; **can hang** | yes |
| `recordinggallery` | none | Opens the instant-replay gallery window | UI only | no |
| `scene` | `settings.scene` = scene **name** | Switches scene (set, not toggle) | `0` only if the scene changed within 1 s | yes |
| `source` | `settings.scene` = **current** scene name, `settings.source` = source **id** | Toggles a source's visibility. Refused while paused | `0` once toggled | yes |
| `vibe` | `settings.currentVibeId` | Plays a vibe | `0` if no exception; not a confirmation | yes |
| `cameraeffects` | `settings.cameraSource` (id, `"all"`, or `"default"`), `settings.cameraEffectType` (category **name**), `settings.cameraEffectId` | Applies an effect. **Toggle**: sending the same effect again removes it | `0`/`-1`; needs a camera in the current scene | yes |
| `audio` | none | Toggles speaker/output mute | Always `0` after a 1 s wait | no |
| `mic` | none | Toggles microphone mute | Always `0` after a 1 s wait | no |
| `audiocontrol` | `settings.currentAudioId`; optional top-level `mutationValue` | With `mutationValue`: **sets that output's volume**. Without: toggles its mute | `0` once dispatched; `-1` if the id is unknown | no |
| `miccontrol` | `settings.currentMicId`; optional top-level `mutationValue` | Same, for inputs | Same | no |
| `soundeffect` | `settings.currentSound` = name from `sound_effect.sound_Info` | Plays a built-in sound effect | `0` if ready (or a re-download started) | no |
| `audiofilter` | `settings.audioFilterDevice`, `settings.audioFilterType`, `settings.audioFilterSelect` (**localized labels**) | Applies an audio DSP preset | `-1` if a label doesn't match the UI language | no |
| `vote` | `settings.voteType` = one of `voteTypes` (localized) | **Opens** a poll popup; doesn't create a poll | UI only | no |
| `viewerwishes` | none | Toggles viewer wishes | Handler's result | no |
| `sayhi` | none | Sends the "wave" greeting. **Viewers see it** | `0` if published within 2 s | no |
| `cohost`, `multiguest`, `promote`, `treasurebox`, `team`, `gamepad`, `guessgame`, `goodybag`, `livegoal`, `playtogether` | none | Open the matching panel or popup in Studio | UI only | no |
| `filter`, `equalizer`, `reverberation`, `volumedial` | — | In the enum with no handler | Always `-1` | no |

Volume values in `sync_settings` are decimals (`1` for a device at full,
`0.5` for the sound-effects channel in our capture), so `mutationValue` is
most likely a 0–1 linear value. **Not tested.** The handler refuses
(`-1`) to set `0` when the current volume is already `0`.

## The `sync_settings` snapshot

17 top-level keys (all present in the live capture):

| Key | Type and meaning |
|---|---|
| `stream_status` | `0` not live (also preparing/finished), `1` paused, `2` live |
| `recording` | Local MP4 recording on |
| `highlight_able` | A highlight can be saved now |
| `live_replay_able` | Instant replay is enabled for this account |
| `scene` | Current scene name |
| `scene_list` | Scenes in the current orientation: `{name, sources:[{label,value}], visible_sources:[...]}`; `value` is the source id |
| `vibeList`, `playingVibe` | Vibes `{id,name}` in Studio's order; the playing vibe id or `""` |
| `camera_effect` | `{sourceList:[{label,value,isDefault,effectId}], typeList:[...], effectList:[{key,name,effects:[{label,value}]}]}`. `sourceList` starts with `"all"` and `"default"` |
| `audio_mute`, `mic_mute` | True only when every output (or input) is muted |
| `audio_control.audioList` | Outputs **and** visible sound-capable sources in the current scene: `{id, name, volume, isMute, audioType, deviceId, ...}`. Source entries include the whole source object, so this can be large |
| `mic_control.micList` | Inputs: `{id, name, volume, isMute, deviceId, ...}` |
| `sound_effect` | `{currentsound, sound_Info:[...]}`. In a pt-BR Studio: Torcida, Palma, Risada, Beijo, Boing, Bate coração, Uau, Grito, Magia, Triunfo, Falha, Esquisito, Assobio, Tambor, Suspense, Glória, Tontura, Noturno |
| `audio_filter` | `{enableTypes, deviceList, typeList, filterList}`; type names are localized (pt-BR: Modelos, Equalizador, Reverb) |
| `voteTypes` | The three localized poll kinds accepted by `vote` |
| `viewerWishesOngoing` | Viewer wishes running |

**Not available on this socket:** viewer count, comments, gifts, likes,
follows, room title or topic, stream URL or key, account info. Reacting to
the audience has to keep coming from our own TikTok LIVE connection.

## Studio's saved scenes (`services.json`)

Studio keeps its saved state, scenes included, in
`%APPDATA%\TikTok LIVE Studio\TTStore\services.json`, one
`{ state, version }` entry per internal service (`SourceService` holds the
scenes). Studio's main process reads the file **once at start-up** and later
writes its whole in-memory state back over it. An edit made while Studio is
open is never seen and gets overwritten: write it only while Studio is
closed, and it shows up the next time Studio opens. (code, verified)

## Telemetry

Every action is reported to TikTok's analytics as
`livesdk_live_streamdeck_action` with the action name. Assume anything we
automate through this socket is visible to TikTok as Stream Deck usage.

## Re-checking after a Studio update

1. Run `lantern-bridge.exe --check` on the PC. It connects, reads
   `sync_settings` and prints what it found, without changing anything.
   `authRequired: true` means Studio switched to token auth; `running:
   true` with `connected: false` means Studio is open but not on its main
   page.
2. If it fails, check the port list and subprotocol in Studio's `main.js`
   (search for `streamdeck_ttls` and `LS_PORT_LIST`) and the auth flag
   (`streamdeck_websocket_auth_enabled`).
3. For new actions, search the renderer bundles for `com.tiktok.livestudio.`
   and compare with the table above.
