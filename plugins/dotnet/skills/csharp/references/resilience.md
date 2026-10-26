# Resilience pipelines (single source of truth)

## Contents

- Default — standard handler
- Custom pipeline — strategy ordering
- Rules
- Related

> Requires .NET 8+ and Polly v8 (`Microsoft.Extensions.Http.Resilience` / `Polly.Core`). Owned by
> `dotnet:hardening`; every outbound `HttpClient` uses one.

Polly v8 replaced the legacy `Policy` API with **`ResiliencePipeline`**. `Microsoft.Extensions.Http.Resilience`
ships a batteries-included handler. Do not hand-roll retries/timeouts on `HttpClient`.

## Default — standard handler

```csharp
builder.Services.AddHttpClient<CatalogClient>()
    .AddStandardResilienceHandler(); // total-timeout + retry + circuit-breaker + per-try-timeout + hedging
```

This is the default for typed clients. Tune via the options overload only when a downstream needs it.

## Custom pipeline — strategy ordering

Order is **outer → inner**; each strategy wraps the next:

`rate-limiter → total-timeout → retry → circuit-breaker → per-try-timeout → hedging`

```csharp
new ResiliencePipelineBuilder<HttpResponseMessage>()
    .AddRetry(new()
    {
        MaxRetryAttempts = 3,
        BackoffType = DelayBackoffType.Exponential,
        UseJitter = true, // mandatory — un-jittered retries synchronise into thundering herds
    })
    .AddTimeout(TimeSpan.FromSeconds(10))
    .AddCircuitBreaker(new() { FailureRatio = 0.5, MinimumThroughput = 20, BreakDuration = TimeSpan.FromSeconds(30) })
    .Build();
```

## Rules

- **Retry only idempotent operations.** A non-idempotent POST without an `Idempotency-Key`
  (see `dotnet:hardening` → Idempotency) must not be auto-retried.
- The **SSRF `DelegatingHandler`** (see `dotnet:hardening` → SSRF) composes **inside** the resilience handler —
  resilience must not defeat the IP allow-list.
- Pipelines **emit OpenTelemetry** metrics/traces out of the box; wire them through the existing OTLP
  exporter (`dotnet:observability`).
- **Hedging** (parallel attempt to a second replica) cuts tail latency — enable only where the
  operation is safe to run twice.
- **Chaos in tests:** inject faults/latency with `AddChaosFault` / `AddChaosLatency` (Polly.Chaos /
  Simmy) to prove the pipeline degrades gracefully before production does.

## Related

- `dotnet:hardening` (`../hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `dotnet:observability` (`../observability/SKILL.md`) — Observability (OpenTelemetry-native, FAANG-level)
