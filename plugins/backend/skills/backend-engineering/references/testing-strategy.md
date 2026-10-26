---
metadata:
  file: testing-strategy.md
  sections:
    - {title: "1. When this applies", start: 19, end: 24}
    - {title: "2. Principles", start: 26, end: 34}
    - {title: "3. Design", start: 36, end: 101}
    - {title: "4. Traps", start: 103, end: 113}
    - {title: "5. Invariants to test", start: 115, end: 121}
    - {title: "6. Rationalizations / Red flags", start: 123, end: 133}
    - {title: "7. Checklist", start: 135, end: 145}
---
# Testing Strategy

> **Golden path:** Unit tests for logic, executable architecture rules for dependency direction, and a few integration tests against real infrastructure for what fakes cannot prove.

Language skills own framework and assertion-library choices (`dotnet:testing` for .NET). This file owns what each tier must prove and the isolation traps that make suites lie.

## 1. When this applies

- Deciding how to split unit, architecture and integration tests, or adding a new tier.
- Writing a test that needs real infrastructure (database, broker, cache, CDC connector).
- Debugging flaky or order-dependent tests, especially around rate limits, caches, meters or tracking.
- Reviewing whether a behavior is actually covered or only covered by a fake that cannot fail.

## 2. Principles

1. **Unit tests prove logic. Architecture tests prove dependency direction. Integration tests prove only what fakes cannot.** Do not use a slow tier for a fast question.
2. **If the behavior depends on a real engine's semantics, test against the real engine.** Unique constraints, row locking, row-version columns, CDC, rate-limit counters: an in-memory substitute cannot fail the way production fails.
3. **Boot expensive infrastructure once per test assembly**, not per class or test.
4. **Production configuration is linked into tests, never copied.** A hand-kept copy drifts silently.
5. **Wait on a signal with a deadline; never sleep and hope.**
6. **State that outlives a reset is the main cause of flaky suites.** Know every layer that caches (process memory, local mirrors, static meters) and reset all of them.
7. **Assert contracts on the output, not on internals.** Exported telemetry shape, wire format, response body.

## 3. Design

### Tiers `[shipped]`

| Tier | Proves | Speed |
|---|---|---|
| Unit | Factories and invariants (valid input succeeds, each invalid input maps to its error code), pure functions, behaviors with fakes at the outbound edge | Milliseconds |
| Architecture | Dependency direction and module boundaries as executable rules; fails the build on a new breach | Seconds |
| Integration | Behavior needing real infra, end to end through the booted application | Minutes, once per assembly |

CI runs them in that order so a cheap failure stops the run early.

### Test project layout is a decision, not a rule

The reference system uses three solution-wide test projects (unit, architecture, integration). Per-production-project test projects are the other common shape. Pick one and record it; do not mix. Internals are exposed to the unit test project only (never to integration or production consumers). In Go that is a same-package `_test.go` file; in Rust a `#[cfg(test)]` module next to the code, with integration tests under `tests/` seeing only the public API.

### Architecture tier outside the reference stack

The reference uses an IL-inspection library. Equivalents: in Go, an import-boundary linter (for example `depguard` or `go-arch-lint`) plus `internal/` packages; in Rust, workspace crate boundaries (a domain crate that does not list the infrastructure crate as a dependency) plus `pub(crate)` visibility, enforced in CI with a dependency-graph check. The point is that the rule fails the build, not that a specific tool runs it.

### The integration spine `[shipped]`

```
fixture (one per assembly, shared collection):
  start on one network: database (logical WAL enabled), broker (KRaft), CDC connect, cache
  boot the application in-process against them
  run migrations (hosted startup) BEFORE registering the CDC connector
  register the connector from the PRODUCTION connector file (linked into test output,
      override only the hostname)
  assert connector reaches RUNNING or fail with the response body
  OTEL_SDK_DISABLED=true
  bootstrap the config-decryption secret before any test (module initializer)
all integration test classes join the one collection; tests run sequentially inside it
```

Async outcomes use a poll loop with a deadline (reference: 90 s for the full pipeline). Consumers use the earliest offset reset, so a late subscriber still sees the event.

### What only real infrastructure can prove `[shipped]`

- N parallel deliveries of one message commit exactly once; losers return "duplicate", not an exception (unique-violation path).
- Optimistic concurrency: two contexts load one row, the first commit wins, the second throws.
- Skip-locked claim, lease and complete for a polling relay (publisher faked, database real).
- Rate limit: the Nth+1 request is 429 with `Retry-After` and a problem body; a burst ban outlives its window.
- Tenant B cannot list or fetch tenant A's data; a tenant-less write is refused.
- Full spine: HTTP write, outbox row, CDC, broker, inbox row, with trace and correlation ids propagated.

### Isolation of shared state `[shipped]`

A host shared across the assembly keeps state a cache flush does not touch: the local ban mirror and per-node pre-limiter windows. Request number one then returns a spurious 429. The fix is two-part:

