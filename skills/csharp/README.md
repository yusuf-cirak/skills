# C#

C# / .NET / ASP.NET Core house style. `csharp` is the entry point: core rules, the shared `references/`, and a signal table that routes to the `csharp-*` siblings. Invoke it before the first edit on any C# work, then every sibling whose signal appears.

## User-invoked

None yet. A skill joins this group when it sets `disable-model-invocation: true`.

## Model-invoked

Model- or user-reachable.

- **[csharp](./csharp/SKILL.md)**: Core style (namespaces, immutable records with factories, discriminated unions, value objects, `Result<T>`, `TimeProvider`, typed HTTP clients) plus `references/` for LINQ, performance, async, composition, EF Core, caching, resilience, build and analyzers, outbox.
- **[csharp-ddd](./csharp-ddd/SKILL.md)**: DDD tactical patterns, Modular Monolith and Vertical Slice layout, where new code lives.
- **[csharp-web-api](./csharp-web-api/SKILL.md)**: Endpoint, handler and slice shape, mediator pipeline, FluentValidation basics, pagination, middleware order.
- **[csharp-validation](./csharp-validation/SKILL.md)**: `InputLimits`, length-typed `Text` value objects, mandatory validator rules, JSON and Kestrel limits, output encoding.
- **[csharp-hardening](./csharp-hardening/SKILL.md)**: Rate limiting, idempotency, authn/authz, security headers, crypto, EF hardening, SSRF, background jobs, supply chain, CI gates.
- **[csharp-observability](./csharp-observability/SKILL.md)**: OpenTelemetry-native traces, metrics and logs over OTLP, correlation ids, health probes, SLOs.
- **[csharp-testing](./csharp-testing/SKILL.md)**: Test layout and naming, AAA, asserting on monads, Testcontainers integration tests, architecture tests.
