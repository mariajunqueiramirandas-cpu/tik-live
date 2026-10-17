# ADR-0026: The product is in Brazilian Portuguese

**Status:** Accepted
**Date:** 2026-10-17
**Deciders:** Project owner

## Context

The creators and audiences this product serves are Brazilian. The dashboard,
the stage, server messages and most presets were in English, the host
answered in whatever language a viewer wrote, and game boards mixed English
labels with Portuguese questions.

## Decision

Everything a creator or viewer sees or hears is in Brazilian Portuguese, with
no language switch:

- Dashboard, landing page, stage text (game boards, alerts, the AI
  disclosure "{nome} é uma IA"), API error messages, studio notices, runtime
  status, validation messages (a pt-BR error map for zod in
  `packages/shared/src/zod-pt-br.ts`), presets and the music library.
- The host speaks Brazilian Portuguese by default, whatever language a
  viewer writes in. A voice that only speaks another language still wins.
- Games are written in Portuguese, and the offline question bank defaults to it.
- Prompt-injection rules also catch Portuguese phrasings.
- Dates, times and numbers use the `pt-BR` locale.
- Terms and tone follow [docs/glossario.md](../glossario.md).

What stays in English: code, comments, logs, developer docs and ADRs, the
model-facing parts of prompts (the model reads English instructions best, and
is told to speak Portuguese), and stable codes in the API (`error.code`,
triage reasons), which the dashboard translates for display.

## Options considered

- **An i18n framework with English and Portuguese:** doubles every string to
  maintain and test, for an English audience nobody asked for. The strings stay
  in one place per component, so adding a framework later is mechanical.
- **Portuguese UI, host in the viewer's language:** Brazilian lives often have
  a few foreign viewers; a host switching languages mid-show sounds broken.

## Consequences

- Easier: one voice for the whole product; copy can be idiomatic instead of
  translated.
- Harder: Portuguese runs longer; narrow panes and stage boards were rechecked.
- Revisit: if the product launches outside Brazil, introduce message catalogs.
