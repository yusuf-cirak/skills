---
name: observability
description: Instruments .NET/ASP.NET Core services with vendor-neutral OpenTelemetry (OTLP + any collector). Use when wiring telemetry in `Program.cs`, configuring exporters/processors/sampling, adding traces, metrics or logs, or setting up health checks/probes.
---

# Observability (OpenTelemetry-native, FAANG-level)

## Contents

- Pillars & setup → `dotnet:csharp`
- Traces
- Metrics (System.Diagnostics.Metrics)
- Logs (OTel-native) → `dotnet:hardening`
- Correlation & context → `dotnet:hardening`
- Health checks & probes (Kubernetes model)
- SLO & alerting
- Gotchas (hard-won)
- Related skills → `dotnet:hardening`, `dotnet:csharp`, `dotnet:testing`

## Files

- `dotnet:csharp` (`../csharp/SKILL.md`) — C# House Style
- `dotnet:hardening` (`../hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `dotnet:testing` (`../testing/SKILL.md`) — C# Testing Standard

Telemetry is **OpenTelemetry-native and OTLP-first**: traces (`ActivitySource` per module, `ParentBased` ratio sampling, W3C propagation incl. across messaging), metrics (`System.Diagnostics.Metrics` Meter API, RED + USE, low-cardinality tags, exemplars), and logs (`ILogger` → OpenTelemetry, source-generated `[LoggerMessage]` by default, snake_case templates, key/mask/baggage enrichment, tail sampling) share one `Resource` and one exporter, correlated by trace context with no enricher glue — plus correlation_id/baggage context, Kubernetes health probes with drain-on-shutdown, and SLOs with multi-window burn-rate alerts. These are non-negotiable defaults for any service; deviations need a written justification on the PR.

**Logging stance:** prefer OTel-native (`ILogger → AddOpenTelemetry`) for new services. Reach for Serilog **only** when OTel-native is not possible (a sink/format the OTLP pipeline can't provide). Don't run both.

**Vendor neutrality:** export OTLP and point it at *any* collector. SigNoz / Jaeger / Tempo / Grafana / Prometheus is an org/deploy choice, never baked into code. Override the endpoint with the standard `OTEL_EXPORTER_OTLP_ENDPOINT` (gRPC `:4317`).

## Pillars & setup

One `AddOpenTelemetry()`, one shared `Resource`, one OTLP exporter per signal. Centralize source/meter names as constants (see `csharp` → Constants).

```csharp
var resource = ResourceBuilder.CreateDefault()
    .AddService(serviceName, serviceVersion: version)
    .AddAttributes([
        new("deployment.environment", environment),
        new("host.name", Environment.MachineName),
        new("process.pid", Environment.ProcessId)
    ]);

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService(serviceName, serviceVersion: version))
    .WithTracing(t => t /* see Traces */)
    .WithMetrics(m => m /* see Metrics */);

builder.Logging.AddOpenTelemetry(o => { /* see Logs */ });
```

- Run the process in **UTC** (`TZ=UTC` + `TimeZoneInfo.ClearCachedData()`) before any date API is touched, so every timestamp lines up across signals.
- In tests, set `OTEL_SDK_DISABLED=true` so the exporters don't dial a dead `localhost:4317` (connection-refused noise + a flush delay on shutdown).

## Traces

- One `ActivitySource` **per module** (name = module). Instrument the framework: `AddAspNetCoreInstrumentation`, `AddHttpClientInstrumentation`, plus `AddSource(...)` for EF/`Npgsql`, `MassTransit`, and your own sources.
- **Sampling:** `SetSampler(new ParentBasedSampler(new TraceIdRatioBasedSampler(ratio)))`. Full traces in Development (`ratio = 1.0`), a configurable fraction in prod (default `0.2`). `ParentBased` honours the upstream's sampled decision so a distributed trace is kept or dropped coherently end-to-end; only root spans roll the ratio.
- **Tags are low-cardinality only** — `http.route`, `user.id` (opaque), `tenant.id`. Never free-form strings / full URLs / payloads as tag values.
- **Propagation:** W3C `traceparent` inbound + outbound (HttpClient auto-propagates). Across messaging, propagate the trace through broker headers and **re-parent** the consume span across the outbox boundary (a dedicated `ActivitySource` started from the restored context). MassTransit only re-parents from **its own envelope** — for **raw-JSON / externally-produced / CDC** messages it does not, so carry `traceparent` (+ `tracestate`) as explicit message headers and re-parent in a consume **pipeline filter**, restoring `correlation_id`/`causation_id` into baggage there too.
- `activity?.AddException(ex)` (or `RecordException`) on the span when handling an error; don't swallow it silently.

```csharp
.WithTracing(t => t
    .SetSampler(new ParentBasedSampler(new TraceIdRatioBasedSampler(traceRatio)))
    .AddAspNetCoreInstrumentation()
    .AddHttpClientInstrumentation()
    .AddSource("Npgsql")
    .AddSource("MassTransit")
    .AddSource(MyModule.ActivitySourceName)
    .AddOtlpExporter())
