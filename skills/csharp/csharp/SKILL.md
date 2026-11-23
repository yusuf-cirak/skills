---
name: csharp
description: Applies the C# house style and routes to the sibling skills. ALWAYS use before writing, editing, or reviewing any C#/.NET code (`.cs`, `.csproj`, `.slnx`, `Directory.Packages.props`), including every new feature, endpoint, handler, consumer or job, and for questions about C# idioms. Entry point that routes to csharp-ddd, csharp-web-api, csharp-validation, csharp-hardening, csharp-observability and csharp-testing.
---
# C# House Style

## Contents

- Route first → `yusufcirak-skills:csharp-ddd`, `yusufcirak-skills:csharp-web-api`, `yusufcirak-skills:csharp-validation`, `yusufcirak-skills:csharp-hardening`, `yusufcirak-skills:csharp-observability`, `yusufcirak-skills:csharp-testing`
- Then load references → every file under `references/` (table)
- Namespaces & file organization
- Async methods → `references/async-concurrency.md`
- Immutability & records
- Discriminated unions
- State as types → `references/state-as-types.md`
- Value objects → `references/value-object-base.md`, `yusufcirak-skills:csharp-validation`
- Errors → `references/monads.md`
- Modern C#
- Time → `yusufcirak-skills:csharp-testing`
- Outbound HTTP → `references/resilience.md`, `yusufcirak-skills:csharp-hardening`
- Constants → `yusufcirak-skills:csharp-validation`
- Decision notes

## Files

