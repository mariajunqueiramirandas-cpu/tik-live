# TikTok LIVE Studio

Creators who stream from TikTok LIVE Studio on Windows run the Local Bridge
Agent (`apps/bridge`, [ADR-0047](../adr/0047-bridge-agent-pairing-and-distribution.md))
next to it. The agent starts and ends the TikTok live with the show, and
drives scenes, vibes, highlights, recording, and camera effects from the
dashboard. It does this through the local control socket Studio runs for the
Elgato Stream Deck, plus one edit to Studio's saved scenes to add the stage.

| Page | What it covers |
|---|---|
| [Stream Deck protocol](stream-deck-protocol.md) | Studio's local control socket: connecting, events, all 32 action ids, the state snapshot, auth, quirks. Studied on 1.38.0 |
| [Our integration](our-integration.md) | How each of our features reaches Studio, how we detect success, timeouts, and the known problems |
| [New hooks](new-hooks.md) | What the socket offers that we don't use yet, ranked, with the show features each could become |

The two facts that matter most:

- **The socket controls the studio but doesn't see the audience.** It has
  no comments, gifts, likes, or viewer counts; those keep coming from our
  own TikTok LIVE connection.
- **Its terms aren't ours.** It's an undocumented interface for the Stream
  Deck plugin. TikTok can change it in any update, or switch on token auth
  remotely. After every Studio update, run `lantern-bridge.exe --check`
  and follow the re-check steps at the end of the protocol page.
