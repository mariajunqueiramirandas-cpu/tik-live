# ADR-0048: One TikTok LIVE Studio client, one socket, no lost stops

**Status:** Proposed
**Date:** 2026-10-21
**Deciders:** Project owner

## Context

The Local Bridge Agent ([ADR-0047](0047-bridge-agent-pairing-and-distribution.md))
drives TikTok LIVE Studio through the local server Studio runs for the Elgato
Stream Deck ([protocol](../live-studio/stream-deck-protocol.md)). Reading
Studio's code and auditing ours turned up problems that could leave a
creator live on TikTok when they thought they had stopped, or let someone
else control their live:

- **The stage link could take over the agent's connection.** A stage-link
  agent replaced a paired one, and the stage link sits in OBS.
- **Stops could be lost.** When the agent was offline at stop time, the stop
  went nowhere and was never retried. Deleting a host disconnected the agent
  before asking it to stop.
- **One slow answer read as "Studio closed".** Stop then reported success
  without stopping, and Start opened a second copy of Studio.
- **Every command opened and closed a socket.** Studio stops sending state
  changes to *every* client when *any* socket disconnects, so we could never
  listen for changes, only poll.
- **Commands overlapped.** Start and end are the same toggle in Studio.
- **The stage source was written into a file Studio overwrites.** Studio
  reads `services.json` once at start-up and later writes its in-memory
  state back, so an edit made while it's open is lost.
- **Camera effects never worked.** We sent the category key; Studio matches
  the category name.
- **The client existed twice**, in the agent and in the server, and only the
  server's copy was tested.

## Decision

- **One client, in `packages/shared/src/live-studio`.** Exported as
  `@tik-live/shared/live-studio`, a Node-only subpath the web app never
  imports. The agent and the server's same-machine fallback both use it. It
  is tested against a mock Studio (`packages/shared/test/mock-live-studio.ts`)
  that reproduces Studio's room quirks.
- **One long-lived socket**, joined to Studio's Stream Deck room, holding the
  latest pushed snapshot. Refreshed every 20 s by leaving and re-joining,
  never by joining twice (Studio would register its action handler twice).
  The agent reports Studio's changes as they're pushed.
- **Know what state Studio is in:** closed, open but not answering, refusing
  us (token auth), or connected, using the process list and its listening
  ports. Only a closed Studio counts as "live ended"; Studio is opened only
  when it isn't running.
- **Commands run one at a time**; a stop cancels a start still waiting.
  Start presses the toggle a second time only when Studio rejected the first
  press.
- **The server owes a stop until the agent confirms it**, retrying when the
  agent reconnects and every 30 s while it reports the live still on.
  Deleting a host ends the PC's live first.
- **A stage link never controls a paired PC**: refused with `4009` while one
  is connected.
- **The stage source is written only while Studio is closed**, atomically,
  with a backup, and read back. With Studio open it waits and is written as
  soon as Studio closes. It only replaces our own "Vincular" source or one
  showing a stage link from the same app.
- **Going live runs in the background** on the server, with a deadline longer
  than the agent's own (135 s against 120 s), so the agent's answer decides.

## Consequences

- The agent sees Studio changes in under a second, and the dashboard can say
  why Studio isn't ready instead of "not connected".
- Adding a Studio feature means one change in `packages/shared` plus a case
  in the mock Studio.
- The agent keeps a socket open to Studio for as long as it runs. If the
  agent exits while a real Stream Deck is connected, Studio stops pushing to
  the Stream Deck until it re-joins. That was already true on every command
  before.
- "Configurar palco na cena" with Studio open now asks the creator to close
  Studio, and needs the agent left open until they do.
- Token auth is detected, not supported: if TikTok switches it on, the agent
  reports it and stops trying.
