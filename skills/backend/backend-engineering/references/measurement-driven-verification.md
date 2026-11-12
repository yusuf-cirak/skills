---
metadata:
  file: measurement-driven-verification.md
  sections:
    - {title: "1. When this applies", start: 21, end: 26}
    - {title: "2. Principles", start: 28, end: 37}
    - {title: "3. Design", start: 39, end: 93}
    - {title: "4. Traps", start: 95, end: 104}
    - {title: "5. Invariants to test", start: 106, end: 111}
    - {title: "6. Rationalizations / Red flags", start: 113, end: 124}
    - {title: "7. Checklist", start: 126, end: 136}
---
# Measurement-Driven Verification

> **Golden path:** Before a feature reaches users, measure its effect on system resources against the old behavior under the same workload, fix every regression you find without breaking the structure already built, attack it with harder realistic scenarios, look for a better design, and do all of it in the user's own isolated environment.

> **Also open:** `testing-strategy.md` (where the measurement tests live and how to isolate their state); `build-ci-performance.md` (baseline-first method, measured-win catalogue, commit numbers); `resilience-lifecycle.md` (failure scenarios to inject); `caching.md` and `rate-limiting-load-shedding.md` (usual sources of both wins and regressions).

This file owns the verification loop and its safety rules. Language skills own tool syntax (`yusufcirak-skills:csharp-testing` and the `dotnet-diag` skills for .NET). Pick the stack's native tool: a benchmark harness (BenchmarkDotNet, JMH, `go test -bench` with benchstat, criterion, pytest-benchmark), a load generator (k6, wrk, vegeta), a profiler, and query or trace counters.

## 1. When this applies

- Any feature, refactor or "optimization" that adds work to a request path, a consumer, a job or startup, in any language.
- Any change that replaces an existing implementation (new library, new algorithm, new cache, new query, new serialization).
- Any claim of the form "it is faster", "it is cheaper", "it is safe to ship".
- A feature with no plausible resource impact still gets one written line saying why ("pure rename, no new I/O or allocation on a hot path"), so the skip is a decision, not an omission.

## 2. Principles

1. **Measured, not believed.** A feature is not ready for users until its resource effect is a number next to a baseline. Reasoning about cost is a hypothesis, not evidence.
2. **Compare against the old behavior one-to-one.** Same workload, same data shape, same machine, same configuration, same warm-up. Only the change under test differs. Run old and new interleaved or back-to-back, several times, and report spread, not one run.
3. **Record gains and losses together.** Check latency percentiles (p50, p95, p99), throughput, CPU, memory and allocation or GC, I/O and database round trips, connections and threads held, network bytes, queue depth, startup time, and cost. A win on one axis that hides a loss on another is a finding, not a pass.
4. **Never cause side effects outside the user's own environment.** Measure on the user's machine or an environment they own and isolated for this purpose, with synthetic data. No shared, staging or production systems, no real outbound effects (email, payments, webhooks, third-party calls), no writes to shared data. Anything outward-facing needs explicit user approval first.
5. **A negative result is a work item, not a footnote.** Find the cause with a profile, then research a way to close it. Iterate until no regression remains that matters to the system.
6. **Closing a regression must not break what already exists.** Public contracts, tests and the built structure stay intact. If the only fix needs a structural change, do not apply it: present it to the user as an option with its measured trade-off.
7. **All-positive results are suspicious.** Hunt for what the first scenarios missed: add realistic harder scenarios and try to make the feature fail.
8. **Still clean after that? Look for something better.** Search for an alternative design. Keep the structure already built. If the alternative improves the single most important function by a large margin, present it to the user as an option with numbers; do not swap silently.

## 3. Design

### The loop `[proposed]`

```
1. Hypothesis   what resource changes, in which direction, on which path; success threshold
2. Baseline     measure the OLD behavior first, in the isolated environment, with noise floor
3. Measure NEW  same harness, same inputs, interleaved with old, N runs
4. Compare      table: metric | old | new | delta | verdict (gain / loss / within noise)
5. Any loss?
     yes -> profile, find cause, research a fix that keeps the structure intact
            fix found      -> go to 3
            fix needs a structural change -> STOP, offer it to the user as an option
     no  -> go to 6
6. Break it     add realistic scenarios (list below), re-run 3-4
7. Still green? search for a better design; measure it the same way
     large effect on the most important function -> keep the current build, offer the new one
     otherwise                                    -> done
8. Report       the table, the scenarios tried, the options offered, what was not measured
```

### Environment safety `[proposed]`

- Use the user's own machine or a throwaway environment they own: local containers, an ephemeral database, an in-process fake for every third party. Seed synthetic data; never copy real data.
- Point every outbound adapter at a local sink (mail catcher, mock server) before running load. Verify the target host in the config, not by assumption.
- Measurement code lives in the test or benchmark project and reads its own configuration. Never flip a switch in a shared environment to "see what happens".
- Tear down the state a run creates (data, containers, temp files), but keep the benchmark and test code. It is a regression guard: rerun it whenever the feature changes. A run that leaves state behind pollutes the next one and the environment.
- Needs a production-like signal that only a shared environment has? Stop and ask the user; do not reach for it.

