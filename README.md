# tik-live

A fully autonomous AI host for TikTok LIVE. A character (by default **Blip**, a
small glowing orb) reads your live chat, thanks gifts, remembers regulars, runs
show segments, and keeps talking when chat goes quiet. You can leave it running
without anyone at the keyboard.

```
TikTok LIVE ──(chat, gifts, likes, follows, joins)──► Triage
   spam / links / prompt-injection filter, priority scoring, expiry
        │
        ▼
   Director ── run-of-show: opening → reactions → milestones → segments → dead-air filler
        │
        ▼
   Host brain (Claude, streamed sentence by sentence)
        │
        ▼
   Safety gate (rules + LLM moderator) ∥ Text-to-speech   ← run in parallel, no added latency
        │
        ▼
   Stage (browser source: character, captions, gift alerts, audio)
        │
        ▼
   OBS ──RTMP──► TikTok           Supervisor keeps OBS streaming; control panel has a kill switch
```

## Quick start (no accounts needed)

```bash
npm install
npm run dev
```

Open:

- **Stage** at http://127.0.0.1:4545/stage/. This is what viewers see.
- **Control panel** at http://127.0.0.1:4545/control/, with a live preview, a
  transcript, the queue of things the host may react to, a kill switch, and a
  form to send fake chat and gifts.

With no `.env` the engine uses a **simulated audience** and an **offline
scripted host**, so you can see the whole loop working before you connect
anything.

## Turn on the real brain and voice

```bash
cp .env.example .env
```

- `ANTHROPIC_API_KEY` switches the host to Claude. Each turn is one streamed
  request: speech starts on the first sentence while the rest is still being
  written.
- `TTS_PROVIDER=elevenlabs` with `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`
  gives the character a voice. Without it, the character talks in captions.

## Going live on TikTok

1. **OBS:** set the canvas and output to **1080x1920**, 30 fps.
2. Add a **Browser** source with URL `http://127.0.0.1:4545/stage/`, size
   1080x1920, and tick **Control audio via OBS** so the voice goes into the
   stream.
3. **Stream key:** in OBS go to Settings > Stream, choose Custom, and paste the
   server URL and stream key from TikTok LIVE Producer
   (livecenter.tiktok.com/producer). Stream keys aren't available on every
   account or in every region.
4. **Hands-free streaming (optional):** enable OBS > Tools > WebSocket Server
   Settings and set `OBS_WS_URL` / `OBS_WS_PASSWORD`. The engine then starts
   the stream itself, restarts it if it drops, and reports congestion and
   dropped frames.
5. Set `TIKTOK_USERNAME` to your handle and run `npm run build && npm start`.

When connected to TikTok, the host waits in standby until your stream is live
and audience events arrive, so it never talks to an empty room. When the
stream ends it goes back to standby and reconnects for the next one.

## Safety

One bad sentence on stream can get an account banned, so safety is layered:

1. **Input triage:** drops links, contact info, spam, floods, blocklisted
   terms and prompt-injection attempts ("ignore your instructions…") before the
   model ever sees them.
2. **Prompt hygiene:** viewer names and messages are escaped and passed as
   untrusted data. Manipulative or blocklisted nicknames are replaced with
   "friend".
3. **Output gate:** every sentence must pass the rules and a Claude moderator
   before it can be spoken. It fails closed by default: if the moderator is
   down, the sentence is dropped.
4. **Kill switch:** **Pause host** in the control panel stops speech
   immediately. **Skip line** cuts only the current line.

Add your own never-say terms to `config/blocklist.txt`.

## Platform notes

- Chat and gift events come from
  [tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector),
  an **unofficial**, reverse-engineered library. It can break when TikTok
  changes things; the normalizer reads every known field spelling so a change
  drops events instead of crashing the show.
- The stage always shows an "is an AI host" label, and the character admits
  it's an AI when asked. Keep both: TikTok has rules on labeling AI-generated
  content, and being upfront keeps viewers' trust.
- TikTok Shop livestreams ban AI voices. This project is meant for regular
  LIVE. Check TikTok's current LIVE guidelines before running it unattended.

## Make it yours

Everything about the character lives in `personas/blip.json`: name,
personality, speaking style, extra rules, the segment rotation with what to do
in each, and colors. Set `"visual": { "mode": "none" }` for a voice-only show
with a glowing voice line instead of a character.

## Development

```bash
npm run check      # typecheck + tests
npm test           # tests only
```

Code map:

| Path | What it does |
|---|---|
| `src/events/` | TikTok connector, simulator, payload normalization |
| `src/brain/triage.ts` | Filters and ranks audience events |
| `src/brain/director.ts` | Decides when the host talks and about what |
| `src/brain/host.ts` | Claude host (streaming) and offline scripted host |
| `src/brain/prompt.ts` | System prompt (cached) and per-turn context |
| `src/brain/memory.ts` | Remembers viewers across streams |
| `src/safety/` | Input rules, output rules, LLM moderator |
| `src/voice/` | TTS providers and the ordered speech pipeline |
| `src/stage/server.ts` | Serves stage and control panel, WebSocket protocol |
| `src/obs/supervisor.ts` | Keeps OBS streaming |
| `public/stage/` | Character renderer (canvas), captions, alerts |
| `public/control/` | Operator control panel |

Every session is logged to `data/sessions/*.jsonl` (events, turns, spoken and
blocked lines), which is the raw material for the analytics below.

## Roadmap

- **Self-improving show:** score each segment and persona variant by retention
  and gifts per minute from the session logs, and rotate toward what works.
- **Smarter memory:** have the model write short notes about viewers ("loves
  ducks", "studying for exams") and recall them later.
- **Interactive games:** chat votes, gift-triggered events and "chat plays"
  mini-games drawn on the stage.
- **Auto-clipping:** detect high-engagement moments and cut vertical clips to
  post as regular TikToks.
- **Headless mode:** render the stage in headless Chromium and push straight to
  RTMP with FFmpeg, so no OBS or desktop is needed. A Rust + GStreamer media
  worker can take over here once you run many channels.
- **Richer avatar:** VRM/Live2D characters with viseme lip sync.
