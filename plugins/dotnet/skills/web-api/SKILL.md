---
name: web-api
description: Shapes ASP.NET Core endpoints and middleware. Use when writing or editing endpoints, handlers, controllers, mediator commands/queries, or validators, or when wiring/reordering middleware in `Program.cs`. Defers input-size/length limits to `validation`, security/ops to `hardening`, and module placement to `ddd`.
---

# ASP.NET Core Web API

## Contents

- Vertical slice file → `../csharp/references/monads.md`, `../csharp/references/mediator.md`, `dotnet:ddd`, `dotnet:hardening`
- FluentValidation → `dotnet:validation`
- Pagination → `dotnet:validation`
- Pipeline behaviors (Mediator) → `../csharp/references/mediator.md`, `dotnet:validation`, `dotnet:hardening`
- Strongly-typed id binding
- Middleware pipeline order & registration safety
- Related skills → `dotnet:csharp`, `dotnet:ddd`, `dotnet:validation`, `dotnet:hardening`, `dotnet:testing`

## Files

- `../csharp/references/monads.md` — Monadic error handling — library selection & usage
- `../csharp/references/mediator.md` — Mediator selection & licensing (single source of truth)
- `dotnet:ddd` (`../ddd/SKILL.md`) — .NET Domain-Driven Design & Architecture
- `dotnet:hardening` (`../hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `dotnet:validation` (`../validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
- `dotnet:csharp` (`../csharp/SKILL.md`) — C# House Style
- `dotnet:testing` (`../testing/SKILL.md`) — C# Testing Standard

Owns **how requests are shaped and handled** — the endpoint/handler/slice surface, the vertical-slice file skeleton (`static class <Name>Command` holding Endpoint/Request/Validator/Handler/Response), FastEndpoints/Minimal API/mediator handler wiring, FluentValidation basics, ambient pagination, the Mediator pipeline behaviors, and `Program.cs` middleware pipeline ordering. *Where* a slice sits in the module tree comes from `ddd`; record/monad idioms come from `csharp`; hard input limits come from `validation`.

## Vertical slice file

One slice file holds Command/Query + Handler + slice-specific DTOs/Validators. (Placement under `Features/<FeatureName>/<Scope>/<Commands|Queries>/` is governed by `ddd`.)

Slice skeleton:

```csharp
public static class CreateActivityCommand
{
    public sealed class Endpoint : BaseEndpoint<Request, Result<T>>; // if FastEndpoints
    public sealed record Request() : IRequest<Result<T>>;
    public sealed class Validator : AbstractValidator<Request>;
    public sealed class Handler : IRequestHandler<Request, Result<T>>;
    public sealed record Response(); // only if needed, otherwise reuse DTOs
}
```

- Handlers return a monad (`Result<T>`) — see `../csharp/references/monads.md`.
- Every handler signature accepts and propagates `CancellationToken` (full timeout/cancellation rules in `hardening`).

**Mediator selection (do this BEFORE scaffolding):** MediatR is commercial from v13. Default to the
free source-gen **`martinothamar/Mediator`**; the `IRequest<T>`/`IRequestHandler<,>`/`IPipelineBehavior<,>`
shapes above are identical either way. If no mediator package is present, **ask the user which to
install**. Full decision rule + AutoMapper→Mapperly mapping guidance: `../csharp/references/mediator.md`.

## FluentValidation

- Prefer functional / static validators.
- The **mandatory** validator rules (length caps, collection caps, control-char rejection, regex safety, etc.) are owned by `validation` — apply them on every request validator.

## Pagination

Every list/query endpoint paginates — no filterless `GetAll`. **Queries carry no `PageRequest`** and there is no `PagedRequest` base/validator to inherit: the page is **ambient**. `PageRequest.FromCurrentRequest()` reads `page`/`pageSize` from the current request's query string through an ambient accessor (`ThreadHttpContextAccessor.Current`), and the parameterless `ToPagedResultAsync()` calls it, so a handler just orders and pages. Outside an HTTP request it yields the default page (1/20); a non-HTTP caller that needs a specific page uses the `PageRequest` overload.

Values are **clamped, not validated**: size < 1 → 20 (default), > 200 → 200 (`MaxPageSize`), page < 1 → 1. Items are a streamed `IAsyncEnumerable<T>` (count query + one page query, no list materialization):

```csharp
public sealed record PageRequest(int Page = 1, int PageSize = 20) {
    public const int DefaultPageSize = 20;
    public const int MaxPageSize = 200;
    public int NormalizedPage => Page < 1 ? 1 : Page;
    public int NormalizedPageSize => PageSize switch { < 1 => DefaultPageSize, > MaxPageSize => MaxPageSize, _ => PageSize };
    public int Skip => (NormalizedPage - 1) * NormalizedPageSize;
    public static PageRequest FromCurrentRequest() {
        var query = ThreadHttpContextAccessor.Current?.Request.Query;
        if (query is null) return new PageRequest();
        var page = int.TryParse(query["page"], NumberStyles.Integer, CultureInfo.InvariantCulture, out var p) ? p : 1;
        var pageSize = int.TryParse(query["pageSize"], NumberStyles.Integer, CultureInfo.InvariantCulture, out var s) ? s : DefaultPageSize;
        return new PageRequest(page, pageSize);
    }
}
public sealed record PagedResult<T>(IAsyncEnumerable<T> Items, int Page, int PageSize, long TotalCount) {
    public int TotalPages => PageSize <= 0 ? 0 : (int)Math.Ceiling(TotalCount / (double)PageSize);
    public bool HasPrevious => Page > 1;
    public bool HasNext => Page < TotalPages;
    public static PagedResult<T> Empty(int page, int pageSize) => new(AsyncEnumerable.Empty<T>(), page, pageSize, 0);
}
public static Task<PagedResult<T>> ToPagedResultAsync<T>(this IQueryable<T> query, CancellationToken ct = default) =>
    query.ToPagedResultAsync(PageRequest.FromCurrentRequest(), ct);
public static async Task<PagedResult<T>> ToPagedResultAsync<T>(this IQueryable<T> query, PageRequest page, CancellationToken ct = default) {
    var total = await query.LongCountAsync(ct);
    var items = query.Skip(page.Skip).Take(page.NormalizedPageSize).AsAsyncEnumerable(); // order the query first!
    return new(items, page.NormalizedPage, page.NormalizedPageSize, total);
}
```

- Clamp size to `MaxPageSize` — a hostile/empty query must not be able to ask for an unbounded set.
- ALWAYS order before paging; `Skip`/`Take` over an unordered query is non-deterministic.
- The streamed `Items` must be enumerated while the DbContext scope is alive (serialize in the endpoint; do not stash the result).

## Pipeline behaviors (Mediator)

Cross-cutting request rules are **marker interfaces on the request + an open-generic `IPipelineBehavior`**, registered once in the host (`Mediator.SourceGenerator` only generates `AddMediator()` in the outermost project — see `../csharp/references/mediator.md`). Declared order is the execution order, and the lifetime is **Scoped**, not the library default Singleton (handlers take scoped `DbContext`s; a Singleton holding one is a captive dependency):

```csharp
builder.Services.AddMediator(o =>
{
    o.ServiceLifetime = ServiceLifetime.Scoped;
    o.PipelineBehaviors =
    [
        typeof(SensitiveRequestBehavior<,>), // re-verify caller (if ISensitiveRequest)
        typeof(ValidationBehavior<,>),       // then validate (dotnet:validation §3b)
        typeof(LockBehavior<,>),             // then acquire the distributed lock (if ILockRequest)
    ];
});
```

- **`ISensitiveRequest` → `SensitiveRequestBehavior`**: for change-password / revoke-sessions / delete-account commands. Re-verifies at handler time that the caller is authenticated (`ICurrentUser.IsAuthenticated`) and that the token's `jti` is not on `ITokenBlacklist`; either failure returns a 401 `Error` through the Result channel (no exception). Defense-in-depth beyond the one-time edge check, and it also guards commands dispatched outside an HTTP request.
- **`ILockRequest` → `LockBehavior`**: single-flight by `LockKey` (default `LockExpiration` 30 s, overridable on the request). `IDistributedLock.AcquireAsync` is a non-blocking try-acquire returning `null` when held; the loser gets a 409 `lock.conflict` `Result`, never queues. Use for genuinely exactly-once operations (concurrent duplicate commands the idempotency filter cannot serialize). The default registration is a **fail-loud** `UnconfiguredDistributedLock` (`TryAddSingleton`) that throws `InvalidOperationException` when an `ILockRequest` is dispatched without Redis — it never silently runs unlocked; `AddRedisLocking()` overrides it (Medallion `DistributedLock.Redis`, auto-renewing handle).
- All three behaviors build their failure through the same cached `ResultFailureFactory<TResponse>`, so a marked request must return `Result`/`Result<T>`.
- `ICurrentUser`/`ITokenBlacklist` get safe defaults (`AnonymousCurrentUser`, `NoOpTokenBlacklist`) so the behaviors always resolve; the host/Redis registrations override them.
- Status in the reference repo: the behaviors and their tests exist, but **no module request implements `ILockRequest` or `ISensitiveRequest` yet** — the markers are ready, unused.

## Strongly-typed id binding

Minimal API binds a route/query parameter to a strongly-typed id for free when the id implements `IParsable<T>` — no custom `TryParseParameter`/binder needed.

```csharp
// OrderId implements IParsable<OrderId> (Vogen generates it; a hand-rolled id implements it explicitly,
// reached via the IParsable<T> constraint). "/orders/{guid}" binds through OrderId.TryParse.
app.MapGet("/orders/{id}", (OrderId id) => ...);
```

## Middleware pipeline order & registration safety

`Program.cs` composition is sequence-sensitive, and nothing stops a developer from registering a
middleware before a prerequisite it silently depends on — a custom rate-limit/tenant/idempotency
middleware that reads `HttpContext.User` registered *before* `UseAuthentication()`, for instance. It
won't throw; it'll just silently see an unauthenticated principal in prod. Two complementary defenses:

### Canonical order

Exception handling/HSTS → HTTPS redirection → **forwarded headers** (`hardening` → Forwarded Headers —
MUST be first among anything that reads IP/scheme) → static files → `UseRouting()` → CORS → rate
limiting (after routing, so it can partition on the matched route template — `hardening` → Rate
Limiting) → `UseAuthentication()` → `UseAuthorization()` → custom pipeline middleware → endpoints
(`Map*`). Rule of thumb for *where a new middleware goes*: find what `HttpContext` state it reads
(`User`, `RemoteIpAddress`, the matched endpoint, response headers already set by an earlier middleware)
and place it after whatever middleware populates that state.

### Fail fast on a missing prerequisite — follow the framework's own pattern

ASP.NET Core already enforces this for itself: `UseAuthorization()` throws `InvalidOperationException`
at startup if `UseAuthentication()` was never registered, by checking a marker the framework stamps onto
`IApplicationBuilder.Properties` when `UseAuthentication()` runs. Don't rely on the framework's own
(private, version-specific) property key for *your* middleware — define your own marker the same way:

```csharp
public static class IdempotencyMiddlewareExtensions
{
    private const string MarkerKey = "__IdempotencyMiddlewareRegistered"; // this extension's own marker

    public static IApplicationBuilder UseIdempotency(this IApplicationBuilder app)
    {
        if (app.ApplicationServices.GetService<IAuthenticationSchemeProvider>() is not null
            && !app.Properties.ContainsKey("__AuthenticationMiddlewareInvoked")) // set by UseAuthentication()
        {
            throw new InvalidOperationException(
                $"{nameof(UseIdempotency)}() must be called after UseAuthentication() — " +
                "idempotency keys are scoped per authenticated principal.");
        }

        app.Properties[MarkerKey] = true; // so a LATER middleware can depend on this one too
        return app.UseMiddleware<IdempotencyMiddleware>();
    }
}
```

- Stamp `app.Properties[...]` with your own key in every custom `UseX()` extension that something else
  may legitimately depend on — mirrors the framework's approach without coupling to its private keys.
- This is a **startup-time** `InvalidOperationException`, not a silent 3am misbehavior — prefer it over a
  runtime null-check buried in a handler for anything whose correctness depends on pipeline order.
- Applies beyond auth: a custom `UseTenantResolution()` depending on `UseAuthentication()`, a
  `UseRequestLogging()` depending on `UseForwardedHeaders()` for the real client IP, an
  `UseOutputCache()` policy that must sit after authorization, etc. — any ordering dependency a code
  reviewer could plausibly miss is a candidate for this guard, not just auth.

## Related skills

- `dotnet:csharp` — base idioms (records, monads, LINQ).
- `dotnet:ddd` — module/slice placement, domain logic.
- `dotnet:validation` — request limits, length-typed VOs, validator rules, serialization hardening.
- `dotnet:hardening` — rate limiting, authn/authz, headers, error handling, observability, forwarded headers.
- `dotnet:testing` — integration tests (`WebApplicationFactory` + Testcontainers) exercising these endpoints.
