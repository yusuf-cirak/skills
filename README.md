# skills

Personal coding standards for AI coding agents, packaged as Claude Code plugins in one marketplace (`yusufcirak`) so they install on any machine without copying skill files into `~/.claude/skills`.

| Plugin | Scope |
|---|---|
| `dotnet` | C# / .NET / ASP.NET Core coding standards: a 7-skill family behind the `dotnet:csharp` entry point |
| `backend` | Language-agnostic backend engineering rules and traps: one skill (`backend:backend-engineering`) with 17 references |

## Install

```
/plugin marketplace add yusuf-cirak/skills
/plugin install dotnet@yusufcirak
/plugin install backend@yusufcirak
```

Previously installed from the old `yusuf-cirak/csharp-skills` repo? The marketplace key (`yusufcirak`) is the same, so remove the old registration first:

```
/plugin uninstall dotnet@yusufcirak
/plugin marketplace remove yusufcirak
/plugin marketplace add yusuf-cirak/skills
/plugin install dotnet@yusufcirak
/plugin install backend@yusufcirak
/reload-plugins
```

## Plugin `dotnet`

A 7-skill family. `dotnet:csharp` is the entry point: core style rules, a signal table that routes to the sibling skills, and the shared `references/`:

| Skill | Scope |
|---|---|
| `dotnet:csharp` | Entry point + core style: namespaces, immutable records + factories, DUs, value objects, `Result<T>`; signal table to the siblings; `references/` for LINQ, performance, async, composition, EF, caching |
| `dotnet:ddd` | DDD tactical patterns, Modular Monolith + Vertical Slice layout |
| `dotnet:web-api` | Endpoint/handler/slice shape, MediatR/FastEndpoints, FluentValidation basics, pagination |
| `dotnet:validation` | `InputLimits`, length-typed `Text` VOs, validator rules, JSON/Kestrel hardening, output encoding |
| `dotnet:hardening` | Rate limiting, idempotency, authn/authz, headers, crypto, EF hardening, SSRF, observability, CI |
| `dotnet:observability` | OpenTelemetry traces/metrics/logs, health probes, SLOs |
| `dotnet:testing` | xUnit + Shouldly + NSubstitute + Testcontainers + Bogus + NetArchTest |

Shared `references/` (single source of truth) live under `csharp/references/`. Cross-skill links are **relative** (`../csharp/references/...`) so they resolve both as a plugin and as loose `~/.claude/skills`.

The plugin's SessionStart hook (`plugins/dotnet/hooks/inject-router.js`) injects the `dotnet:csharp` entry point into every session. A global `~/.claude/CLAUDE.md` block that names `dotnet:csharp` is **user config**, not a plugin artifact — keep it in your own dotfiles as an optional second reinforcement.

`/wrap-session-lessons` (`plugins/dotnet/commands/`) extracts reusable lessons from a session and files them into the right skill.

### opencode

These same skills work in [opencode](https://opencode.ai) — it reads `SKILL.md` natively and has a `skill` tool. See [`opencode/README.md`](opencode/README.md) to sync the skills into opencode and enable the same auto-routing via the `dotnet-router.js` plugin or `AGENTS.md`.

## Plugin `backend`

One skill. `backend:backend-engineering` is the entry point: cross-cutting rules, a signal table that routes to the references, and 17 `references/` files (one per concern) that each follow the same shape: principles, design, traps, invariants to test, red flags, checklist.

| Reference | Scope |
|---|---|
| `architecture-modular-monolith` | Module boundaries, dependency direction, registration, cross-module calls |
| `ddd-tactical` | Aggregates, entities, value objects, typed ids, domain events |
| `cqrs-use-case-pipeline` | Use-case structure, handler pipeline, behavior order |
| `error-model` | Errors as values vs exceptions, wire error format |
| `outbox-inbox-messaging` | Transactional outbox, CDC/relay, idempotent consumers |
| `idempotency-locking-concurrency` | Idempotency keys, distributed locks, lost updates |
| `persistence-migrations` | ORM conventions, tracking, transactions, migrations on rolling deploy |
| `multi-tenancy` | Tenant resolution, row-based isolation |
| `rate-limiting-load-shedding` | Throttling, abuse protection, 429/503 |
| `caching` | L1/L2 caching, stampedes, stale data |
| `resilience-lifecycle` | Timeouts, shutdown, health probes, fail-open/closed table |
| `security-hardening` | Authn/authz, tokens, headers, CORS, proxies, PII in logs |
| `untrusted-input-outbound` | User-supplied URLs/files/XML/SQL fragments, SSRF, LLM input |
| `observability` | Logs, metrics, traces, correlation ids |
| `testing-strategy` | Test tiers, real-infra integration tests, flaky state |
| `build-ci-performance` | Warnings policy, dependency pinning, CI gates, perf work |
| `api-surface` | Versioning, pagination contract, feature flags, route opt-ins |

The plugin's SessionStart hook injects a short banner telling the agent to invoke `backend:backend-engineering` before the first edit on backend work and to open every reference whose signal matches.

## Layout

```
.claude-plugin/marketplace.json          marketplace "yusufcirak", lists plugins "dotnet" and "backend"
plugins/dotnet/.claude-plugin/plugin.json
plugins/dotnet/hooks/                    SessionStart -> inject-router.js
plugins/dotnet/commands/                 /wrap-session-lessons
plugins/dotnet/skills/<skill>/SKILL.md   csharp (entry) + ddd, web-api, validation, hardening, observability, testing
plugins/dotnet/skills/csharp/references/*.md
plugins/backend/.claude-plugin/plugin.json
plugins/backend/hooks/                   SessionStart -> inject-router.js
plugins/backend/skills/backend-engineering/SKILL.md
plugins/backend/skills/backend-engineering/references/*.md
opencode/                                opencode sync script, router plugin, AGENTS.md fallback (dotnet)
scripts/validate_skills.py               skill frontmatter / length checks (dotnet)
```

## Versions

Each plugin has its own `version` in `plugins/<plugin>/.claude-plugin/plugin.json`; the `backend` skill also carries a `metadata.version` in its `SKILL.md`, bumped independently.

## Editing workflow

Edit the canonical copies under `plugins/<plugin>/skills/...`, bump `version` in that plugin's `.claude-plugin/plugin.json`, commit, then `/plugin marketplace update yusufcirak` on installed machines to pull the new version. For `dotnet`, `python scripts/validate_skills.py` checks the skills before committing.
