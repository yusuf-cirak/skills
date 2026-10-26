---
metadata:
  file: build-ci-performance.md
  sections:
    - {title: "1. When this applies", start: 19, end: 25}
    - {title: "2. Principles", start: 27, end: 35}
    - {title: "3. Design", start: 37, end: 114}
    - {title: "4. Traps", start: 116, end: 124}
    - {title: "5. Invariants to test", start: 126, end: 131}
    - {title: "6. Rationalizations / Red flags", start: 133, end: 142}
    - {title: "7. Checklist", start: 144, end: 154}
---
# Build, CI and Performance

> **Golden path:** Warnings fail the build with an explicit exception list, versions are pinned in one place, and performance work starts with a measurement and removes round trips before allocations.

Language skills own tooling syntax (`dotnet:csharp` references `build-and-analyzers` and `performance` for the .NET forms). This file owns the policy decisions and the method.

## 1. When this applies

- Introducing or tightening a static analyzer, warnings policy, or style gate.
- Adding dependencies, generators or build-time code generation.
- Setting up or changing CI jobs and dependency automation.
- Doing any performance work, or reviewing an "optimization" diff.
- Writing a decision record.

## 2. Principles

1. **Warnings are gates with a short, enumerated, commented exception list.** An exception says why and how many hits it hides.
2. **Land an analyzer green.** Fix every hit of the rules that stay errors in the same change; demote the rest explicitly. Never land a red or silently ignored analyzer.
3. **The build is reproducible; the world is not.** Advisory databases change independently of your code, so advisories warn in the build and fail in a separate audit job.
4. **Versions are pinned in one place**, and a transitive override carries a comment naming the advisory and why it is or is not exploitable.
5. **The build pays only for generators that produce something it uses.**
6. **Measure first. Remove round trips before allocations.**
7. **Record the why, not the what.**

## 3. Design

### Warnings and analyzers `[shipped]`

```
warnings-as-errors = true  (repo-wide)
exceptions (each with a comment):
  - package advisories stay warnings
  - a few analyzer rules demoted: "N pre-existing hits, separate pass"
a new analyzer enters as a gated default:
  triage hits by REAL severity, not count
  reference: 506 hits -> 92 hits / 46 sites fixed (string comparers, regex timeouts,
  format providers, comparison operators on comparable value objects)
  and one latent bug found (an unused try-parse result silently defaulted a timestamp to 0)
```

The figures in this file (506/92, the compile-time numbers below, the 20 failing tests) are quoted from the reference system's commit messages and were not re-measured; use them as illustrations of scale, not as targets.

### Dependencies `[shipped]`

- Central version management: one file lists every package version.
- Transitive overrides are annotated with the advisory id and the exploitability reasoning.
- **OSS-pinning policy:** when a library relicenses (commercial from a version), pin the last open release deliberately. Bumps are decisions, recorded in a decision record.
- Dependency automation: weekly, minor and patch grouped into one change, majors individual, plus weekly CI-action bumps.

### Generator scoping `[shipped]`

Measured result: compile time of the core compile step fell from 37.5 s to 4.6 s (-88%) in a 23-project solution.

- A globally wired generator with zero call sites was running in every project: removed.
- Two generators flowed transitively into every consumer: scoped so the generator runs once while the runtime library still flows.
- **Two kinds of build-time package need different asset flow.** A pure static analyzer has no runtime library, so nothing should flow to consumers. A generator that ships a runtime library must keep the runtime part flowing and hide only the analyzer part. Choosing "hide everything" for the second kind compiles fine and then fails at runtime with a missing assembly; the reference suffered 20 integration-test failures from exactly this.
- Prefer the plain runtime package over its "drop-in generator" variant when you only need the types. The drop-in variant that shadows a standard-library namespace re-ran in all projects and was the largest generator cost. Use the explicit conversion instead.
- A test project that builds its own DI container needs the generator referenced locally, or generated registrations are missing.
- Ubiquitous libraries (the result type, zero-allocation iteration helpers) may get a project-wide import where the language has such a mechanism; keep that list tiny. Removing redundant imports cleaned 34 sites.

### Style gate, branch-conditional `[shipped]` with `[known gap]`

Style analyzers run during the build on every branch except the default branch, which only receives already-gated code. The branch is read directly from `.git/HEAD` (no process spawn per project); detached HEAD, missing `.git` or an unknown branch fail safe to enabled. `[known gap]` The reference repo has no `.editorconfig`, so the gate enforces only rules at default severity and is mostly ceremonial until severities are set.

### CI `[shipped]` with gaps

```
push: restore -> build Release -> unit -> architecture -> integration (container runtime on the runner, ~25 min cap)
audit job (separate): list vulnerable packages incl. transitive; fail on High or Critical
dependency bot: weekly, minor+patch grouped
```

