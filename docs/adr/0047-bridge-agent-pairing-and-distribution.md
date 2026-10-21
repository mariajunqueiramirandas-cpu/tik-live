# ADR-0047: Pairing and handing out the Local Bridge Agent

**Status:** Proposed
**Date:** 2026-10-21
**Deciders:** Project owner

## Context

The Local Bridge Agent (`apps/bridge`, `lantern-bridge.exe`) runs on the
creator's Windows PC and starts and ends the live in TikTok LIVE Studio when
the host goes on and off air. It connects out to the app over a WebSocket.

When it shipped, it had three problems:

- **Nobody could download it.** The dashboard's download button served
  `apps/bridge/dist/lantern-bridge.exe`, but the app image never built it, so
  the button returned 404 in production. And the build script didn't name a
  target, so building on a Linux or macOS machine made an executable for that
  system with a `.exe` name.
- **It used the stage link as its credential** (`/ws/bridge/<stageKey>`). The
  stage link is pasted into OBS and is easy to leak, and with this design
  anyone holding it could also start and end the creator's TikTok live.
  Rotating the link to shut that out also broke the agent.
- **Setup meant pasting a long URL into a console window**, which is where
  creators get stuck.

The owner asked for the download to work from the dashboard, for a way to
compile it, and for a pairing code system, and asked whether each account
could get its own binary.

## Options for a binary per account

1. **Compile per account on demand.** Each download runs `bun build
   --compile` with the account's details baked in. That takes seconds of CPU
   and around 86 MB of disk per build, needs the Bun toolchain and network on
   the app server, and would rule out code signing later (every file would
   be different).
2. **Put the details in the file name** (`lantern-bridge-ABCD2345.exe`).
   Browsers rename duplicates (`(1)`), and people rename files.
3. **Stamp one build per download.** Bun's Windows executables keep their
   code in a `.bun` PE section. Bytes added after the last section (the PE
   "overlay") are ignored by Windows and by Bun. The server streams the same
   build to everyone, then adds a small trailer with the app's address and a
   fresh pairing code.
4. **One generic binary, paired by typing a code.** Simple, but it's one more
   step on every first run.

## Decision

We do **3 and 4 together**: one build. The dashboard's copy is stamped and
pairs itself on first run. A generic copy (from a GitHub release, or a
stamped one whose code expired) pairs with a code typed into the agent.

### Pairing

- The owner asks for a code (`POST /api/channels/:id/live-studio/pairing`),
  or downloads the agent, which makes one. A code is **8 characters** from
  `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0/O or 1/I/L, about 40 bits), shown as
  `ABCD-2345`. It works **once**, for **15 minutes**.
- Codes are stored only as an HMAC (`Secrets.lookup`, the way stage keys
  are) in `bridge_pairing`. Claiming a code deletes its row in the same
  statement, so the same code can't be used twice.
- The agent sends the code and the PC's name to `POST /api/bridge/pair`
  (unauthenticated, at most **20 attempts per address per 10 minutes**). In
  return it gets a **device token** (`lbt_` plus 32 random bytes), stored as
  an HMAC in `bridge_device` along with the channel and the PC's name.
- From then on the agent connects to **`/ws/bridge` with `Authorization:
  Bearer <token>`**, so the token never appears in a URL or a proxy log. An
  unknown or removed token is accepted and then closed with code **4003**,
  which tells the agent to forget its token and ask for a new code (a
  refused upgrade would look like a network error and be retried forever).
- A host can have several paired PCs, but **one connects at a time**. A
  second PC is closed with **4009** while the first is connected, and retries
  every 30 seconds. The same PC reconnecting replaces its own old socket.
  Before this, two agents left open kicked each other off every few seconds.
- The dashboard lists paired PCs (connected now, or last seen) and can
  **remove** one: its row is deleted and its socket closed with 4003.
- Rotating the stage link no longer touches paired agents.
  `/ws/bridge/<stageKey>` stays for agents from before pairing. The dashboard
  no longer offers it, and pasting a stage link at the agent's prompt still
  works.

### The stamp

`<JSON {server, code}><u32 little-endian JSON length>LANTERN-BRIDGE-STAMP/1`,
added after the executable. It's encoded and decoded in `packages/shared` so
the server and the agent can't disagree. The agent reads the last 8 KB of its
own file. It remembers which stamped code it used (`usedCode`), so a copy
doesn't retry a spent code on every run.

The stamp holds only a 15-minute, single-use code, never a lasting
credential. A copy shared or found later can't pair once the code is used
or expired.

### Building and handing it out

- `apps/bridge` builds with `--target=bun-windows-x64`, so it cross-compiles
  from any OS. CI builds it on Linux as part of `bun run build`.
- **The app image builds it** and sets `BRIDGE_EXE_PATH`. The server streams
  it plus the stamp (pull-based, so memory stays flat). Bun sends a streamed
  body chunked, without `Content-Length`, so `/api/config` reports the file's
  size (`bridge.bytes`) and the dashboard shows it next to the button.
  `bridge.download` is false when the server has no build, and the dashboard
  then points to the release instead.
- **Tagged releases** (`v*`) attach the generic `lantern-bridge.exe` to the
  GitHub release. Pushes to `main` upload it as a 7-day workflow artifact.
- On the PC the token is saved in `%APPDATA%\Lantern\bridge.json`, not next
  to the executable in Downloads.

## Consequences

- The app image grows by about 86 MB (mostly Bun's Windows runtime), and
  building it needs network access to fetch that runtime.
- The executable isn't code-signed, so Windows SmartScreen warns on first
  run. The dashboard explains how to get past it (*Mais informações →
  Executar assim mesmo*). Signing it later still works with stamping: the
  stamp would need to go inside the signature (for example as an
  unauthenticated attribute) or the server would sign each copy. Until then,
  avoid anything that would break a future signature.
- Removing a PC or deleting the host makes the agent go back to asking for a
  code, without closing its window.
- Before this change, the agent's reconnect timer didn't keep its process
  alive, so it quit silently when the server was unreachable at start. It
  now keeps retrying.
