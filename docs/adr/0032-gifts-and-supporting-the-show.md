# ADR-0032: Bigger gift moments, and how viewers can support the show

**Status:** Proposed
**Date:** 2026-10-18
**Deciders:** Project owner
**Amends:** ADR-0012 (the host's gift rules), ADR-0016 (the moderator's policy on asking for gifts)

## Context

The owner wants gifts to feel far more rewarding, wants the host to talk
about gifts, and wants viewers to know the host is an AI that costs money
to run and how they can help: following, liking, sharing and gifting. The
owner also wants the option of a host that asks for gifts openly.

Until now the system prompt said "never ask for gifts", and the moderator
blocked any line that asked for gifts. TikTok's guidelines prohibit
"exploitative begging" on LIVE, and gifting is only open to adults, though
teens may be watching.

## Decision

### Gifts get a real moment

- The system prompt makes every gift a moment: the gifter's name, what
  they sent, something personal (a callback, a playful title), now and then
  a word that gifts help pay for the AI. Viewers whose memory says they've
  gifted before are treated as VIPs.
- A gift of **100 diamonds or more** is a `big gift` in the brief, and the
  brief asks for it to be the turn's highlight, with an effect tag.

### The support card and the host's explanation

- A new stage message, `support`, shows an "Apoie a live" card in the
  ranking card's place: "<host> é uma IA ao vivo", then like, follow, share
  and gift, each with its icon. An open vote stays on top of it.
- The director puts it up for 20 s a few minutes into the stream and then
  every few minutes. Less often, in a quiet moment (a filler), or on the
  busy-chat show turn (ADR-0031), the host explains it in its own words,
  with the card up: it's an AI, its voice and brain cost money every minute,
  likes, follows and shares help the live grow, and gifts help pay for it.
- `persona.support` turns both off (on when unset).

### How actively the host asks: `safety.giftAsks`

| | Light (default) | Active |
|---|---|---|
| Card | every 8 min | every 5 min |
| Host explains / asks | every 20 min | every 8 min |
| Asking for gifts | only as a general explanation; never by name | openly and often, by name too |
| Rewards for gifts | none promised (game power-ups are the game's) | playful, on-stream ones: a shout-out, a song, a title, an effect |

Both modes keep these lines, in the prompt and in the moderator's policy:
no guilt-tripping, no claims that the AI will be shut down, suffer or
disappear without gifts, no pressing someone who said they can't, and no
promises off-stream or of real-world value. Those are deception or
pressure rather than asking, and they're what TikTok enforces against.

## Consequences

- The owner chooses the trade-off per channel. Active mode is more
  likely to draw TikTok enforcement; the safety page says so.
- The moderator no longer blocks a general "gifts help pay for the AI"
  line, and in active mode it allows direct asks.