`[known gap]` No deploy workflow, no coverage threshold, no container image build in CI (compose and Dockerfile exist under `infra/` only).

### Performance method

1. Capture a baseline (a structured build trace or profile, a benchmark, a request trace). Do not guess the culprit.
2. Count remote round trips per request and remove them first: a round trip costs orders of magnitude more than an allocation.
3. Optimize only measured hot paths. Never optimize warm-up paths (a memoized transform pays once).
4. Commit with cause, mechanism, before and after numbers, and the test tally.

### Catalogue of measured wins `[shipped]`

Detail for each lives in its own reference: limiter wins in `rate-limiting-load-shedding.md`, stampede in `caching.md`, publish and claim in `outbox-inbox-messaging.md`, indexes in `persistence-migrations.md`, idempotency blob in `idempotency-locking-concurrency.md`.

| Win | Mechanism |
|---|---|
| Rate limiter 2 remote ops to 0 | Local ban mirror with pub/sub broadcast; per-node limiter with cap equal to the global limit in front of the distributed one (local reject never touches the store, and never false-rejects) |
| Cache stampede 25 loaders to 1 | Library single-flight plus stale-while-revalidate, not a hand-rolled one |
| Outbox publish | Enqueue the whole batch, harvest delivery reports concurrently (all-complete, not list order); linger about 10 ms and fast compression; ack-all plus idempotent producer keeps per-key order |
| Claim vs publish | One auto-committed `UPDATE ... SKIP LOCKED ... RETURNING` leases a batch, then publish with no DB connection held |
| Hashing on a per-request path | Stack buffer with a pooled fallback for long attacker-controlled input (4 allocations to 1); output encoded lowercase directly |
| Header and claim parsing | Slice spans instead of splitting strings |
| JSON | Precompiled metadata for boundary types chained ahead of reflection (unlisted types still work); metadata-only mode so global options still apply |
| Log processors | Allocate only when a key changes; read fixed baggage keys directly |
| Indexes | Composite index serving filter plus sort; partial index on pending outbox rows |
| Idempotency cache | Length-prefixed binary blob instead of base64 inside JSON (about 33% smaller) |
| Principal resolution | Resolve once per request, stash in request items, reuse downstream |

### ADR and commit practice `[shipped]`

One page each (context, decision, consequences), indexed, roughly 2 KB. Any behavior switchable by config (log backend, outbox relay) gets an ADR and a parity test. Comments in build files explain every exception. `[known gap]` A runbook for the CDC startup race exists only as a memory note; the `infra/README.md` it references is absent.

## 4. Traps

- **"Correct per message" awaits defeat client batching.** Awaiting each send serially turned 100 rows into 100 round trips.
- **Counters in a shared cache** admit the full limit per node. Never cache counters.
- **Wrong asset flow for a generator** fails only at runtime, not compile.
- **Advisories as build errors** break a green build the day a new advisory is published.
- **A style gate without severity config** looks enabled and enforces little.
- **Quoted test counts and timings in docs** go stale; link to the commit or run the suite.
- **Optimizing the memoized snake-case transform** was explicitly rejected: warm-up cost, not hot path.

## 5. Invariants to test

- Build with warnings-as-errors in CI; the audit job exit code is the vulnerability gate.
- A measured compile-time baseline (build trace or profile) before touching generators.
- Single-flight test (25 callers, loader runs once); partial-failure publish returns only acknowledged ids; hash bytes identical across an allocation rewrite.
- Format-parity test for every alternate producer.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "Demote the rule, it is noisy" | Triage by severity first; the noisy rule hid a real bug. |
| "Reference the generator everywhere to be safe" | Every project pays for it. Scope it. |
| "Allocation trims are free speed" | Remove round trips first; measure. |
| "Advisories should break the build" | They break green builds for reasons unrelated to the change. |

Red flags: an analyzer rule demoted with no comment; a package pin with no advisory note; a perf commit without numbers; a new generator referenced in the shared props file.

## 7. Checklist

- [ ] Warnings-as-errors with commented exceptions; new analyzers landed green.
- [ ] Advisories warn in build and fail in the audit job.
- [ ] Central versions, GHSA-annotated pins, deliberate OSS pins.
- [ ] Generators scoped to their projects; analyzer-only vs runtime-library flow correct.
- [ ] CI order build, unit, architecture, integration; bot grouped.
- [ ] Style severities set (or the gap is recorded).
- [ ] Perf change has baseline, mechanism, before/after in the commit.
- [ ] Switchable alternatives have an ADR and a parity test.
- [ ] Test-tier details (what runs in CI, isolation) follow `testing-strategy.md`.
