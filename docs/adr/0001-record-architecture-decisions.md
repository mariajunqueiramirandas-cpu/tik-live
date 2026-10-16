# ADR-0001: Record architecture decisions

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

The project is moving from a single-user prototype to a SaaS with a backend,
a realtime engine, a React dashboard and paid plans. Decisions about runtime,
data, security and deployment will outlive the conversations that produced
them, and future contributors (people and AI agents) need to know why things
are the way they are before changing them.

## Decision

Keep architecture decision records in `docs/adr/`, one Markdown file per
decision, numbered sequentially (`NNNN-short-title.md`), using this structure:
Status, Date, Deciders, Context, Decision, Options Considered (with an
assessment table per option), Trade-off Analysis, Consequences, Action Items.

- New ADRs start as **Proposed** and become **Accepted** when the project
  owner approves them (a PR review approval counts).
- Accepted ADRs are never rewritten. A change of direction is a new ADR that
  marks the old one **Superseded by ADR-NNNN**.
- Every PR that makes a significant architectural change links the ADR it
  implements, or adds one.

## Options Considered

### Option A: ADRs in the repository (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | None |
| Scalability | Works for any team size |
| Team familiarity | Widely used format |

**Pros:** versioned with the code; reviewed in PRs; readable by agents working in the repo.
**Cons:** needs discipline to keep the index current.

### Option B: A wiki or external doc tool

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Possibly a paid tool |
| Scalability | Fine |
| Team familiarity | Varies |

**Pros:** rich editing and comments.
**Cons:** drifts from the code; invisible to code review and to coding agents.

## Trade-off Analysis

Decisions live closest to the code that implements them. Discoverability is
better in a wiki, but drift costs more over time.

## Consequences

- Easier: onboarding, reviewing changes against intent, and reversing a
  decision deliberately rather than by accident.
- Harder: small overhead per significant change.

## Action Items

1. [x] Create `docs/adr/` with an index.
2. [x] Link the relevant ADRs from each implementation PR (PR #1 links them).
