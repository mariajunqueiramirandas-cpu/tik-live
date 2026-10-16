# ADR-0005: PostgreSQL, Drizzle ORM and PGlite

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

v0.1 kept viewer memory in a JSON file and session logs in JSONL. A SaaS needs
durable, concurrent, queryable storage for:

- accounts and sessions;
- channels and their configuration (persona, voice, safety, broadcast settings);
- viewer memory per channel, which can reach tens of thousands of viewers per channel;
- analytics: stream sessions, per-minute samples, spoken and blocked lines;
- usage metering and billing state.

Writes are bursty: a popular stream produces many events per second.
Developers should be able to run the stack without installing a database, and
tests should get a real database without Docker.

## Decision

- **Production database:** PostgreSQL 17, in the compose stack.
- **ORM and migrations:** Drizzle ORM with `pg-core` schemas in
  `apps/server/src/db/schema/`. drizzle-kit generates SQL migrations that are
  committed to `apps/server/drizzle/`.
- **Drivers:**
  - production: `drizzle-orm/bun-sql` (Bun's native Postgres client);
  - fallback: `drizzle-orm/postgres-js` if `Bun.SQL` shows problems in staging;
  - development and tests: `drizzle-orm/pglite`. This is real Postgres compiled
    to WASM and run in-process, file-backed in `.data/` for `bun run dev` and
    in-memory per test file.
- **Migrations at boot:** the app runs pending migrations on startup while
  holding a Postgres advisory lock, so two instances never migrate at once.
  Destructive changes follow expand, then migrate, then contract across
  releases.
- **Auth tables** (`user`, `session`, `account`, `verification`) come from
  Better Auth's Drizzle schema generator, so they live in the same migration
  history ([ADR-0006](0006-authentication.md)).

### Product schema (v1)

| Table | Key | Purpose | Notes |
|---|---|---|---|
| `channel` | `id` (UUIDv7) | A host configuration owned by a user | `owner_id`, `name`, `tiktok_username`, `persona` jsonb, `voice` jsonb, `safety` jsonb, `broadcast` jsonb (stream key encrypted), `desired_state` (`stopped` / `running`), `source` (`tiktok` / `simulator`), `stage_key_lookup` (HMAC, unique), `stage_key_ciphertext` |
| `viewer` | (`channel_id`, `platform_user_id`) | Viewer memory | `handle`, `nickname`, `first_seen_at`, `last_seen_at`, `visits`, `messages`, `diamonds`, `gifts` jsonb, `follows`, `shares`, `recent_lines` jsonb, `notes` jsonb; index on (`channel_id`, `diamonds` desc) |
| `stream_session` | `id` | One continuous live session | Totals: peak viewers, likes, diamonds, gifts, messages, follows, shares, turns, spoken lines, blocked lines, tokens, TTS characters; `ended_at`, `end_reason` |
| `session_sample` | (`session_id`, `minute`) | Per-minute time series | `viewers`, `likes`, `messages`, `diamonds` |
| `utterance` | `id` (bigserial) | Spoken and blocked host lines | `session_id`, `at`, `text`, `emotion`, `status`, `reason`, `turn_kind`; purged after the plan's retention window |
| `usage_daily` | (`user_id`, `channel_id`, `day`) | Metering | LLM requests and tokens (input, cached input, output), moderation requests, TTS characters, runtime seconds, broadcast seconds |
| `subscription` | `user_id` | Billing state mirrored from Stripe | `plan`, `status`, `stripe_customer_id`, `stripe_subscription_id`, `current_period_end`, `cancel_at_period_end` |
| `stripe_event` | `id` | Webhook idempotency | `processed_at` |
| `audit_log` | `id` | Security-relevant actions | `user_id`, `action`, `target`, `meta` jsonb, `ip`, `at` |

All channel-scoped tables cascade on channel delete. Every query in the
repository layer takes the acting `user_id` and scopes by ownership
([ADR-0016](0016-security.md)).

### Write strategy for hot paths

| Data | Strategy |
|---|---|
| Viewer memory | In-memory cache per running channel; dirty records are upserted in batches every 5 s and on stop |
| Session samples | Accumulated in memory and written once per minute |
| Utterances | Queued and inserted in batches every 2 s |
| Usage | Accumulated in memory and upserted with increments every 60 s and on stop |
| Session totals | Updated every minute and finalized on stop |

The runtime never awaits the database on the chat-to-speech path.

## Options Considered

### Option A: PostgreSQL + Drizzle + PGlite for dev and tests (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: one ORM and two drivers that share one dialect |
| Cost | Postgres is free; about 200 MB of RAM in compose |
| Scalability | Handles our write volume with batching; standard replicas and backups |
| Team familiarity | High: SQL plus typed schemas |

**Pros:** the same SQL dialect everywhere (PGlite is Postgres); typed queries;
committed SQL migrations; JSONB for persona documents; `pg_dump` backups.
**Cons:** two drivers to keep in sync (mitigated: both are first-class
Drizzle drivers, and the full test suite runs on PGlite); Postgres is one more
container to operate.

### Option B: SQLite (`bun:sqlite`) + Drizzle

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Lowest (a file) |
| Scalability | One writer at a time; fine for one box, hard to scale out |
| Team familiarity | High |

**Pros:** zero ops; extremely fast reads; trivial dev setup.
**Cons:** a single writer is contended by many busy channels; the path to
more than one app instance is a migration; weaker JSON tooling.

### Option C: PostgreSQL with raw SQL and a hand-written migrator

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Free |
| Scalability | Same as A |
| Team familiarity | High |

**Pros:** no ORM abstraction.
**Cons:** no compile-time checking of queries against the schema; more
boilerplate per table.

### Option D: Prisma

| Dimension | Assessment |
|---|---|
| Complexity | Medium-high |
| Cost | Free |
| Scalability | Good |
| Team familiarity | Medium |

**Pros:** mature tooling and Studio UI.
**Cons:** heavier runtime; generated client step; less direct SQL control on
hot paths.

## Trade-off Analysis

SQLite would be simpler on day one, but a SaaS whose value is "many channels
running at once" will hit its single-writer limit exactly when it succeeds.
Postgres keeps the scale-out path open. PGlite removes Postgres's usual
developer tax (no Docker needed to run or test), so we get production parity
without setup cost.

## Consequences

- Easier: realistic tests on the real dialect; safe schema evolution; analytics queries in plain SQL.
- Harder: hot-path batching adds code that must flush correctly on shutdown (covered by tests).
- Revisit: move metering and analytics to a time-series store only if `session_sample` grows past about 100M rows.

## Action Items

1. [ ] Define the Drizzle schema and generate the first migration (including the Better Auth tables).
2. [ ] Implement `createDb()` that returns a Bun.SQL- or PGlite-backed Drizzle instance from `DATABASE_URL` (`postgres://…` or `pglite://path` or `pglite://memory`).
3. [ ] Migrate at boot under an advisory lock; add a test helper that creates a migrated in-memory PGlite per test file.
4. [ ] Implement write-behind stores (viewers, samples, utterances, usage) with flush-on-stop tests.
5. [ ] Add a nightly retention job for `utterance` and expired sessions.
