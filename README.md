# skills

Language-agnostic backend engineering skills for AI coding agents, packaged as a Claude Code plugin (`backend`) so they install on any machine without copying skill files into `~/.claude/skills`.

## What's inside

One plugin, one skill. `backend:backend-engineering` is the entry point: cross-cutting rules, a signal table that routes to the references, and 17 `references/` files (one per concern) that each follow the same shape: principles, design, traps, invariants to test, red flags, checklist.

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

## Install

```
/plugin marketplace add yusuf-cirak/skills
/plugin install backend@yusufcirak
```

## Version

Plugin/release: `0.0.1` (`plugins/backend/.claude-plugin/plugin.json`). Skill content: `1.1.0` (`metadata.version` in `SKILL.md`); the two are bumped independently.

## Layout

```
.claude-plugin/marketplace.json          marketplace "yusufcirak", lists plugin "backend"
plugins/backend/.claude-plugin/plugin.json
plugins/backend/hooks/hooks.json         SessionStart -> hooks/inject-router.js
plugins/backend/hooks/inject-router.js   emits the entry-point banner as additionalContext
plugins/backend/skills/backend-engineering/SKILL.md
plugins/backend/skills/backend-engineering/references/*.md
```

## Editing workflow

Edit the canonical copies under `plugins/backend/skills/...`, bump `version` in `plugins/backend/.claude-plugin/plugin.json`, commit, tag, then `/plugin marketplace update yusufcirak` on installed machines to pull the new version.
