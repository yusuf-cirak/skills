# Resilience pipelines (single source of truth)

## Contents

- Rules
- Related

> Requires .NET 8+ and Polly v8. Owned by `yusufcirak-skills:csharp-hardening`; every outbound `HttpClient` uses one.

Do not hand-roll retries or timeouts on `HttpClient`. Default for typed clients is `AddStandardResilienceHandler()` (total-timeout, retry, circuit-breaker, per-try-timeout, hedging); tune it only when a downstream needs it. Custom pipelines order strategies outer to inner: rate-limiter, total-timeout, retry, circuit-breaker, per-try-timeout, hedging. Packages, registration and the custom pipeline code: `setups/resilience.md`.

## Rules

- **Retry only idempotent operations.** A non-idempotent POST without an `Idempotency-Key` (see `yusufcirak-skills:csharp-hardening` → Idempotency) must not be auto-retried.
- Jitter on retries is mandatory: un-jittered retries synchronise into thundering herds.
- The **SSRF `DelegatingHandler`** (see `yusufcirak-skills:csharp-hardening` → SSRF) composes **inside** the resilience handler, so resilience cannot defeat the IP allow-list.
- Pipelines emit OpenTelemetry metrics and traces out of the box; wire them through the existing OTLP exporter (`yusufcirak-skills:csharp-observability`).
- **Hedging** (parallel attempt to a second replica) cuts tail latency. Enable it only where the operation is safe to run twice.
- **Chaos in tests:** inject faults and latency to prove the pipeline degrades gracefully before production does.

## Related

- `yusufcirak-skills:csharp-hardening` (`../csharp-hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `yusufcirak-skills:csharp-observability` (`../csharp-observability/SKILL.md`) — Observability (OpenTelemetry-native, FAANG-level)
