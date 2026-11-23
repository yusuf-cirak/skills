# Setup: Polly v8 resilience packages and pipelines

Load when adding resilience to an `HttpClient` or building a custom pipeline. The rules (retry only idempotent calls, SSRF handler placement, hedging) live in `../resilience.md`.

Needs .NET 8+ and Polly v8 (`Microsoft.Extensions.Http.Resilience` for `HttpClient`, `Polly.Core` for general pipelines). Polly v8 replaced the legacy `Policy` API with `ResiliencePipeline`.

## Default: standard handler

```csharp
builder.Services.AddHttpClient<CatalogClient>()
    .AddStandardResilienceHandler(); // total-timeout + retry + circuit-breaker + per-try-timeout + hedging
```

Tune through the options overload only when a downstream needs it.

## Custom pipeline

Order is outer to inner, each strategy wraps the next: `rate-limiter`, `total-timeout`, `retry`, `circuit-breaker`, `per-try-timeout`, `hedging`.

```csharp
new ResiliencePipelineBuilder<HttpResponseMessage>()
    .AddRetry(new()
    {
        MaxRetryAttempts = 3,
        BackoffType = DelayBackoffType.Exponential,
        UseJitter = true, // mandatory: un-jittered retries synchronise into thundering herds
    })
    .AddTimeout(TimeSpan.FromSeconds(10))
    .AddCircuitBreaker(new() { FailureRatio = 0.5, MinimumThroughput = 20, BreakDuration = TimeSpan.FromSeconds(30) })
    .Build();
```

## Chaos in tests

Inject faults and latency with `AddChaosFault` / `AddChaosLatency` (Polly.Chaos, Simmy) to prove the pipeline degrades gracefully before production does.