- `references/state-as-types.md` — State as types — polymorphic state machines (no boolean flags)
- `references/value-object-base.md` — Value Object base type + converters
- `references/monads.md` — Monadic error handling (Railway Oriented Programming)
- `references/linq.md` — C# LINQ
- `references/performance.md` — C# Performance
- `references/async-concurrency.md` — C# Async, Concurrency & Background Work
- `references/composition.md` — C# Composition: Options, Extensions, DI, Library Surface
- `references/ef-core-data-access.md` — EF Core data access — performance & value-object persistence (single source of truth)
- `references/mediator.md` — Mediator selection & licensing (single source of truth)
- `references/mapping.md` — Object mapping
- `references/setups/mediator.md` — Setup: mediator package and registration
- `references/setups/monads.md` — Setup: Result/Option library selection
- `references/setups/caching.md` — Setup: hybrid cache library
- `references/setups/resilience.md` — Setup: Polly v8 packages and pipelines
- `references/setups/outbox.md` — Setup: Debezium connector and polling relay
- `references/setups/build-analyzers.md` — Setup: analyzers, generators, build props
- `references/setups/observability.md` — Setup: OpenTelemetry registration
- `references/setups/rate-limiting.md` — Setup: rate limiter and Redis backend
- `references/setups/testing-stack.md` — Setup: test project and package stack
- `references/setups/optional-libraries.md` — Setup: ZLinq, ZString, Mapperly, Ardalis.GuardClauses
- `references/resilience.md` — Resilience pipelines (single source of truth)
- `references/root-client.md` — Root client + typed sub-clients
- `references/caching.md` — Application caching — hybrid L1/L2 (shared reference)
- `references/input-limits.md` — InputLimits constants
- `references/build-and-analyzers.md` — Build & analyzers — gates and policy
- `references/outbox-debezium-masstransit.md` — Outbox → Debezium → Kafka → MassTransit — the concrete traps
- `yusufcirak-skills:csharp-ddd` (`../csharp-ddd/SKILL.md`) — .NET Domain-Driven Design & Architecture
- `yusufcirak-skills:csharp-web-api` (`../csharp-web-api/SKILL.md`) — ASP.NET Core Web API
- `yusufcirak-skills:csharp-validation` (`../csharp-validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
- `yusufcirak-skills:csharp-hardening` (`../csharp-hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `yusufcirak-skills:csharp-observability` (`../csharp-observability/SKILL.md`) — Observability (OpenTelemetry-native, FAANG-level)
- `yusufcirak-skills:csharp-testing` (`../csharp-testing/SKILL.md`) — C# Testing Standard

Permanent C# rules for this codebase. Every `.cs` edit follows the core below; branch topics sit one pointer away in `references/`; sibling skills own their own surface. When a framework or language version blocks a rule, write the closest equivalent and say why.

## Route first

Before the first edit, and again each time the work changes shape, collect signals from what you **touch** (paths, project files), what you **write** (constructs), and what the **user asks**. Invoke every sibling whose signal is present, via the Skill tool. Combinations are the norm; when a signal is ambiguous, load the skill.


| Skill                                    | Load when you see…                                                                                                                                                                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yusufcirak-skills:csharp-ddd`           | Any work that requires you to do modeling with entities, aggregates, domain events, strongly-typed ids; `Domain/`, `Modules/<X>/`, `BuildingBlocks/`; "module", "layer", "bounded context"; deciding **where** new code lives                                                     |
| `yusufcirak-skills:csharp-web-api`       | `Controllers/`, `Endpoints/`, `[Http*]`, `MapGet/MapPost`, `IRequestHandler`/mediator, slice files, `Program.cs` middleware order, pagination shape                                                                                                                               |
| `yusufcirak-skills:csharp-validation`    | a request DTO/command/query; any caller-supplied string or file; `AbstractValidator`; length/size/depth limits; `Regex`; `JsonSerializerOptions`/Kestrel/`FormOptions`; output encoding                                                                                           |
| `yusufcirak-skills:csharp-hardening`     | endpoints and handlers, auth/authz, secrets, rate limiting, idempotency, caching, outbound HTTP/queues, file upload, SSRF, `ProblemDetails`, raw SQL, background jobs, multi-tenancy; untrusted text going to an LLM or prompt                                                    |
| `yusufcirak-skills:csharp-observability` | Mostly in every handler, worker and endpoint. Important actions and outcomes, edge cases needs to be logged, traced and have meaningful metrics.                                                                                                                                  |
| `yusufcirak-skills:csharp-testing`       | Any new feature or functionality or altering the existing ones that can be tested.                                                                                                                                                                                                |


Typical bundles (the signals decide): new feature slice → ddd + web-api + validation + hardening + observability + testing; endpoint change → web-api + validation (+ testing); security fix → hardening + validation + testing; LLM call → hardening + validation + observability + testing; service bootstrap → web-api + hardening + observability + validation.

Re-route at these checkpoints: a new file type or layer enters the change; a log statement is added; a request type or user-supplied string appears; an outbound call (HTTP, LLM, queue) is added; the first test is written; and once more over the final diff before reporting done.

## Then load references

Same rule as the sibling table: collect signals from what you **touch**, **write** and are **asked**, then open every reference whose signal appears (read it before the edit, not after). Check again at the same checkpoints as routing.

| Reference                                                                     | Open when you see…                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `references/linq.md`                                                          | `Select`/`SelectMany`/`GroupBy`/`Join`/`Aggregate`, a `foreach` that accumulates, an `IQueryable` projection, LINQ on a per-request or per-message path                                  |
| `references/performance.md`                                                   | a per-request/record/message path, string building or concat in a loop, `MemoryStream`, a closure on a hot path, `List<T>` growth, JSON source-gen or Native AOT                           |
| `references/async-concurrency.md`                                             | `async`/`await`, `ConfigureAwait`, `ValueTask`, `CancellationToken`, `Parallel.ForEachAsync`, `Channel<T>`, `BackgroundService`, a lock or semaphore                                       |
| `references/composition.md`                                                   | `IOptions<T>`, `AddX`/`UseX` extensions, keyed DI, guard clauses, a library or NuGet package surface, XML docs                                                          |
| `references/state-as-types.md`                                                | an entity with a `Status`/`State` enum or bool flags, "approve/reject/cancel" transitions                                                                                                  |
| `references/value-object-base.md`, `references/strongly-typed-ids-and-value-objects.md` | a new value object, a typed id, `Vogen`, EF or JSON converters for them                                                                                                          |
| `references/monads.md`                                                        | `Result<T>`/`Option<T>`, a chain of fallible steps, `try`/`catch` for expected failures, nullable returns for "not found"                                                                  |
| `references/ef-core-data-access.md`                                           | `DbContext`, `IQueryable`, `Include`, paging, `SaveChanges`, bulk work, migrations, value-object columns                                                                                   |
| `references/mediator.md`                                                      | `IRequest`, `IRequestHandler`, `IPipelineBehavior`, `AddMediator`/`AddMediatR`, a new handler                                                                                              |
| `references/mapping.md`                                                       | converting one object to another (`ToDto`, `ToResponse`, an AutoMapper/Mapperly mention)                                                                                                   |
| `references/resilience.md`                                                    | `HttpClient`, `AddHttpClient`, a call to another service, retry/timeout/circuit-breaker, Polly                                                                                             |
| `references/root-client.md`                                                   | one platform with several downstream APIs, a client class wrapping a third-party SDK                                                                                                       |
| `references/caching.md`                                                       | `IMemoryCache`, `IDistributedCache`, `HybridCache`, FusionCache, "cache this", Redis reads                                                                                                 |
| `references/input-limits.md`                                                  | `InputLimits`, a `MaximumLength` or size cap, a request DTO                                                                                                                                |
| `references/build-and-analyzers.md`                                           | `Directory.Build.props`, `TreatWarningsAsErrors`, an analyzer or source-generator package, `WarningsNotAsErrors`                                                                           |
| `references/outbox-debezium-masstransit.md`                                   | outbox table, domain event publishing, Debezium, Kafka, MassTransit consumer, inbox dedup                                                                                                  |

## Namespaces & file organization

- File-scoped namespaces; namespace mirrors folder structure.
- One type per file; a type used only inside one file may stay there.
- `GlobalUsings.cs` carries the cross-file usings.
- Service registration lives in `DependencyInjection.cs`, split into partials (`DependencyInjection.Database.cs`, `DependencyInjection.Observability.cs`) as it grows.

## Async methods

- Every method that returns `Task`, `Task<T>`, `ValueTask`, `ValueTask<T>` or `IAsyncEnumerable<T>` ends with `Async` (`GetTokenAsync`), on the interface and every implementation. Names a framework or interface dictates (`Handle`, `Invoke`, `ExecuteAsync`, event handlers) keep that name.
- Every async method takes `CancellationToken cancellationToken = default` as its **last** parameter and passes it to every awaited call below it (`DbContext`, `HttpClient`, other async methods). A token that is accepted and then ignored is a bug. Handlers and endpoints receive the token from the framework and forward it (a framework-dictated signature without the default stays as the framework defines it).
- `CancellationToken.None` mid-chain only when the work must outlive the caller, with a comment saying why.
- Pool/channel/background-work details: `references/async-concurrency.md`.

## Immutability & records

- Immutable by default; `record` over `class` for immutable types.
- Properties on the same line as the record declaration.
- Every `record <Name>` has a `<Name>Factory` static class in the **same file**, exposing `Create` (one factory per variant for unions/value objects). Argument validation lives in `Create`; callers construct through the factory.
- Collections inside records are immutable. `ImmutableArray<T>` is the default (built once, read afterward); `ImmutableList<T>` fits persistent snapshots that derive many incremental versions.
- Record behavior lives in extension methods in separate static classes, so records stay data.

## Discriminated unions

Abstract base record + sealed derived records, the whole union in one file, one static factories class per union with one factory method per variant. Record rules above apply.

## State as types

An entity with state-specific operations models state as types: payload → discriminated union; entity → abstract base + sealed per-state subtypes. Each operation exists only on the states where it is legal. Capability interfaces (`IApprovable`/`IRejectable`) mark transitions; `Try*` methods pattern-match and return a new immutable state. A subtype's construction guard (`Assert<T1,T2>()`) restricts which states it can wrap. `_ => throw` arms cover genuinely impossible states; expected outcomes return a state. Full worked example: `references/state-as-types.md`.

## Value objects

Records, the whole value object in one file, one static factories class with one method per variant, inheriting `ValueObject` / `ValueObject<T>`. Base type, `Text` example, JSON and EF converters: `references/value-object-base.md`. Length-typed `Text` VOs for request DTOs (`ShortText`/`MediumText`/…) live in `yusufcirak-skills:csharp-validation`.

## Errors

`Result<T>` / `Option<T>` carry expected failures and optionals; exceptions signal programmer error and truly exceptional states. Use the codebase's existing monad (`YC.Monad` by default). Idea: `references/monads.md`; picking and installing a library: `references/setups/monads.md`.

## Modern C#

- `<Nullable>enable</Nullable>` project-wide; `required` members express construction-time contracts.
- Collection expressions `[..]` for init and spread (`int[] ids = [..left, ..right, 0];`), preferred over `.Concat().ToArray()` for fixed shapes.
- Primary constructors on services, DI types, and records; explicit `_field` on mutable stateful classes where the captured parameter would mask a field.
- List/property patterns over index-and-length checks; `file`-local types for single-file helpers.
- `field` keyword (C# 14) for validated properties without a hand-declared backing field.
- `static` lambdas on hot paths; `params ReadOnlySpan<T>` for hot variadic APIs.

## Time

`TimeProvider` is the time abstraction: inject it and call `timeProvider.GetUtcNow()` / `GetTimestamp()` / `GetElapsedTime()` / `CreateTimer()`. It replaces a hand-rolled `IClock`, and code under test takes time from it instead of `DateTime.Now` / `DateTimeOffset.UtcNow`, and ids from `Guid.CreateVersion7(timeProvider.GetUtcNow())` (time-ordered, deterministic under `FakeTimeProvider`) instead of `Guid.NewGuid()`. Secrets and tokens come from `RandomNumberGenerator`, since v7 ids expose their creation time. Production binds `TimeProvider.System`; tests inject `FakeTimeProvider` (`Microsoft.Extensions.TimeProvider.Testing`) and call `Advance(...)` (see `yusufcirak-skills:csharp-testing`).

```csharp
public sealed class Subscription(TimeProvider time)
{
    public bool IsExpired(DateTimeOffset until) => time.GetUtcNow() >= until;
}
builder.Services.AddSingleton(TimeProvider.System);
```

## Outbound HTTP

Every outbound call goes through `IHttpClientFactory`, using a **typed client** by default.

- Never `new HttpClient()` per call (exhausts sockets) and never a `static` `HttpClient` field (pins DNS, skips the handler pipeline, so no resilience/telemetry/SSRF handlers). Never resolve `IHttpClientFactory` in business code when a typed client fits.
- A typed client is a class that takes `HttpClient` in its constructor and owns one downstream's calls. Register it with `AddHttpClient<CatalogClient>()` and inject the **concrete type**; it needs no interface by default (tests fake the downstream with a stub `HttpMessageHandler`). Add an interface (`AddHttpClient<ICatalogClient, CatalogClient>()`) only when a real second implementation or a module boundary calls for one. Named clients only when several unrelated callers share one configured client.
- Configure in the registration: `BaseAddress`, `Timeout`, constant default headers, then `.AddStandardResilienceHandler()` (`references/resilience.md`) and any `AddHttpMessageHandler`.
- The `HttpClient` is shared across requests, so per-request values (user token, tenant, correlation) go on the `HttpRequestMessage`, never `DefaultRequestHeaders`.
- Request and response bodies are typed (a `record` / `readonly record struct` per payload, sent with `JsonContent.Create`), never hand-built strings, anonymous objects or `Dictionary<string, object>`.
- The client returns `Result<T>` (`references/monads.md`), never `T?` and never an exception for an expected failure: a non-success status and an empty body are both `Result.Failure<T>(...)`. Dispose `HttpRequestMessage` and `HttpResponseMessage` (`using`), and never swallow failures into a half-filled result.
- The typed client is transient: don't capture it in a singleton; inject it into scoped/transient consumers or use `IHttpClientFactory` there.

```csharp
public readonly record struct CreateProductRequest(string Name, decimal Price);

public sealed class CatalogClient(HttpClient http)
{
    public async Task<Result<Product>> CreateProductAsync(
        CreateProductRequest body, string accessToken, CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "products")
        {
            Content = JsonContent.Create(body),
        };
        request.Headers.Authorization = new("Bearer", accessToken);

        using var response = await http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
            return Result.Failure<Product>($"catalog returned {(int)response.StatusCode}");

        var product = await response.Content.ReadFromJsonAsync<Product>(cancellationToken);
        return product is null
            ? Result.Failure<Product>("catalog returned an empty body")
            : Result.Success(product);
    }
}

