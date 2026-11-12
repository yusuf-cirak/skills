---
name: backend-engineering
description: >-
  Language-agnostic backend engineering rules and traps for production services.
  Use when designing or reviewing a backend service, modular monolith, or API in
  any language (Go, Rust, TypeScript, C#, ...): module boundaries, DDD
  aggregates and value objects, CQRS pipelines, error modeling, transactional
  outbox/inbox, idempotency, distributed locks, multi-tenancy, rate limiting,
  caching, resilience, security hardening, observability, migrations, testing
  strategy, build/CI hygiene. Don't use for language idioms (use the language
  skill), HTTP contract design details (use api-and-interface-design), or
  strategic clean/hexagonal/DDD layout (use architecture-patterns).
metadata:
  version: "1.1.0"
  category: Backend Engineering
  sections:
    - {title: "How to use", start: 29, end: 35}
    - {title: "Signal table", start: 37, end: 60}
    - {title: "Gate questions", start: 62, end: 74}
    - {title: "Cross-cutting rules", start: 76, end: 90}
    - {title: "Relationship to other skills", start: 92, end: 95}
    - {title: "Reference file contract", start: 97, end: 107}
---

# Backend Engineering

Hard-won rules distilled from a production-grade modular monolith (outbox + CDC + Kafka, row-based multi-tenancy, distributed rate limiting, hybrid L1/L2 caching, OpenTelemetry-native observability, architecture tests). Every rule here exists because skipping it silently broke something. All examples are pseudocode: translate to the idiom of the language at hand, never copy syntax.

## How to use

1. Find the signals in the work below. Open **every** reference whose signal matches, not just the closest one. Most real tasks touch three or four.
2. Answer the **Gate questions** below for every new handler, endpoint, consumer, job or module, and open the reference each "yes" points to. Each reference also ends its header with an **Also open** line: follow it, it lists the neighbors that the same change usually touches.
3. Apply the **Principle**, check the **Traps**, and write the **Invariant test** with the change, not after.
4. Where a reference marks something `[known gap]` or `[proposed]`, it is not shipped behavior of the reference system. Do not present it as a proven pattern.
5. Every file starts with front matter whose `metadata.sections` lists each `##` heading with its `start` and `end` line (1-based, inclusive, counted from the first line of the file). Read the first ~30 lines of a reference to get that index and its **Golden path** line, then load only the sections you need with an offset/limit read instead of the whole file.

## Signal table

Match on the work or on the symptom, not only on the topic name. Open every row that matches; the last column lists neighbors that often matter: open one only if the work actually touches it, not by default.

| If the work involves... (or the report says...) | Open | Usually also |
|---|---|---|
| Starting a new project (ask the architecture questions), splitting into modules, who may depend on whom, module registration, a module reading or calling another module, a module that must run alone (standalone host), new module scaffold, extracting a service, new code in a non-modular project | `references/architecture-modular-monolith.md` | outbox, idempotency, persistence, observability |
| Aggregates, entities, value objects, typed ids, domain events, factories, where a port lives | `references/ddd-tactical.md` | persistence, idempotency |
| First handlers of a new module, adding or reordering pipeline behaviors, thin controller/endpoint structure (not needed for one more handler in an existing module) | `references/cqrs-use-case-pipeline.md` | error-model, observability, idempotency |
| Error values vs exceptions, validation results, wire error format, what to return vs log | `references/error-model.md` | api-surface, observability |
| Publishing an event, outbox, CDC/relay, event consumer, message id, "event lost", "event delivered twice" | `references/outbox-inbox-messaging.md` | idempotency, persistence, observability |
| Race condition, two requests at once, check-then-insert, read-modify-write, counters, "sometimes duplicate", double submit, retry, at-least-once consumer, lost update, background job overlap, distributed lock | `references/idempotency-locking-concurrency.md` | persistence (version column), outbox, resilience |
| ORM/DB conventions, tracking, transactions, migrations on rolling deploy, pagination, soft delete | `references/persistence-migrations.md` | idempotency, multi-tenancy |
| Per-tenant data, tenant resolution, cross-tenant leak | `references/multi-tenancy.md` | persistence, security |
| Throttling, abuse protection, overload, 429/503 | `references/rate-limiting-load-shedding.md` | caching, resilience |
| Any cache, stale data, stampede, cache invalidation | `references/caching.md` | resilience, rate-limiting |
| Timeouts, shutdown, health probes, bounded resources, dependency down, fail-open/closed | `references/resilience-lifecycle.md` | observability, error-model |
| Authn/authz, tokens, headers, CORS, proxies, PII or secrets in logs | `references/security-hardening.md` | untrusted-input, observability |
| User-supplied URLs/files/XML/SQL fragments, outbound calls to caller-chosen hosts, caching authenticated responses, untrusted text sent to an LLM (general practice, not repo-derived) | `references/untrusted-input-outbound.md` | security, resilience |
| Writing any endpoint/job/consumer/handler (it needs logs and metrics unasked), logging, log levels, structured or source-generated logs, metrics, business or funnel metrics ("user reached step X"), daily/weekly tracking, traces, correlation/causation ids, alerts, health | `references/observability.md` | security (masking), error-model |
| Test tiers, integration tests with real infra, flaky/shared state, concurrency tests, architecture tests | `references/testing-strategy.md` | the reference under test |
| Warnings policy, dependency pinning, CI gates, perf work, ADRs | `references/build-ci-performance.md` | testing |
| A feature is built or replaced and about to be shown to users, a performance or resource claim ("faster", "cheaper", "safe"), benchmark/load test, old-vs-new comparison, regression found, "is it ready to ship" | `references/measurement-driven-verification.md` | build-ci-performance, testing, resilience |
| Versioning, pagination contract, feature flags, route-level opt-ins, middleware order | `references/api-surface.md` | error-model, security |

