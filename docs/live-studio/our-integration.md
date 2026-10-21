# How our TikTok LIVE Studio features work

What Lantern does with TikTok LIVE Studio today, end to end, and the known
problems. The protocol itself is in
[stream-deck-protocol.md](stream-deck-protocol.md).

Snapshot of `main` at `842be36`. Line numbers drift; search for the named
function if a line has moved.

## The chain

```
Dashboard  apps/web/src/routes/host/setup.tsx
   │  HTTP  /api/channels/:id/live-studio/{check,action,pairing,devices,bridge.exe}
   ▼
Server     apps/server/src/http/routes/channels.ts
           LiveStudioSupervisor + RemoteBridgeSession  (apps/server/src/broadcast/live-studio.ts)
           manager.ts drives automatic start/stop (show on air, schedule)
   │  WebSocket /ws/bridge  (Authorization: Bearer lbt_…)   [legacy: /ws/bridge/<stageKey>]
   ▼
Agent      lantern-bridge.exe on the creator's PC  (apps/bridge/src/agent.ts)
           LocalLiveStudioController               (apps/bridge/src/live-studio.ts)
   │  (a) socket.io on 127.0.0.1:<port>, subprotocol streamdeck_ttls_v1
   │  (b) edits %APPDATA%\TikTok LIVE Studio\TTStore\services.json
   ▼
TikTok LIVE Studio
```

- **Server ↔ agent messages** (`packages/shared/src/broadcast.ts`): server
  sends `hello` and `request{id, action, params}`; the agent sends
  `status{probe}` when its probe changes (checked every 3 s) and
  `response{id, result, probe}` for each request. Every message has `v:1`.
  Messages over 16 KB, or that fail zod validation, are dropped without a log.
- **Pairing** ([ADR-0047](../adr/0047-bridge-agent-pairing-and-distribution.md)):
  the owner generates an 8-character code (15 min, single use); the agent
  posts it to `/api/bridge/pair` and gets an `lbt_` device token, saved in
  `%APPDATA%\Lantern\bridge.json`. The dashboard's download stamps the code
  and server address onto the end of the `.exe`, so a fresh download pairs
  itself.
- **Fallback:** with no agent connected, the supervisor uses the server's own
  local client, which only works when the server runs on the same Windows PC
  as Studio. On a hosted server it does nothing.
- **Polling:** the server asks the agent for a probe every 10 s for each
  channel that wants Studio live, on top of the agent's own 3 s change check.

## Features

Every Studio command opens a **new socket**, sends `join_room` and
`sync_settings`, waits for the snapshot, sends one `action_emit`, waits for
the ack, and closes. Code: `emitAction` / `emitCommand` in
`apps/bridge/src/live-studio.ts`.

| Feature | Where it starts | What reaches Studio | How we decide it worked | Timeouts (server / agent) |
|---|---|---|---|---|
| **Probe** | "Testar agente", every 10 s from the server, after every command | TCP scan of the 7 ports (250 ms each), read `services.json`, then `join_room` + `sync_settings` | A snapshot arrives within 3 s | 8 s / 3 s |
| **Launch** | "Abrir TikTok LIVE Studio" (shown when installed and not connected); also inside start | Spawns `TikTok LIVE Studio.exe` (path from `launcher_config.json`) | A probe sees a snapshot, polled every 1 s | 55 s / 45 s |
| **Start** | Owner starts the show, the schedule opens, or a status push shows Studio stopped while the show is wanted | Probe, launch if needed, then `livestartend` (or `livepauseresume` if paused), up to 3 attempts | Snapshot with `stream_status: 2`, or ack `0` | 60 s / up to ~130 s |
| **Stop** | Owner stops, the schedule closes, the auto-live switch is turned off, channel deleted | `livestartend` toward `stopped` | Snapshot with `stream_status: 0`, or ack `0`; on failure, re-probe | 25 s / 15 s, no retry |
| **Highlight** | "Salvar clipe de destaque (60s)"; automatic on show cues (60 s cooldown) | `highlight`, `{}` | Ack `0` | 12 s / 8 s |
| **Recording** | "Gravar MP4 local" | `recording`, `{}` | Ack `0` | 12 s / 10 s |
| **Scene** | Scene chips | `scene`, `{settings:{scene:<name>}}` | Ack `0` (Studio only acks once the scene changed) | 10 s / 6 s |
| **Source** | Source chips in the current scene | `source`, `{settings:{scene, source:<id>}}` | Ack `0` | 10 s / 6 s |
| **Vibe** | Vibe chips; automatic on show cues (20 s cooldown, keyword match on vibe names) | `vibe`, `{settings:{currentVibeId}}` | Assumed ok after 300 ms or the next snapshot, without waiting for the ack | 10 s / 5 s |
| **Camera effect** | "Efeitos de Câmera" chips (first 8 per category) | `cameraeffects`, `{settings:{cameraSource, cameraEffectType, cameraEffectId}}`; source is the default camera, never user-chosen | Ack `0` | 10 s / 6 s |
| **Inject stage** | "Configurar palco na cena (1 clique)"; automatic at start-up for legacy stage-link agents | **File edit, no socket.** Adds or updates a browser source named "Vincular" (1080×1920, audio on) in the current scene of `services.json` | The write didn't throw | 12 s / none |
| **Sync handle** | "Detectar @usuário logado" | Nothing; reads the logged-in username from `services.json` | A valid handle was found | — |
| **CLI** | `lantern-bridge.exe --check / --launch / --start / --stop / --highlight / --record / --scene X / --vibe X / --inject-stage URL` | Same as above, no server involved | Exit code | — |