```

## Metrics (System.Diagnostics.Metrics)

Use the **`Meter` API**, never a bespoke counter. A `Meter` per module; instruments are fields.

- **RED** (request rate, errors, duration) comes from `AddAspNetCoreInstrumentation`; **USE** (CPU/memory/GC/thread-pool) from `AddRuntimeInstrumentation` + `AddProcessInstrumentation`. Wire custom meters with `AddMeter("…")` (mirrors `AddSource`).
- Instrument types: `Counter<T>` (monotonic — requests, errors), `UpDownCounter<T>` (in-flight, queue depth), `Histogram<T>` (latency, sizes), `ObservableGauge<T>` (sampled state — cache size, pool usage).
- **Low-cardinality tags only.** A tag dimension is `route`/`status_class`/`outcome` — **never** user id, tenant id, raw path, or any unbounded value (cardinality explosion melts the TSDB). Per-user data belongs on traces/logs, not metric tags.
- **Exemplars** link a metric bucket to a representative trace — enable them so a latency spike jumps straight to an exemplar span.

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

## Logs (OTel-native)

`ILogger` → OpenTelemetry → OTLP. Trace context (`trace_id`/`span_id`) is attached by the SDK automatically — logs correlate to traces with **no enricher**.

```csharp
builder.Logging.AddOpenTelemetry(o =>
{
    o.IncludeScopes = true;            // carry scope state (RequestId/TraceId/…)
    o.IncludeFormattedMessage = true;  // render the message body, not just the template
    o.ParseStateValues = true;         // expose structured state as individual attributes
    o.SetResourceBuilder(resource);
    o.AddProcessor(new BaggageLogRecordProcessor());       // correlation_id/causation_id/user_id from baggage
    o.AddProcessor(new SnakeCaseLogRecordProcessor());     // normalize attribute keys to snake_case
    o.AddProcessor(new SensitiveDataLogRecordProcessor()); // mask sensitive attribute VALUES
    o.AddOtlpExporter();
});

// Structured stdout parity (don't run a Serilog console alongside):
builder.Logging.AddJsonConsole(o => o.JsonWriterOptions = new() { Indented = false });
```

Rules:

- **Write snake_case property names in templates** — `[LoggerMessage(Message = "settled {order_id} in {elapsed_ms}")]` (source-generated logging is the default, see below; same rule for any inline template) — so app attributes land snake_cased without a rewrite pass. (Framework scope keys stay PascalCase; that's fine — see Gotchas.)
- **Sensitive masking is key-based** (a `FrozenSet` of sensitive attribute names → value becomes `***`), **never** a regex/string-scan over values. Mask `password`, `token`, `authorization`, `api_key`, card/PAN, `email`, `phone`, etc. (See `hardening` for the HTTP header allow-list + query-param redaction.)
- **Tail log sampling** (log *all* lines of an errored request; ~20% of healthy ones): implement with `Microsoft.Extensions.Telemetry` per-request buffering (`AddPerIncomingRequestBuffer` + `PerRequestLogBuffer.Flush()`) and flush on 5xx/exception. **Do NOT** try to drop records in a `BaseProcessor` — see Gotchas.
- Never log `Authorization`/`Cookie`/tokens or full request/response bodies; bodies off in Production.

### Source-generated logging (`[LoggerMessage]`, .NET 6+) — the default

**`[LoggerMessage]` partial methods are the default for ALL application logging** with a fixed
message — not just hot paths. The generator emits zero-allocation, strongly-typed log calls (no
boxing, no template parse per call), and the `Log` class doubles as the catalog of every event the
service emits. Inline `logger.LogInformation("…", args)` is acceptable only for throwaway dev-time
logging that won't ship. Enforce with analyzer **CA1848** — escalate it in `.editorconfig`:

```ini
dotnet_diagnostic.CA1848.severity = warning
```

```csharp
internal static partial class Log
{
    [LoggerMessage(EventId = 2001, Level = LogLevel.Information, Message = "settled {order_id} in {elapsed_ms}")]
    public static partial void OrderSettled(ILogger logger, string order_id, double elapsed_ms);
}
Log.OrderSettled(logger, id, ms); // snake_case names land snake_cased (see Rules)
```

## Correlation & context

- **`correlation_id`** is a durable, business-level id distinct from the (sampling-prone) trace id. Take it from inbound `X-Correlation-Id` **only if it parses as a GUID**, else generate a **UUIDv7** (`Guid.CreateVersion7()`, time-ordered). Reflecting a raw inbound header value into the response is a **CRLF / response-header-injection** vector — validate first.
- **Activity baggage is the single source of truth.** Set `correlation_id` once at the HTTP boundary (and restore it from message headers in the consume filter); baggage flows automatically over HttpClient and is surfaced on every log line by the baggage processor. Echo `X-Correlation-Id` + `X-Trace-Id` on the response.
- `causation_id` chains an effect to the event that caused it (set from the message header in consumers).
- **`user_id` / `client_ip`** are stamped onto baggage by an enrichment middleware that runs **after** authentication (so `User` is populated) **and** after forwarded headers (so `RemoteIpAddress` is the real client — see `hardening` → Forwarded Headers).

```csharp
var correlationId =
    Guid.TryParse(request.Headers["X-Correlation-Id"], out var g) ? g.ToString()
    : Activity.Current?.GetBaggageItem("correlation_id")
    ?? Guid.CreateVersion7().ToString();
