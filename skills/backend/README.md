# Backend

Language-agnostic backend engineering rules and traps for production services. One skill with 17 references, each following the same shape: principles, design, traps, invariants to test, red flags, checklist.

## User-invoked

None yet. A skill joins this group when it sets `disable-model-invocation: true`.

## Model-invoked

Model- or user-reachable.

- **[backend-engineering](./backend-engineering/SKILL.md)**: Cross-cutting rules and a signal table over `references/` for modular monolith boundaries, DDD tactical patterns, CQRS pipeline, error model, outbox/inbox, idempotency and locking, multi-tenancy, rate limiting, caching, resilience, security hardening, untrusted input, observability, persistence and migrations, testing strategy, build/CI, API surface.