**Scheduled stream hours** (`packages/shared/src/channel.ts`
`evaluateStreamSchedule`, `apps/server/src/runtime/manager.ts`
`reconcileChannelSchedule`): checked once a minute and on every channel
change. Inside the window, the show starts and Studio follows through Start;
when the window ends, Stop. A manual stop inside a window holds until the
window ends.

**What the dashboard shows from the probe:** connected, current scene,
scenes and their sources, vibes and the playing vibe, camera effect
categories, recording state, logged-in username, whether the stage source is
configured. Parsed but not shown: `highlight_able`, camera sources,
`camera_effect.typeList`. Never parsed: the audio, mic, sound effect, audio
filter, poll and viewer-wishes keys.

## Known problems

Verified in the code unless marked otherwise. Highest impact first.

### Correctness and safety

1. **A stage link can take over the control socket.**
   `attachBridge` (`apps/server/src/broadcast/live-studio.ts:1150-1155`) only
   refuses a newcomer when *both* sides have a device id. The legacy
   `/ws/bridge/<stageKey>` path attaches with no device id
   (`apps/server/src/http/realtime.ts:101-125`), so anyone with the stage
   link, which sits in OBS, replaces the paired agent, receives its
   start/stop requests, and can push fake status. Fix: refuse a stage-link
   attach while a paired device is connected, or retire the legacy path.
2. **A missed stop is never retried; the PC stays live.**
   `supervisor.stop` (`live-studio.ts:1260-1266`) deletes the channel from
   `wanted` first, then sends to `clientFor()`, which falls back to the
   server's local client when the agent is offline. The result is only
   logged. When the agent reconnects, nothing sends the stop.
3. **Deleting a channel doesn't stop the PC's live.** `manager.remove`
   (`apps/server/src/runtime/manager.ts:193-201`) calls `closeBridge` before
   `liveStudio.stop`, so the stop goes to the fallback client.
4. **One slow probe reads as "Studio closed".** A failed 3 s
   `readSettings` makes the probe report `connected: false`. Then `stop()`
   returns "Desligada" without stopping anything
   (`apps/bridge/src/live-studio.ts:575-577`), and `start()` launches a
   **second** Studio (`:540-541`, `:500-515`). Studio also sends an
   empty `sync_settings` while starting up, which the client ignores, so
   probes during launch time out.
5. **Every command interrupts Studio's state pushes.** Each socket close
   runs Studio's `stopListening()` for all clients (see the protocol page).
   Harmless with today's request/response design, but it rules out
   listening for changes until we keep one socket open.
6. **Commands run concurrently against toggles.** `agent.ts:140` handles
   every request with no queue, and `livestartend` is a toggle. Two
   overlapping start/stop commands can both read "stopped" and both send.
7. **Turning the auto-live switch off while on air ends the TikTok live**,
   and the setup page doesn't say so.
8. **Stopping the live inside Studio is undone.** While the show is
   wanted, a status push showing "stopped" makes the server start it again
   within seconds. Probably intended; confirm and say so in the UI.

### Fragile assumptions

9. **Studio's auth can change under us.** TikTok can enable token auth
   remotely (`streamdeck_websocket_auth_enabled`). The bridge would be
   refused on every command and the dashboard would show "not connected".
10. **Fixed port list.** If all 7 ports are busy, Studio uses a random port
    we can't find.
11. **`services.json` is edited while Studio runs.** Not atomic, no backup,
    no read-back, and we don't know whether Studio rereads the file or
    overwrites it with its in-memory state. The "configured" badge reads the
    same file, so it stays green after a stage-key rotation leaves a dead
    URL in the source. Any user browser source named "vincular" or
    containing "lantern" gets its URL overwritten. The transform and zoom
    are copied from one 1.38.0 scene.
12. **Large Studio setups vanish silently.** `audio_control` can include
    whole source objects, and the zod limits (50 scenes, 60 sources, 50
    vibes) plus the 16 KB cap drop a whole `status` or `response` with no
    log.
13. **Timeouts disagree.** The server gives Start 60 s; the agent can take
    about 130 s. The owner sees a timeout while the agent is still working.
14. **The launch sets an undocumented environment variable**
    (`DEVTOOLS_MCP=1`, `apps/bridge/src/live-studio.ts:513`). Nothing in the
    repo says why. The Stream Deck server doesn't need it: it starts
    unconditionally.

### Maintenance

15. **Two copies of the Studio client.** `apps/server/src/broadcast/live-studio.ts`
    contains a copy of `apps/bridge/src/live-studio.ts`. The server copy
    is the one the tests cover; the bridge copy ships in the `.exe`. The
    bridge's `executeAction` has no caller.
16. **The test mock is generous.** The mock Studio in
    `apps/server/test/api/broadcast.test.ts` never acks `vibe` (the 300 ms
    fallback is what passes) and never pushes a status change after an
    action.
17. **Docs gaps.** `docs/api.md` doesn't document `liveStudio`, `schedule`,
    or `POST /live-studio/action`; ADR-0047 is still "Proposed".

Smaller items: scheduled starts that fail (for example plan limits) fail
silently and retry every minute; any channel edit clears a manual stop
inside a schedule window; two agents on one PC kick each other off forever
(4000 is treated as a normal drop); a network error during first pairing
marks the stamped code as used; the highlight button ignores
`highlightAble`; `/live-studio/check?launch` and `/live-studio/action` have
no rate limit.
