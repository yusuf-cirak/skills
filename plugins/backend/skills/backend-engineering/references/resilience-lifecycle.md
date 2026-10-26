---
metadata:
  file: resilience-lifecycle.md
  sections:
    - {title: "1. When this applies", start: 17, end: 22}
    - {title: "2. Principles", start: 24, end: 31}
    - {title: "3. Design", start: 33, end: 118}
    - {title: "4. Traps", start: 120, end: 133}
    - {title: "5. Invariants to test", start: 135, end: 144}
    - {title: "6. Rationalizations / Red flags", start: 146, end: 156}
    - {title: "7. Checklist", start: 158, end: 167}
---
# Resilience and Lifecycle

> **Golden path:** Bound every client-controlled resource and every outbound call, split probes into startup/liveness/readiness, flip readiness at SIGTERM, and keep a written fail-open/closed list.

## 1. When this applies

- Setting server limits, timeouts, and outbound-call policies for a new service.
- Wiring health probes, graceful shutdown, or deployment readiness.
- Deciding what a component does when a dependency it relies on is down.
- Adding a background worker (migrator, relay, consumer) to the process.

## 2. Principles

1. **Bound every resource a client can consume.** Body size, header size, request duration, decompressed size, page size, collection size. An unbounded input is a denial-of-service parameter.
2. **Bound every outbound call.** Timeout, retry only where safe, circuit breaker. No unbounded wait on anything you do not own.
3. **Stop accepting traffic before you stop serving it.** On a termination signal, readiness flips to unhealthy first, the load balancer drains, in-flight work finishes inside a drain window, then the process stops.
4. **Probes answer different questions.** Do not collapse startup, liveness, and readiness into one endpoint.
5. **Fail-open versus fail-closed is a named, tested list**, never an accident of each component's error handling.
6. **Cancellation is cooperative.** A timeout only works if the handler observes its cancellation token.

## 3. Design

This file is the single home for the fail-open/fail-closed list and for the probe definitions (including the starvation probe). `observability.md`, `rate-limiting-load-shedding.md` and `security-hardening.md` refer here instead of repeating them.

### Inbound limits `[shipped]`

| Limit | Reference value | Notes |
|---|---|---|
| Request body | 10 MB hard cap | Per-endpoint tighter caps for JSON (1 MB default is common). |
| Header block | 32 KB | |
| Request timeout | 30 s, then 504 | Lower for read paths. |
| Server identity header | removed | |
| Shutdown drain | 10 s | Must be shorter than the host's forced-stop timeout. |
| Page size | below 1 becomes the default (20), above 200 becomes 200 | Clamp, do not reject: a hostile `page_size=10_000_000` becomes 200. |
| JSON nesting depth | 32 | See `security-hardening.md`. |

Define these once as shared constants. Validators, value-object length checks, endpoint size attributes, and server configuration all read the same numbers; never repeat a magic literal.

### Outbound calls

Target shape: every outbound client gets the same standard pipeline, outer to inner: rate limiter, total timeout, retry (exponential backoff with **mandatory jitter**), circuit breaker, per-attempt timeout.

- **Retry only idempotent operations.** A non-idempotent write without an idempotency key must never be auto-retried.
- Any address-filtering or SSRF guard composes **inside** the pipeline, so retries cannot bypass it (rules in `untrusted-input-outbound.md`).
- Pipelines emit metrics and traces through the normal telemetry exporter.
- Test the degraded path with injected faults and latency before production does.

What the reference system actually does `[shipped]` with `[known gap]`s: every HTTP client gets the library's stock standard pipeline (total timeout, retry, circuit breaker, per-attempt timeout) through a global client default, configured with no options. Gaps verified in code: (1) the stock retry covers transient failures on **every** method including POST, because the "disable for unsafe methods" option is not set; (2) no SSRF/address-filtering handler is composed; (3) no test exercises the pipeline; (4) hedging (a parallel second attempt to a replica, only for operations safe to run twice) is absent.

### Graceful shutdown and probes `[shipped]`

```
on SIGTERM:
   readiness_check.state = UNHEALTHY          # immediately; load balancer stops sending new requests
   wait drain_window (<= forced-stop timeout) # in-flight requests finish
   stop hosted services, flush telemetry
```

| Probe | Question | Contains |
|---|---|---|
| startup | Has initialization finished? | Schema migrations applied. |
| liveness | Is the process able to make progress? | Worker-pool starvation probe (below). Nothing that touches a dependency. |
| readiness | Should the balancer send traffic now? | The shutdown flag plus dependency checks. In the reference system: database, cache, broker **and the CDC connector's REST endpoint**. |
| full | Operator dashboard view | All of the above. |

- **Liveness = starvation probe.** Queue a trivial work item and require it to run within about 500 ms. A saturated worker pool is the commonest "alive but dead" state, and a liveness probe that only returns 200 cannot see it.
- **Every dependency check carries its own timeout** (reference: 3 s for database, cache and the connector URL; 5 s for the broker, whose check needs a producer round trip). A check without a timeout hangs the whole probe, and the orchestrator then counts the pod as failing.
- Probe endpoints are exempt from request logging and rate limiting.
- **The rule that broke the deadlock:** the CDC connector may wait on the **startup** probe only. Migrations sit on startup, never on readiness. Readiness may include the connector, but see the trap below.

### Hosted services in the process `[shipped]`

- A migrator runs at boot on **every instance** (see `persistence-migrations.md`); it marks a readiness tracker so the startup probe reports applied only when the expected count of migrations has completed. Register the expected count at configuration time so the probe cannot report applied before the migrator has even started.
- A polling relay or consumer starts only when enabled by configuration. Run exactly one relay kind, never both.
- Client disconnects surface as cancellation. Map them to a non-error status (499) and do not log them as faults.

