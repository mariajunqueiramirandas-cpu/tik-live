# How our TikTok LIVE Studio features work

What Lantern does with TikTok LIVE Studio, end to end. The protocol itself
is in [stream-deck-protocol.md](stream-deck-protocol.md); the design choices
are in [ADR-0048](../adr/0048-live-studio-bridge-reliability.md).

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
           LocalLiveStudioController  (packages/shared/src/live-studio, shared with the server)
   │  (a) one long-lived socket.io connection to 127.0.0.1:<port>, subprotocol streamdeck_ttls_v1
   │  (b) %APPDATA%\TikTok LIVE Studio\TTStore\services.json, only while Studio is closed
   ▼
TikTok LIVE Studio
```

- **One Studio client.** `packages/shared/src/live-studio` is the only
  code that talks to Studio. The agent uses it, and so does the server's
  fallback for a server running on the same PC as Studio (development). It
  is a Node-only subpath export (`@tik-live/shared/live-studio`), so the
  web app never bundles it.
- **Server ↔ agent messages** are in [protocol.md](../protocol.md#local-bridge-agent).
  The agent reports a status when Studio's state changes (Studio pushes it)
  and on a 3 s check; the server also asks for a probe every 10 s while the
  host wants Studio live.
- **Pairing** ([ADR-0047](../adr/0047-bridge-agent-pairing-and-distribution.md)):
  an 8-character code traded for an `lbt_` device token, saved in
  `%APPDATA%\Lantern\bridge.json`. The dashboard's download stamps a code
  onto the `.exe`, so a fresh download pairs itself. A code the server never
  received (network error) isn't marked used.

## The Studio connection

`LocalLiveStudioController` keeps **one** socket to Studio and stays joined
to its Stream Deck room, holding the latest snapshot:

- **Finding Studio:** the 7 usual ports first, then the ports Studio's
  processes actually listen on (`tasklist` + `netstat`), for when Studio had
  to pick a random one.
- **Telling states apart:** *closed* (no process, no port), *open but not
  answering* (loading, logging in, or off the main page: `running: true`,
  `connected: false`), *refusing us* (Studio switched to token auth:
  `authRequired: true`), and *connected*.
- **Staying fresh:** every 20 s, when idle, it leaves and re-joins the room,
  which restarts Studio's change pushes if another client's disconnect
  stopped them. It never joins twice without leaving, which would make
  Studio run every action twice.
- **Start-up:** while Studio answers with empty snapshots, it keeps asking
  once a second.
- **One command at a time.** Start and end press the same toggle, so
  commands queue. A stop cancels a start that is still waiting.

## Features

| Feature | Where it starts | What reaches Studio | How we know it worked | Agent timeout / server timeout |
|---|---|---|---|---|
| **Probe** | Server every 10 s, agent on change and every 3 s, after each command | Nothing new: the held snapshot, plus `services.json` (re-read only when it changes) | — | — / 8 s |
| **Launch** | "Abrir TikTok LIVE Studio"; inside Start | Opens `TikTok LIVE Studio.exe` **only if it isn't running**, then waits | A snapshot arrives | 60 s / 70 s |
| **Start** | Host goes on air, schedule window opens, or Studio reports the live ended while wanted | Launch if needed; `livepauseresume` if paused; else `livestartend`, pressed again only if Studio rejected the press | `stream_status` leaves 0 in a push | 120 s / 135 s, in the background |
| **Stop** | Host stopped, schedule window closed, auto-live switch off, host deleted | `livestartend` | `stream_status` 0 in a push. Studio closed counts as ended; Studio open but not answering does **not** | ~40 s / 45 s; retried until confirmed |
| **Highlight** | Button (disabled while Studio doesn't allow clips); automatic on show cues | `highlight` | Ack `0` | 8 s / 12 s |
| **Recording** | Button | `recording` | Ack `0`, or the snapshot's `recording` flipped | 10 s / 12 s |
| **Scene** | Scene chips | `scene` with the scene name | Ack `0` (Studio acks once the scene changed) | 6 s / 10 s |
| **Source** | Source chips (current scene) | `source` with the current scene and the source id | Ack `0` | 6 s / 10 s |
| **Vibe** | Vibe chips; automatic on show cues (20 s cooldown) | `vibe` with the vibe id (a name is resolved) | Ack `0` | 5 s / 10 s |
| **Camera effect** | Effects grouped by category, camera picker | `cameraeffects` with the category **name** | Ack `0`. Sending the same effect again removes it | 6 s / 10 s |
| **Stage source** | "Configurar palco na cena"; after a stage-key change; legacy stage-link agents at start-up | Adds or updates the "Vincular" Browser Source in the current scene of `services.json`, atomically, with a `.lantern-backup` copy. With Studio open it waits (`stagePending`) and is written as soon as Studio closes | The written file is read back | — / 15 s |
| **Sync handle** | "Detectar @usuário logado" | Nothing: reads the account from `services.json` | A valid handle | — |

What the dashboard shows: whether Studio is connected, open but not ready,
or refusing the agent; the logged-in account; whether the stage source
points at the current stage link (or an old one, or is waiting for Studio to
close); scenes and sources; vibes; camera effects; recording; whether a
highlight can be saved now. Health says "Pausada" for a paused live.

## Reliability rules

- **A stage link never controls a paired PC.** While a paired agent is
  connected, `/ws/bridge/<stageKey>` is refused with `4009`.
- **A stop is never lost.** Until the agent confirms the live ended, the
  stop stays owed: it goes out again when the agent reconnects, and every
  30 s while the agent reports Studio still live. Deleting a host ends the
  PC's live before disconnecting its agent.
- **Going live doesn't block anyone.** Turning the host on returns at once;
  Studio's progress shows in Health.
- **Nothing is dropped silently.** The agent trims a probe to fit a message;
  the server logs (once a minute per host) any agent message it throws away.
- **Two agent windows on one PC don't fight:** the older one gets `4000`
  and stops.

Behavior to know about:

- Turning the auto-live switch off while the host is on air ends the TikTok
  live (the setup page says so).
- While the host is on air, a live ended directly in Studio is started again:
  to stop for good, stop the host.
- With scheduled hours, a manual stop holds for the rest of the window;
  editing the schedule lifts it. A start the schedule can't make (plan
  limit, no TikTok account) shows one notice per window.

## Remaining limits

- **Token auth.** If TikTok switches Studio to token auth, the agent can
  only report it (`authRequired`); tokens need an Elgato device plugged in.
- **The stage source's geometry** (scale, zoom, preview size) is copied from
  Studio 1.38.0 and assumes a portrait canvas.
- **The device token** sits in `%APPDATA%\Lantern\bridge.json` as plain
  text, readable by the Windows user who paired. Removing the PC in the
  dashboard revokes it.
- **Everything we automate is reported to TikTok** as Stream Deck usage.