builder.Services.AddHttpClient<CatalogClient>(client =>
    {
        client.BaseAddress = new Uri(catalogOptions.BaseUrl);
        client.Timeout = TimeSpan.FromSeconds(30);
    })
    .AddStandardResilienceHandler();
```

## Constants

- Compile-time values → `const`; otherwise `static readonly`. Every literal has a name.
- Cross-cutting names (HTTP headers, claim types, baggage/log keys, policy/queue/topic names, message headers) are defined once in a static class in the lowest layer every consumer references — telemetry keys in `BuildingBlocks.Application` (`TelemetryConstants`), **not** Domain (see `yusufcirak-skills:csharp-ddd` → cross-cutting ports); broker wire headers in the messaging Infrastructure project (`MessageHeaders`) — so producer, logs, and consumer agree.
- Options types carry their config path as `public const string SectionName`. Input size limits live in `InputLimits` (`yusufcirak-skills:csharp-validation`).

Setup of a library or package (install, registration, packages) never lives in the topic reference: it sits one level down in `references/setups/<topic>.md`. Open it only when adding that dependency to a project that lacks it.

## Decision notes

- Between two readings of a rule, pick the one that keeps records immutable, business logic in the domain, and errors in `Result<T>`.
- A third-party library that forces a constructor or mutable state gets isolated behind a factory or wrapper so the domain stays clean.
- Optimization tricks belong on measured-hot paths; elsewhere readability wins.