## Gate questions

Ask these for every new handler, endpoint, event consumer, background job or module. A "yes" is not a reason to skip the reference; it is the reason to open it.

1. Can two calls touch the same row, key or counter at the same time, or can the same message arrive twice (retry, at-least-once, double click)? Open `idempotency-locking-concurrency.md`. Name the guard: idempotency key, unique marker, version column, or lock.
2. Does it change state and announce it (event, email, webhook)? Open `outbox-inbox-messaging.md`. Never write and publish separately.
3. Does it have telemetry, even though nobody asked? Every new endpoint, job, consumer or handler gets decision-point logs at the right level, an outcome counter on every exit path, a span, and counters for the business milestones of its flow (arrival and completion). Open `observability.md` ("Minimum telemetry per entry point"). No secrets or PII in the log.
4. Which failures are expected values and which are bugs? Open `error-model.md`.
5. Does it cross a module boundary (another module's data, events or contracts)? Open `architecture-modular-monolith.md`. Open `multi-tenancy.md` only if the system has tenants and the code touches tenant-owned data.
6. Does it call out, wait on or depend on something that can be down? Open `resilience-lifecycle.md`: timeout, bounded work, fail-open or fail-closed written down.
7. Who may call it and what does it accept from the caller? Open `security-hardening.md`, and `untrusted-input-outbound.md` for URLs, files and fragments.
8. Did questions 1-7 add a new guard (unique marker, version column, lock, boundary rule, masking)? Then open `testing-strategy.md` to pick the test that proves it. If no new guard was added, skip it.
9. Does it add or replace behavior that costs resources (CPU, memory, I/O, round trips, latency, cost) or sits on a hot path? Open `measurement-driven-verification.md`: measure it against the old behavior in the user's own isolated environment before users see it. No plausible resource impact? Write one line saying why.

## Cross-cutting rules

These recur in every reference. If a design violates one, stop and justify it in writing.

1. **Never dual-write.** State change and the event announcing it commit in one transaction; a separate relay moves the event. Delivery is at-least-once, so every consumer is idempotent.
2. **Isolation and safety are automatic, not remembered.** Anything a developer must "remember to call" (tenant filter, auth check, validation) will be forgotten once. Put it in the framework seam (query filter, interceptor, pipeline step) and make the escape hatch explicit and greppable.
3. **Key on what the attacker cannot vary.** Rate-limit, idempotency and cache keys use server-observed, authenticated or matched-template values, never raw path, user agent, or unauthenticated headers.
4. **Fail-open and fail-closed are a named list.** Decide per dependency, write it down, test both directions. The table lives in `references/resilience-lifecycle.md`.
5. **Expected failures are values; bugs are exceptions.** Validation, not-found and conflict travel in the return type and are mapped to the wire format in exactly one place.
6. **Measure, then remove round trips before allocations.** Local shield in front of an authoritative remote store; never cache counters.
7. **Every alternate path has a parity test.** Two producers, two relays, two logging backends: one test asserts byte-identical output.
8. **Silent failure is the enemy.** Prefer designs that crash or alarm over designs that quietly do nothing (unkeyed writer, missing include list, unmigrated table, no-tracking write, double-encoded payload).
9. **Tests fail the build for architecture.** Dependency direction, module boundaries and "no unkeyed X" are executable rules, not wiki pages.
10. **Measure before shipping.** A new or replaced feature reaches users only with old-vs-new numbers taken in the user's own isolated environment. Regressions are fixed without breaking the built structure, or offered to the user as options; clean results are attacked with harder scenarios, and a better design is offered, never swapped in silently.
11. **Record the why, not the what.** One-page decision records; commit messages carry cause, mechanism, measured before/after.

## Relationship to other skills

- `api-and-interface-design` (HTTP contract, Hyrum's Law, idempotency-key contract) and `architecture-patterns` (clean/hexagonal/DDD strategic patterns) are installed siblings. This skill does not repeat them; each reference says where it extends them.
- Language skills (`golang-*`, `rust-*`, ...) own idiom. This skill owns system-level decisions and failure modes. When they conflict on idiom, the language skill wins; on a failure mode listed here, this skill wins.

## Reference file contract

Every file in `references/` follows the same shape so it can be scanned quickly. It opens with front matter (`metadata.file` and `metadata.sections` with `start`/`end` lines, generated, do not hand-edit line numbers), then the H1, then a one-sentence `> **Golden path:**` recommendation, then a `> **Also open:**` line naming the neighbor references the same change usually touches, each with the reason (when you add a reference, link it from at least one neighbor and from the signal table). Headings are numbered `## 1.` to `## 7.` in this order:

1. **When this applies** (2-4 bullets)
2. **Principles** (language-agnostic, 1-2 sentences each)
3. **Design** (pseudocode and a short description of the reference implementation; mark status `[shipped]`, `[proposed]`, or `[known gap]`)
4. **Traps** (non-obvious, each with the symptom and the fix)
5. **Invariants to test** (how the rule is enforced mechanically)
6. **Rationalizations / Red flags** (what people say to skip it; what in a diff should alarm a reviewer)
7. **Checklist** (verification before merge)