### What to measure `[proposed]`

| Axis | Examples |
|---|---|
| Latency | p50, p95, p99, max under steady and burst load |
| Throughput | requests or messages per second at the saturation point |
| CPU and memory | CPU time per operation, peak and steady memory, allocations, GC pauses |
| I/O | database queries and round trips per operation, bytes read and written, cache hit rate |
| Concurrency | threads, connections, locks held, queue depth, time spent waiting |
| Lifecycle | startup time, shutdown drain time, cold-path cost |
| Cost | remote calls billed, storage growth, log and metric volume |

Round trips and queries per operation are the cheapest, most stable signals: assert them exactly. Timings are noisy: take the noise floor from running the old code against itself and call a delta real only when it clears that floor.

### Adversarial scenarios to add `[proposed]`

- Data shape: empty, one row, very large, skewed (hot key, hot tenant), unicode and long strings, worst-case inputs.
- Concurrency: many callers on one key, duplicate delivery, retries, thundering herd after expiry.
- State: cold start and cold cache, full cache, eviction, long soak for leaks and growth.
- Failure: dependency slow, dependency down, partial failure, timeout, restart mid-operation (see `resilience-lifecycle.md`).
- Load: burst over the limit, sustained saturation, noisy neighbor in a multi-tenant system.
- Compatibility: old and new running at once during a rolling deploy, old data read by new code.

### Reporting `[proposed]`

One table of metric, old, new, delta and verdict. Then three short lists: scenarios tried, options offered to the user (each with its measured trade-off), and what was not measured and why. A regression that was accepted is named as accepted, with who accepted it. Put the headline numbers in the commit message (cause, mechanism, before and after).

## 4. Traps

- **Measuring in a shared environment.** A load run against staging or a shared database changes other people's data and numbers. Isolate first.
- **Comparing against memory of the old numbers.** Re-measure the old behavior in the same run; machines, data and load drift.
- **One run, no warm-up.** JIT, caches and connection pools make the first run unrepresentative. Warm up, repeat, report spread.
- **Optimizing the axis that is easy to move.** Allocation trims that leave round trips untouched change nothing a user feels (see `build-ci-performance.md`).
- **Fixing a regression by changing the contract.** A passing benchmark bought with a changed public behavior is a break, not a fix. Offer it as an option instead.
- **Stopping at the first green.** Happy-path data hides the regression that appears under skew, contention or failure.
- **Silently swapping in the better design.** The user chose the built structure. Present the alternative with numbers and let them decide.
- **Mock that cannot regress.** An in-memory fake has none of a real engine's costs. Use the real engine, in the isolated environment, for anything where engine cost is the question.

## 5. Invariants to test

- Query and round-trip counts per operation are asserted exactly in a test, so a regression fails the build rather than a dashboard.
- A benchmark or load scenario is checked in beside the feature, runnable with one command, and writes its table to the output.
- The measurement harness refuses to start when an outbound target is not a local sink (assert on resolved hosts).
- Old and new implementations run through the same harness and the same inputs, with an equivalence check on their outputs before timing them.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "It is obviously cheaper" | Obvious is a hypothesis. Measure it or write why there is no resource impact. |
| "Try it on staging, it is quicker" | It writes to a shared environment. Run it locally or in an isolated environment the user owns. |
| "The new one is faster on average" | Check p99, memory and round trips. Averages hide the regression. |
| "A small regression is fine" | Maybe, but name it, quantify it and let the user accept it. |
| "Everything is green, ship it" | Add harder scenarios and look for a better design first. |
| "I found a better design, I switched" | Keep the built structure and offer the new one with numbers. |

Red flags: a performance claim with no old-vs-new table; a load run aimed at a non-local host; a benchmark with no warm-up or a single run; an optimization commit with no numbers; a fix that changes a public contract to make a number pass.

## 7. Checklist

- [ ] Hypothesis and success threshold written before measuring (or one line saying why there is no resource impact).
- [ ] Old behavior measured in the same run, same harness and inputs, with a noise floor.
- [ ] Table covers latency percentiles, throughput, CPU, memory, I/O round trips and lifecycle, with gains and losses.
- [ ] Every regression has a cause (profile) and either a fix that keeps the structure or an option offered to the user.
- [ ] Harder realistic scenarios added (skew, contention, cold start, failure, burst) and re-measured.
- [ ] A better alternative was searched for; any large win on the key function is offered, not swapped in.
- [ ] All measurement ran in the user's isolated environment: synthetic data, local sinks for outbound effects, run state torn down, benchmark and test code kept for reruns.
- [ ] Round-trip counts are asserted in a test; the benchmark is runnable with one command.
- [ ] Report lists scenarios tried, options offered and what was not measured.
