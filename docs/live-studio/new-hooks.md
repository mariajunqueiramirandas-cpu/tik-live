# New hooks into TikTok LIVE Studio

What the Stream Deck socket offers that we don't use yet, and what each
could become in the show. Ranked by value for an AI-hosted live. Protocol
details are in [stream-deck-protocol.md](stream-deck-protocol.md); none of
these actions has been sent to a real Studio yet, so each needs a supervised
test before it ships.

Two limits shape everything below:

- **The socket controls the studio; it doesn't see the audience.** Comments,
  gifts, likes, and viewers keep coming from our own TikTok LIVE connection.
  The pattern is: the show decides, the bridge makes Studio act.
- **Everything we automate is reported to TikTok** as Stream Deck usage.
  Keep automated actions at a human-like pace.

## 1. Keep one socket open and listen (foundation)

Today every command opens and closes a socket, and the bridge polls every
3 s. Studio already pushes the full snapshot on every change, so one
long-lived, joined socket per agent would give us:

- Instant status: going live, pausing, ending, scene changes, mute changes
  reach the server in under a second instead of 3–10 s.
- No false "Studio closed" from a slow probe, which today can make Stop lie
  and Start open a second Studio (see
  [our-integration.md](our-integration.md), problem 4).
- No more interrupting Studio's pushes: every close currently runs Studio's
  `stopListening()` for all clients.

Needed: reconnect with re-`join_room`; re-join after any other client (such
as a real Stream Deck) disconnects; retry `sync_settings` while the snapshot
is empty during Studio's start-up; one command queue so toggles never
overlap. This is the prerequisite for most items below.

## 2. Check that the stage is actually on air and audible

`scene_list` tells us whether the "Vincular" source is in the current scene
and visible; `audio_control.audioList` includes visible sound-capable
sources with `volume` and `isMute`. Together they answer the question we
can't answer today: is the viewer seeing and hearing the host?

- Health check on the setup page and in Health: "Stage hidden", "Stage
  muted in Studio", "Stage volume at 20%".
- Auto-fix with the owner's permission: `source` to show it again,
  `audiocontrol` with `mutationValue` to restore volume.
- Replaces the current "configured" badge, which only reads
  `services.json`.

## 3. Studio sound effects on show moments

`soundeffect` plays Studio's 18 built-in effects (pt-BR names: Torcida,
Palma, Risada, Tambor, Suspense, Triunfo, Falha, Uau, Glória…). They're
mixed by Studio, so they work even if the stage audio is quiet, and cost us
no assets or licensing.

- Gift hype mode ([ADR-0046](../adr/0046-gifts-first-and-hype-mode.md)):
  Torcida or Glória on big gifts, Uau on a new top gifter.
- Games and challenges: Tambor or Suspense before a reveal, Triunfo or Falha
  on the result.
- Gift powers ([ADR-0039](../adr/0039-gift-powers.md)): a fanfare when
  someone takes the "Dono da live" crown.

Caveats: names are localized (read them from `sound_effect.sound_Info`, map
by position or keep a per-language table); an effect plays only once its
file is downloaded; respect a cooldown so the host's voice isn't buried.
Decide per moment whether the stage or Studio plays the sound, never both.

## 4. Audio mix control

`audiocontrol` / `miccontrol` set an absolute volume (`mutationValue`,
most likely 0–1) or toggle mute for one output, input, or audio source;
`audio` / `mic` toggle all outputs or all inputs.

- Duck the creator's other sources (game audio, a music app) while the host
  talks, and restore afterwards. Our own DJ already ducks inside the stage.
- Mute the creator's real mic when the AI is hosting alone, so room noise
  and echo don't reach the live; unmute when a human takes over.

Caveats: the ack returns before the change is confirmed, so read the next
snapshot; mute actions are toggles, so read `isMute` first; device ids come
from the snapshot and change when devices change.

## 5. Smarter highlights

Already wired, but blind. Gate on `highlight_able` (in every snapshot), hide
the button when it's false, and trigger automatic clips on peaks we already
detect: a gift burst, a won challenge, a coup for the crown. Today a failed
automatic attempt still uses up the 60 s cooldown.

## 6. Scene and camera choreography

Scenes, source toggles and camera effects already work as buttons. New is
driving them from the show:

- One Studio scene per segment or game in the run of show
  ([ADR-0035](../adr/0035-automatic-run-of-show.md)), switched
  automatically.
- A camera effect while a gift power is active, removed when it ends (the
  action is a toggle: sending the same effect again removes it).
- Let the owner pick the camera source; `camera_effect.sourceList` is
  already in the snapshot.

## 7. Greeting wave for passers-by

`sayhi` sends Studio's wave greeting, which **viewers see**. It fits the
calls to passers-by ([ADR-0037](../adr/0037-fan-levels-and-passers-by.md))
when viewer count jumps. It must be rate-limited and off by default.

## 8. Viewer wishes

`viewerWishesOngoing` is in the snapshot and `viewerwishes` toggles it. The
host could open and close wishes as a segment and talk about them. Only
useful if the creator has the feature set up in Studio.

## Low value

- `vote`, `cohost`, `multiguest`, `promote`, `treasurebox`, `team`,
  `gamepad`, `guessgame`, `goodybag`, `livegoal`, `playtogether`,
  `recordinggallery` only open a panel in Studio for a person at the PC. A
  "Studio shortcuts" panel in the dashboard is the most they're good for.
- `audiofilter` (voice presets) depends on the Studio UI language.

## Hardening to do alongside

- Support Studio's token mode before TikTok turns it on: detect the
  `44{"message":"invalid"}` refusal and report "Studio changed how it
  accepts connections" instead of "not connected".
- Move the Studio client into one shared module so the bridge and the
  server stop carrying separate copies, and give it a socket-level test
  against a mock that pushes status changes and acks every action.