```
fixture config:  RateLimiting.LocalPreLimit = false   # limiter becomes store-authoritative
reset helper:    flush the remote store  AND  clear the process memory cache
every rate-limit-sensitive test (and the spine test) calls reset first
local tiers are covered by unit tests instead
```

### Other tactics

- **Wire-parity tests:** every alternate producer path (in-app relay vs CDC router) builds byte-identical topic, key, value and headers.
- **Extract pure functions** (message building, success harvesting, flush decision) so shape tests need no infrastructure.
- **Single-flight test:** 25 concurrent callers for one key run the loader once.
- **Document the footgun with a test** `[proposed]`: in an ORM that reads untracked by default, load, mutate, save, and assert the row is unchanged (the silent no-op). Without an ORM change tracker (typical Go or Rust data layers) the equivalent is a test that a write which matches zero rows is reported as an error, not as success.
- **Hand-built database handles in tests must apply the same naming and conventions as production**, or the schema will not match the migrated one.
- **Time and ids are injected** (fake clock, seeded data), never read from the wall clock in assertions.
- **Licensing awareness:** assertion and mocking libraries get relicensed (a major assertion library went commercial at v8). Pin a version deliberately and record it in the dependency policy (see `build-ci-performance.md`).

## 4. Traps

- **In-memory database providers cannot test relational semantics** (no unique constraints, no row-version column, no locking). `[known gap]` The reference unit-test project references one and five of its unit-test files use it (tenancy, soft delete, interceptors, outbox writer, pagination). Presumably they exercise save-time hooks rather than relational semantics (not audited line by line), and the semantics-dependent behaviors (inbox uniqueness, row-version concurrency, skip-locked claim) are covered by the real-database integration tier; keep that split deliberate and do not extend the in-memory use.
- **CDC connector registered before the table exists** fails permanently and silently. Migrate first, then register.
- **Hand-copied connector config** drifts from production; the double-encoded payload bug (missing JSON-expand flag) then shows up only as an empty inbox. Link the production file.
- **A fresh consumer group with the default "latest" offset skips everything produced before it joined.** Use earliest in tests.
- **Static meters across several hosts** throw on second registration; make registration idempotent.
- **A remote flush alone does not reset local mirrors.** Clear process memory too.
- **A test that tolerates a failure must check the specific failure.** Accepting any exception passes vacuously.
- **Test counts quoted in commit messages drift** with uncommitted work. Do not hardcode counts in docs or skills; run the suite.
- **Unfaked clocks and unseeded random data** make assertions non-deterministic.

## 5. Invariants to test

- `[shipped]` The reference has exactly five architecture rules, all dependency direction: domain must not depend on the ORM or the broker client; domain must not depend on application or infrastructure; application must not depend on infrastructure or presentation; infrastructure must not depend on presentation; a module must not depend on another module's non-contract namespace.
- `[proposed]` Rules the reference does **not** yet enforce and that this skill recommends: no handler injects an unkeyed outbox writer (see `outbox-inbox-messaging.md`); query-filter bypass appears only in an allow-listed admin namespace (see `multi-tenancy.md`); the CDC connector's include list names every module's outbox table (the reference's list is missing one; its integration test only asserts the connector reaches RUNNING).
- `[shipped]` A namespace-valued constant string can read as a dependency in IL-based tools; exclude by name and note it where the rule lives.
- `[proposed]` Every aggregate has no public constructor and every factory returns a result value.
- `[shipped]` The connector file linked into the integration project is the one in `infra/`.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "The in-memory provider is faster" | It passes tests production fails. |
| "I will sleep 2 seconds for the consumer" | Slow when right, flaky when slow. Poll with a deadline. |
| "Copy the connector JSON into the test" | Drift. Link it. |
| "Resetting the store between tests is enough" | Local mirrors survive. Clear process memory too. |
| "One container per test class is cleaner" | Minutes of startup. Share the spine. |

Red flags: a test with `sleep`; mocks of types you own with no side effects; a test asserting `value` before asserting success; a connector config duplicated under `tests/`; a rate-limit test that does not reset first.

## 7. Checklist

- [ ] Each behavior is tested in the cheapest tier that can fail the way production fails.
- [ ] Integration infra starts once per assembly; production connector file is linked.
- [ ] Migrations run before connector registration; connector RUNNING is asserted.
- [ ] Async waits are deadline polls; consumers use earliest offset.
- [ ] Shared-state reset clears remote store and process memory; local pre-limit disabled for integration.
- [ ] Wire-parity test exists for every alternate producer.
- [ ] Architecture rules cover layers and module boundaries; "no unkeyed X" and the filter-bypass allow-list are added as rules.
- [ ] No hardcoded test counts in docs; telemetry disabled in tests.
- [ ] Behaviors from other references have their invariant test (idempotency, tenancy, rate limit, outbox/inbox, cache single-flight): see the Invariants section of each reference.
