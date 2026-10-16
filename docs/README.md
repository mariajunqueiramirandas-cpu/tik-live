# Documentation

tik-live (working name Lantern) is a hosted SaaS: creators sign up, design an
AI host character, connect their TikTok account, and the platform runs the
show for them. Everything the ADRs describe is built; what's left for the
owner to decide is in [decisions needed](decisions-needed.md).

| Document | What it covers |
|---|---|
| [Decisions needed](decisions-needed.md) | Owner-only choices (prices, models per plan, sign-in provider, legal) with the defaults the code uses meanwhile |
| [Architecture overview](architecture/overview.md) | Goals, requirements, system and container diagrams, key flows, data model, repository layout |
| [Implementation plan](architecture/plan.md) | Phases, deliverables, exit criteria, migration from v0.1, risks, open questions |
| [Architecture decision records](adr/README.md) | One record per significant decision, with the options we weighed |
| [HTTP API](api.md) | Every endpoint, the error shape, authentication, the broadcaster's internal API |
| [Realtime protocol](protocol.md) | Stage and studio WebSocket messages, lifecycle and close codes |
| [Deployment runbook](../deploy/README.md) | Install, configure, upgrade, roll back, back up, restore, harden |
| [Contributing](../CONTRIBUTING.md) | Dev setup, scripts, testing rules, conventions, the ADR process |

All ADRs are **Proposed** until the project owner accepts them. Once accepted,
an ADR is not edited; a later ADR supersedes it.