Activity.Current?.SetBaggage("correlation_id", correlationId);
```

## Health checks & probes (Kubernetes model)

Three tag-partitioned probe groups; map each to its own endpoint and keep them `AllowAnonymous` + suppressed from request logs.

- **liveness** (`/health/liveness`) — process is alive; cheap in-process checks only (e.g. thread-pool starvation). Never probe dependencies here — a transient DB blip must not trigger a pod restart.
- **readiness** (`/health/readiness`) — dependencies reachable (Postgres/Redis/Kafka via `AspNetCore.HealthChecks.*`, tagged `ready`, 3s timeout each). The LB routes only when ready.
- **startup** (`/health/startup`) — one-time gates (EF migrations applied). External orchestration waits on this.
- **Drain-on-shutdown:** on `IHostApplicationLifetime.ApplicationStopping` (SIGTERM), a readiness check flips **Unhealthy** *before* the in-flight drain, so the LB stops routing here and a rolling deploy drains cleanly instead of bursting 502s. Set host `ShutdownTimeout` above the drain budget.

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

## SLO & alerting

- This skill owns **RED + USE**. Define SLOs (e.g. p99 latency, availability) per endpoint/journey, not per host.
- Alert on **error-budget burn rate with multiple windows** (fast 5m/1h to catch acute outages, slow 6h/3d to catch slow burns) — not on raw threshold breaches, which page on every blip.
- Dashboards: one RED panel per endpoint; one USE panel per host/pod; a trace-explorer linked from latency exemplars.
- Sampling trade-off: head sampling (set here, cheap, may miss rare errors) vs tail sampling (in the collector, keeps all error traces, costs buffering). Pick per cost/fidelity need.

## Gotchas (hard-won)

- A **`BaseProcessor<LogRecord>` cannot drop a record** — the exporter processor always runs after yours. For sampling/dropping, buffer per-request (`Microsoft.Extensions.Telemetry`) and decide at request end; processors are for *enrich/redact only*.
- **`LogRecord.ScopeProvider` is internal** — you can't cleanly rewrite framework scope keys (`RequestId`/`TraceId`/…) to snake_case from a processor. Don't fight it: snake_case the keys *you* control (your message templates / state); leave framework scope keys as-is.
- The **baggage→log processor is on the hottest path** — make it allocation-minimal: read a **known key set with `GetBaggageItem`** instead of enumerating `Activity.Baggage` (whose getter allocates an iterator); allocate nothing when there's nothing to add; build one pre-sized list otherwise; **snapshot** values (the record may export later on a batch thread, off the originating Activity).
- OTLP gRPC talks **h2c** to the collector — a plain `http://…:4317` endpoint is expected; no TLS in-cluster.
- Metrics export on a **flush interval (~60s)** — when verifying locally, generate load and wait before expecting points; traces/logs appear immediately.

## Related skills

- `dotnet:hardening` — security headers, HTTP-logging redaction + header allow-list, rate limiting, forwarded headers (real client IP), error/ProblemDetails shape.
- `dotnet:csharp` — centralized constants (source/meter/baggage names), allocation-minimal hot-path idioms, `Guid.CreateVersion7`.
- `dotnet:testing` — `ActivityListener` to test middleware/baggage; `OTEL_SDK_DISABLED` in integration tests.