### Fail-open and fail-closed list `[shipped]`

| Component | When its dependency is down | Why |
|---|---|---|
| Rate-limit store | **Open**: per-node limiter plus metric | A limiter outage must not become an outage. |
| Token revocation list | **Open** | Availability of authentication outweighs a stale revocation for the outage window. |
| HTTP idempotency store | **Degrade**: process without it, log a warning | Duplicate protection lost, service stays up. Errors are never cached. |
| Cache | **Open**: loader calls plus stale | Performance event only. |
| Tenant resolution / tenant stamp | **Closed**: refuse the operation | Isolation cannot degrade. |
| Request validation | **Closed** | |
| Distributed lock backend missing | **Fail loud**: an explicit "unconfigured" implementation throws on first use | A lock that silently does not lock is worse than no lock. |
| Optimistic concurrency check | **Closed** | Lost updates are corruption. |

Rule: every row has a test for the dependency-up case **and** the dependency-down case.

### Fail fast versus safe default

A missing prerequisite that makes behavior unsafe (lock backend, signing key, required option) fails at startup with a clear message. Validate options at startup rather than at first use. A missing prerequisite that only affects an optimization (cache, local pre-limiter) takes the safe default and emits a metric.

### Options validated on start `[shipped]`

```
options = bind(config section)
          -> apply code-configure callback (code wins over config)
          -> field/annotation validation
          -> cross-field rules ("mode=symmetric requires signing_key", "min <= max", "0 < factor < 1")
          -> validate_on_start()          # host refuses to boot, naming the offending key
```

Do this for every options type that gates security or limits (token validation, rate limiting, module settings).

## 4. Traps

- **Migrations in the readiness probe.** An orchestrator or a CDC connector waits on readiness; readiness probes that component; neither goes first. Deadlock. Migrations live on the separate startup probe. The rule is not "readiness never contains the connector" but "a component that gates on readiness must not itself be probed by readiness".
- **Readiness that probes the CDC connector turns a CDC outage into an HTTP outage.** The reference system's readiness includes the connector's REST endpoint, so when the connector is down the balancer drains every healthy instance even though the HTTP path does not need CDC. Question that coupling; an alert on the connector is usually the better signal. `[known gap]`
- **Eager copy diverges from validated options.** Registration code often needs a value before the container exists (to choose which services to register), so it reads a second, eagerly bound copy of the section. The validated options object and the object the wiring consumed are then two objects: a code-configure callback must be applied to both, or the validation passes on values the wiring never used.
- **Default resilience handler retries unsafe methods.** The stock pipeline retries transient failures on POST/PUT/DELETE unless told not to. Set the unsafe-method switch or give those calls an idempotency key.
- **Timeout that does not cancel.** The 30 s timeout returns 504 but a handler that ignores its cancellation token keeps consuming a worker and a connection.
- **Drain longer than the forced-stop timeout.** The process is killed mid-drain. Keep the drain window below the host's shutdown timeout.
- **Retry without jitter.** Retries synchronize into a thundering herd.
- **Retry on non-idempotent writes.** Double charge.
- **One liveness endpoint for everything.** A dependency outage restarts every healthy pod.
- **Singleton dependency holding a request-scoped resource** (a captive dependency). The first request's connection is reused by all.
- **Silent no-op locks.** A default lock implementation that returns immediately hides a missing backend until a race corrupts data.
- **Probe endpoints logged and limited.** They drown the logs and can be throttled into a restart loop.

## 5. Invariants to test

- After the shutdown signal fires, readiness reports unhealthy.
- Startup probe reports applied only after all expected migrations complete; readiness never references the migration state.
- Invalid options (for example a missing signing key in symmetric mode) stop the host at start; a code-configured value is reflected in both the validated and the wired copy.
- Every dependency check returns within its timeout when the dependency hangs.
- The starvation probe fails when the worker pool is saturated in a test harness.
- Each fail-open and fail-closed row above: one test with the dependency up, one with it down.
- A handler given a cancelled token stops within a bound.
- A retry policy test: non-idempotent request is not retried; jitter present. `[proposed]` for the reference system, which has no such test.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "The platform restarts crashed pods, we do not need drain" | Restart is not drain; in-flight requests are lost. |
| "One /health endpoint is simpler" | A dependency blip then restarts the fleet. |
| "Our dependency is reliable, no timeout" | Every dependency eventually hangs. |
| "Retries make it more reliable" | Without idempotency and jitter they make it less reliable. |
| "Fail closed everywhere is safest" | Availability helpers that fail closed become the outage. |

Red flags in a diff: a network call with no timeout; an unbounded read of a request body; a health check shared by probes with different purposes; a try/catch that swallows a dependency error with no metric; a retry wrapper around a create operation.

## 7. Checklist

- [ ] Body, header, duration, page, and depth limits are shared constants and enforced.
- [ ] Every outbound client carries the standard pipeline; retries only on idempotent calls (unsafe-method switch set).
- [ ] Shutdown flips readiness first; drain window is below the forced-stop timeout.
- [ ] Four probes with distinct contents; migrations only in startup; liveness has a starvation check; every check has a timeout.
- [ ] Security- and limit-bearing options validate on start, with cross-field rules.
- [ ] Fail-open and fail-closed list written down and tested both ways.
- [ ] Missing unsafe prerequisites fail startup; missing optimizations degrade with a metric.
- [ ] Handlers observe cancellation; client disconnects are not logged as errors.
