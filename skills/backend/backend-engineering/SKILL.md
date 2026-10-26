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
    - {title: "How to use", start: 28, end: 33}
    - {title: "Signal table", start: 35, end: 55}
    - {title: "Cross-cutting rules", start: 57, end: 70}
    - {title: "Relationship to other skills", start: 72, end: 75}
    - {title: "Reference file contract", start: 77, end: 87}
---

# Backend Engineering

Hard-won rules distilled from a production-grade modular monolith (outbox + CDC + Kafka, row-based multi-tenancy, distributed rate limiting, hybrid L1/L2 caching, OpenTelemetry-native observability, architecture tests). Every rule here exists because skipping it silently broke something. All examples are pseudocode: translate to the idiom of the language at hand, never copy syntax.

## How to use

1. Find the signals in the work below. Open **every** reference whose signal matches, not just the closest one. Most real tasks touch three or four.
2. Apply the **Principle**, check the **Traps**, and write the **Invariant test** with the change, not after.
3. Where a reference marks something `[known gap]` or `[proposed]`, it is not shipped behavior of the reference system. Do not present it as a proven pattern.
4. Every file starts with front matter whose `metadata.sections` lists each `##` heading with its `start` and `end` line (1-based, inclusive, counted from the first line of the file). Read the first ~30 lines of a reference to get that index and its **Golden path** line, then load only the sections you need with an offset/limit read instead of the whole file.

## Signal table

| If the work involves... | Open |
|---|---|
| Splitting a system into modules, who may depend on whom, module registration, cross-module calls | `references/architecture-modular-monolith.md` |
| Aggregates, entities, value objects, typed ids, domain events, domain state, where a port lives | `references/ddd-tactical.md` |
| Use-case structure, handler pipeline, behaviors and their order, thin transport layer | `references/cqrs-use-case-pipeline.md` |
| Error values vs exceptions, validation results, wire error format | `references/error-model.md` |
| Publishing events reliably, outbox, CDC/relay, consumers, message identity | `references/outbox-inbox-messaging.md` |
| Retries, idempotency keys, locks, lost updates, concurrent duplicates | `references/idempotency-locking-concurrency.md` |
| ORM/DB conventions, tracking, transactions, migrations on rolling deploy, pagination | `references/persistence-migrations.md` |
| Per-tenant data, tenant resolution, isolation bugs | `references/multi-tenancy.md` |
| Throttling, abuse protection, overload, 429/503 | `references/rate-limiting-load-shedding.md` |
| Any cache, stale data, stampedes | `references/caching.md` |
| Timeouts, shutdown, health probes, bounded resources | `references/resilience-lifecycle.md` |
| Authn/authz, tokens, headers, CORS, proxies, PII in logs | `references/security-hardening.md` |
| User-supplied URLs/files/XML/SQL fragments, outbound calls to caller-chosen hosts, caching authenticated responses, untrusted text sent to an LLM (general practice, not repo-derived) | `references/untrusted-input-outbound.md` |
| Logs, metrics, traces, correlation ids, health | `references/observability.md` |
| Test tiers, integration tests with real infra, flaky/shared state | `references/testing-strategy.md` |
| Warnings policy, dependency pinning, CI gates, perf work, ADRs | `references/build-ci-performance.md` |
| Versioning, pagination contract, feature flags, route-level opt-ins | `references/api-surface.md` |

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
10. **Record the why, not the what.** One-page decision records; commit messages carry cause, mechanism, measured before/after.

## Relationship to other skills

- `api-and-interface-design` (HTTP contract, Hyrum's Law, idempotency-key contract) and `architecture-patterns` (clean/hexagonal/DDD strategic patterns) are installed siblings. This skill does not repeat them; each reference says where it extends them.
- Language skills (`golang-*`, `rust-*`, ...) own idiom. This skill owns system-level decisions and failure modes. When they conflict on idiom, the language skill wins; on a failure mode listed here, this skill wins.

## Reference file contract

Every file in `references/` follows the same shape so it can be scanned quickly. It opens with front matter (`metadata.file` and `metadata.sections` with `start`/`end` lines, generated, do not hand-edit line numbers), then the H1, then a one-sentence `> **Golden path:**` recommendation. Headings are numbered `## 1.` to `## 7.` in this order:

1. **When this applies** (2-4 bullets)
2. **Principles** (language-agnostic, 1-2 sentences each)
3. **Design** (pseudocode and a short description of the reference implementation; mark status `[shipped]`, `[proposed]`, or `[known gap]`)
4. **Traps** (non-obvious, each with the symptom and the fix)
5. **Invariants to test** (how the rule is enforced mechanically)
6. **Rationalizations / Red flags** (what people say to skip it; what in a diff should alarm a reviewer)
7. **Checklist** (verification before merge)
