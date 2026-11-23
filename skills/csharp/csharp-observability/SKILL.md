---
name: csharp-observability
description: Instruments .NET/ASP.NET Core services with vendor-neutral OpenTelemetry (OTLP + any collector). Use when wiring telemetry in `Program.cs`, configuring exporters/processors/sampling, adding traces, metrics or logs, or setting up health checks/probes.
---

# Observability (OpenTelemetry-native, FAANG-level)

## Contents

- What we require
  - The three signals
  - Logs
  - Traces
  - Metrics
  - Correlation & context
  - Health & probes
  - SLO & alerting
- OpenTelemetry specifics (SDK, exporters, pipeline)
  - Setup → `../csharp/references/setups/observability.md`
  - Traces
  - Metrics
  - Logs → `yusufcirak-skills:csharp-hardening`
  - Gotchas (hard-won)
- Related skills → `yusufcirak-skills:csharp-hardening`, `yusufcirak-skills:csharp`, `yusufcirak-skills:csharp-testing`

## Files

- `../csharp/references/setups/observability.md` — Setup: OpenTelemetry registration
- `yusufcirak-skills:csharp` (`../csharp/SKILL.md`) — C# House Style
- `yusufcirak-skills:csharp-hardening` (`../csharp-hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `yusufcirak-skills:csharp-testing` (`../csharp-testing/SKILL.md`) — C# Testing Standard

Every handler, worker and endpoint logs, traces and measures its important actions and outcomes, edge cases included. The first half of this skill is what we require from each signal, with the .NET conventions that apply whatever the exporter is. The second half is only what is specific to OpenTelemetry (SDK wiring, processors, sampling, propagation) and the traps we hit there. These are non-negotiable defaults; deviations need a written justification on the PR.

## What we require

### The three signals

- **Logs** record discrete events: what happened and why, with the context to understand one occurrence.
- **Traces** follow one request across modules and services: where the time went and which hop failed.
- **Metrics** are aggregated numbers over time, the source for dashboards, SLOs and alerts. Cheap to store, so their dimensions stay few.

Per-user and per-request detail goes to traces and logs. Only bounded, aggregate dimensions go to metrics. All three share one resource identity (service, version, environment, host), one protocol (OTLP) and one trace context, so a log line, a span and a metric exemplar join without glue code. Export OTLP to any collector: SigNoz, Jaeger, Tempo, Grafana or Prometheus is a deploy choice, never baked into code. Run the process in UTC (`TZ=UTC` and `TimeZoneInfo.ClearCachedData()` before any date API) so timestamps line up across signals.

### Logs

- Log every important action and its outcome, and every edge case (rejected, skipped, retried, degraded). Silence on a failure path is a defect.
- **`[LoggerMessage]` source-generated methods are the default for all application logging with a fixed message**, not just hot paths. They emit zero-allocation, strongly typed calls (no boxing, no template parse per call), and the `Log` class doubles as the catalog of every event the service emits. Inline `logger.LogInformation("...", args)` is only for throwaway dev-time logging. Enforce with analyzer CA1848 escalated to a warning in `.editorconfig` (see the setup file).
- Keep each message minimal. Context that holds for the whole operation (entity id, user, tenant, correlation) is attached once with `ILogger.BeginScope` (or baggage) where the operation starts, and every line inside inherits it. A message carries only what is specific to that event (the outcome, a count, a status). Before adding a field to a message or scope, check what is already in scope (handler, middleware, job, parent handler, baggage) and never add it twice. If a needed field is missing, add it to the scope at the entry point instead of passing it into each `[LoggerMessage]`.
- Attribute names are snake_case, written that way in the template: `[LoggerMessage(Message = "settled {order_id} in {elapsed_ms}")]`. Framework scope keys stay PascalCase, which is fine (see Gotchas).
- Sensitive data is masked by attribute key (a `FrozenSet` of names such as `password`, `token`, `authorization`, `api_key`, card/PAN, `email`, `phone`; the value becomes `***`), never by scanning values. Never log `Authorization`, `Cookie`, tokens or full request/response bodies; bodies are off in Production. Header allow-list and query-param redaction: `csharp-hardening`.
- Keep every line of a failed request and a sample (about 20%) of healthy ones.
- One logging pipeline. Prefer OTel-native `ILogger`; use Serilog only when the OTLP pipeline cannot provide a needed sink or format, and never run both.

```csharp
internal static partial class Log
{
    [LoggerMessage(EventId = 2001, Level = LogLevel.Information, Message = "settled {order_id} in {elapsed_ms}")]
    public static partial void OrderSettled(ILogger logger, string order_id, double elapsed_ms);
}
Log.OrderSettled(logger, id, ms);
```

### Traces

- One `ActivitySource` per module, named after the module.
- Record errors on the span (`activity?.AddException(ex)` or `RecordException`), never swallow them.
- Span tags are low-cardinality (`http.route`, opaque `user.id`, `tenant.id`). Never free-form strings, full URLs or payloads.
- Trace context propagates over HTTP and across messaging, including across the outbox boundary: the consumer's span is re-parented from the producer's context.
- Sampling honours the upstream decision so a distributed trace is kept or dropped as a whole. Full traces in Development, a configurable fraction in production.

### Metrics

- **RED** (rate, errors, duration) for every request path and **USE** (utilisation, saturation, errors: CPU, memory, GC, thread pool) for every host.
- Business outcomes get their own counters and histograms, one `Meter` per module, created from `IMeterFactory`. Use the `System.Diagnostics.Metrics` API, never a bespoke counter.
- Instrument types: `Counter<T>` (monotonic: requests, errors), `UpDownCounter<T>` (in-flight, queue depth), `Histogram<T>` (latency, sizes), `ObservableGauge<T>` (sampled state: cache size, pool usage).
- Tags are low-cardinality only: `route`, `status_class`, `outcome`. Never user id, tenant id, raw path or any unbounded value, because cardinality explosion melts the time-series database.
- Latency histograms carry exemplars, so a spike links to a representative trace.

```csharp
public sealed class OrderMetrics
{
    public const string MeterName = "MyApp.Orders";
    private readonly Counter<long> _placed;
    private readonly Histogram<double> _settleMs;

    public OrderMetrics(IMeterFactory factory)
    {
        var meter = factory.Create(MeterName);
        _placed   = meter.CreateCounter<long>("orders.placed");
        _settleMs = meter.CreateHistogram<double>("orders.settle.duration", unit: "ms");
    }

    public void Placed(string outcome) => _placed.Add(1, new KeyValuePair<string, object?>("outcome", outcome));
    public void Settled(double ms)      => _settleMs.Record(ms);
}
```

### Correlation & context

- `correlation_id` is a durable business-level id, distinct from the sampling-prone trace id. Accept the inbound `X-Correlation-Id` only if it parses as a GUID, otherwise generate a UUIDv7 (`Guid.CreateVersion7()`, time-ordered). Reflecting a raw inbound header into the response is a CRLF / response-header-injection vector, so validate first. Echo `X-Correlation-Id` and `X-Trace-Id` on the response.
- Set context (correlation, causation, user, client IP) once at the boundary into Activity baggage, the single source of truth. It flows over `HttpClient`, is restored from message headers in consumers, and appears on every log line without being passed explicitly.
- `causation_id` chains an effect to the event that caused it (taken from the message header in consumers).
- `user_id` and `client_ip` are stamped by an enrichment middleware that runs after authentication (so `User` is populated) and after forwarded headers (so `RemoteIpAddress` is the real client; see `csharp-hardening` → Forwarded Headers).

```csharp
var correlationId =
    Guid.TryParse(request.Headers["X-Correlation-Id"], out var g) ? g.ToString()
    : Activity.Current?.GetBaggageItem("correlation_id")
    ?? Guid.CreateVersion7().ToString();
Activity.Current?.SetBaggage("correlation_id", correlationId);
```

### Health & probes

Three tag-partitioned groups mapped to `/health/liveness`, `/health/readiness` and `/health/startup`, all `AllowAnonymous` and suppressed from request logs.

- **liveness**: the process is alive. In-process checks only (e.g. thread-pool starvation). Never probe dependencies here, because a transient database blip must not restart the pod.
- **readiness**: dependencies are reachable (Postgres, Redis, Kafka via `AspNetCore.HealthChecks.*`, tagged `ready`, 3 s timeout each). The load balancer routes only when ready.
- **startup**: one-time gates such as EF migrations. Orchestration waits on it.
- **Drain on shutdown**: on `IHostApplicationLifetime.ApplicationStopping` (SIGTERM) readiness flips Unhealthy before the in-flight drain, so the load balancer stops routing first and a rolling deploy does not burst 502s. Set host `ShutdownTimeout` above the drain budget.

```csharp
internal sealed class ShutdownReadinessHealthCheck : IHealthCheck
{
    private volatile bool _stopping;
    public ShutdownReadinessHealthCheck(IHostApplicationLifetime life) =>
        life.ApplicationStopping.Register(() => _stopping = true);
    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext _, CancellationToken __ = default) =>
        Task.FromResult(_stopping ? HealthCheckResult.Unhealthy("draining") : HealthCheckResult.Healthy());
}
```

### SLO & alerting

- Define SLOs (p99 latency, availability) per endpoint or journey, not per host.
- Alert on error-budget burn rate with multiple windows (fast 5m/1h for acute outages, slow 6h/3d for slow burns), not on raw thresholds that page on every blip.
- Dashboards: one RED panel per endpoint, one USE panel per host or pod, a trace explorer linked from latency exemplars.
- Head sampling is cheap but may miss rare errors; tail sampling in the collector keeps every error trace but costs buffering. Pick per cost and fidelity need.

## OpenTelemetry specifics (SDK, exporters, pipeline)

### Setup

One `AddOpenTelemetry()`, one shared `Resource`, one OTLP exporter per signal. Centralize source and meter names as constants (see `csharp` → Constants). Registration code for resource, tracing, metrics, OTLP exporters and logging processors: `../csharp/references/setups/observability.md`.

- Override the collector endpoint with the standard `OTEL_EXPORTER_OTLP_ENDPOINT` (gRPC `:4317`).
- In tests set `OTEL_SDK_DISABLED=true` so the exporters do not dial a dead `localhost:4317` (connection-refused noise and a flush delay on shutdown).

### Traces

- Instrument the framework with `AddAspNetCoreInstrumentation` and `AddHttpClientInstrumentation`, plus `AddSource(...)` for EF/`Npgsql`, `MassTransit` and your own sources.
- **Sampler:** `SetSampler(new ParentBasedSampler(new TraceIdRatioBasedSampler(ratio)))`, `ratio = 1.0` in Development and a configurable fraction in prod (default `0.2`). `ParentBased` honours the upstream decision, so only root spans roll the ratio.
- **Propagation:** W3C `traceparent` inbound and outbound (`HttpClient` propagates automatically). Across messaging, carry the trace through broker headers and re-parent the consume span with a dedicated `ActivitySource` started from the restored context. MassTransit re-parents only from its own envelope. For raw-JSON, externally produced or CDC messages it does not, so carry `traceparent` (and `tracestate`) as explicit message headers and re-parent in a consume pipeline filter, restoring `correlation_id` and `causation_id` into baggage there too.

### Metrics

- RED comes from `AddAspNetCoreInstrumentation`; USE from `AddRuntimeInstrumentation` and `AddProcessInstrumentation`.
- Wire custom meters with `AddMeter("...")` (mirrors `AddSource`) and enable exemplars on the metrics pipeline.

### Logs

`ILogger` → OpenTelemetry → OTLP. The SDK attaches `trace_id` and `span_id` automatically, so logs correlate to traces with no enricher.

- Wire `builder.Logging.AddOpenTelemetry` with the baggage, snake_case and sensitive-data processors, the OTLP exporter and a JSON console (`../csharp/references/setups/observability.md`).
- **Tail log sampling:** use `Microsoft.Extensions.Telemetry` per-request buffering (`AddPerIncomingRequestBuffer` plus `PerRequestLogBuffer.Flush()`), flushed on 5xx or exception. Do not try to drop records in a `BaseProcessor` (see Gotchas).
- The baggage processor surfaces `correlation_id`, `causation_id` and `user_id` on every record.

### Gotchas (hard-won)

- A **`BaseProcessor<LogRecord>` cannot drop a record**: the exporter processor always runs after yours. For sampling or dropping, buffer per request and decide at request end. Processors are for enrich and redact only.
- **`LogRecord.ScopeProvider` is internal**, so a processor cannot cleanly rewrite framework scope keys (`RequestId`, `TraceId`, ...) to snake_case. Snake_case the keys you control (templates and state) and leave framework scope keys as they are.
- The **baggage-to-log processor is on the hottest path**: keep it allocation-minimal. Read a known key set with `GetBaggageItem` instead of enumerating `Activity.Baggage` (its getter allocates an iterator), allocate nothing when there is nothing to add, build one pre-sized list otherwise, and snapshot values (the record may export later on a batch thread, off the originating Activity).
- OTLP gRPC talks **h2c** to the collector: a plain `http://...:4317` endpoint is expected, no TLS in-cluster.
- Metrics export on a **flush interval (about 60 s)**. When verifying locally, generate load and wait before expecting points; traces and logs appear immediately.

## Related skills

- `yusufcirak-skills:csharp-hardening`: security headers, HTTP-logging redaction + header allow-list, rate limiting, forwarded headers (real client IP), error/ProblemDetails shape.
- `yusufcirak-skills:csharp`: centralized constants (source/meter/baggage names), allocation-minimal hot-path idioms, `Guid.CreateVersion7`.
- `yusufcirak-skills:csharp-testing`: `ActivityListener` to test middleware/baggage; `OTEL_SDK_DISABLED` in integration tests.
