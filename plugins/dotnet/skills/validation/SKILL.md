---
name: validation
description: Enforces input limits and JSON/serialization hardening for ASP.NET Core. Use when defining or reviewing request DTOs/commands/queries, request validators, JSON/serialization config, or any code that accepts client input. Rate limiting, authn, and other network hardening live in `hardening`.
---

# ASP.NET Core Input Security & Serialization Limits

## Contents

- 1. Central `InputLimits` constants → `../csharp/references/input-limits.md`
- 2. Length-typed `Text` value objects → `../csharp/references/monads.md`, `../csharp/references/value-object-base.md`
- 3. FluentValidation — mandatory rules
- 3b. Validators run in the pipeline (mediator pipeline behavior) → `../csharp/references/mediator.md`, `dotnet:hardening`
- 4. Global `JsonSerializerOptions` hardening → `dotnet:csharp`
- 5. Kestrel & FormOptions limits
- 6. Per-endpoint override (opt-in only)
- 7. Pagination is mandatory
- 8. Rate limiting → `dotnet:hardening`
- 9. Anti-patterns (forbidden)
- 10. Output encoding
- Related skills → `dotnet:csharp`, `dotnet:web-api`, `dotnet:hardening`, `dotnet:testing`

## Files

- `../csharp/references/input-limits.md` — InputLimits constants
- `../csharp/references/monads.md` — Monadic error handling — library selection & usage
- `../csharp/references/value-object-base.md` — Value Object base type + converters
- `../csharp/references/mediator.md` — Mediator selection & licensing (single source of truth)
- `dotnet:hardening` (`../hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `dotnet:csharp` (`../csharp/SKILL.md`) — C# House Style
- `dotnet:web-api` (`../web-api/SKILL.md`) — ASP.NET Core Web API
- `dotnet:testing` (`../testing/SKILL.md`) — C# Testing Standard

Every endpoint, DTO, validator, value object, and JSON configuration MUST enforce hard limits on input size, depth, and shape: the central `InputLimits` constants, length-typed `Text` value objects (`ShortText`/`MediumText`/`LongText`/`XLongText`, `Email`/`Slug`/`Url`/`PhoneNumber`) instead of raw `string`, mandatory FluentValidation rules, global `JsonSerializerOptions` hardening, Kestrel/`FormOptions` limits, per-endpoint size override, mandatory pagination, and output encoding. Never trust client input. Apply these rules by default — only relax them with an explicit, justified opt-in. Pairs with `web-api` (endpoint shape) and `csharp` (VO/record idioms).

## 1. Central `InputLimits` constants

All length / size / count limits live in one shared static class (place in `BuildingBlocks.Domain` or the project's equivalent shared layer). Validators, value objects, endpoints, and Kestrel config reference these — never inline magic numbers.

Canonical definition (single source of truth):
→ `../csharp/references/input-limits.md`

## 2. Length-typed `Text` value objects

Free-form `string` properties on DTOs/domain are forbidden. Use a value object whose type carries the length constraint, so the limit cannot be forgotten. Factories return `Result<T>` (YC.Monad if available; otherwise the codebase's existing monad — see `../csharp/references/monads.md`). The `ValueObject<T>` base is in `../csharp/references/value-object-base.md`.

```csharp
public sealed record ShortText : ValueObject<string>
{
    public override string GetValue() => Value;
}

public static class ShortTextFactory
{
    public static Result<ShortText> Create(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return Result.Failure<ShortText>("value is required");
        if (value.Length > InputLimits.ShortTextMaxLength)
            return Result.Failure<ShortText>($"value exceeds {InputLimits.ShortTextMaxLength} characters");
        if (value.Any(char.IsControl))
            return Result.Failure<ShortText>("value contains control characters");
        return Result.Success(new ShortText { Value = value });
    }
}
```

Provide variants per length tier and per semantic shape:

- `ShortText` (≤ 256), `MediumText` (≤ 1 024), `LongText` (≤ 4 000), `XLongText` (≤ 16 000).
- `Email`, `Slug`, `Url` (https-only scheme), `PhoneNumber` — each with its own factory rules.

DTOs/commands/queries declare these VO types, never raw `string`.

## 3. FluentValidation — mandatory rules

Every request validator MUST include:

- `string` field → `.NotEmpty().MaximumLength(InputLimits.X)` (matching the chosen tier).
- `IEnumerable<T>` / `ImmutableList<T>` field → `.NotNull()` + `.Must(c => c.Count() <= InputLimits.MaxCollectionItems)`.
- `enum` field → `.IsInEnum()`.
- Email → `.EmailAddress().MaximumLength(InputLimits.ShortTextMaxLength)`.
- URL → custom rule enforcing `Uri.TryCreate(..., UriKind.Absolute)` + scheme whitelist (`https` only, unless deliberately broader).
- Reject control characters: `.Must(s => s is null || !s.Any(char.IsControl))`.
- Regex usage: MUST pass `RegexOptions.NonBacktracking` or an explicit `TimeSpan` timeout. Plain `new Regex(pattern)` is forbidden (ReDoS risk).

Counter-example (forbidden):

```csharp
RuleFor(x => x.Title).NotEmpty(); // missing MaximumLength
RuleFor(x => x.Tags).NotNull();   // missing count cap
```

## 3b. Validators run in the pipeline (mediator pipeline behavior)

Validators MUST execute **before** the handler, automatically — not by a hand-written `Validate()` call the developer can forget. Register a mediator `IPipelineBehavior` that runs every `IValidator<TRequest>` and short-circuits on failure. The behavior does **not throw**: it returns a failed `Result`/`Result<T>` carrying a `ValidationError` (field → messages) through the normal Result channel, and the single endpoint result mapper renders that as the RFC 9457 400. Which mediator to pick (MediatR is commercial from v13; default is the free source-gen `Mediator`) is decided in `../csharp/references/mediator.md`. Shape below is `Mediator` 3.x (`ValueTask`, `MessageHandlerDelegate<TRequest,TResponse>`, `next(request, ct)`, `IMessage` marker constraint):

```csharp
public sealed class ValidationBehavior<TRequest, TResponse>(IEnumerable<IValidator<TRequest>> validators)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull, IMessage
{
    public async ValueTask<TResponse> Handle(TRequest request, MessageHandlerDelegate<TRequest, TResponse> next, CancellationToken ct)
    {
        if (!validators.Any()) return await next(request, ct);
        var ctx = new ValidationContext<TRequest>(request);
        var failures = (await Task.WhenAll(validators.Select(v => v.ValidateAsync(ctx, ct))))
            .SelectMany(r => r.Errors).Where(f => f is not null).ToArray();
        if (failures.Length == 0) return await next(request, ct);

        var errors = failures
            .GroupBy(f => f.PropertyName, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Select(f => f.ErrorMessage).Distinct(StringComparer.Ordinal).ToArray(), StringComparer.Ordinal);
        return ResultFailureFactory<TResponse>.Create(new ValidationError(errors)); // failed Result, no exception
    }
}

// Builds a failed Result / Result<T> for the closed TResponse; strategy resolved once and cached in a static field.
internal static class ResultFailureFactory<TResponse>
{
    private static readonly Func<Error, TResponse> Factory = Build();
    public static TResponse Create(Error error) => Factory(error);
    private static Func<Error, TResponse> Build()
    {
        var type = typeof(TResponse);
        if (type == typeof(Result)) return error => (TResponse)(object)Result.Failure(error);
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Result<>))
        {
            var failure = type.GetMethod(nameof(Result.Failure), BindingFlags.Public | BindingFlags.Static, [typeof(Error)])!;
            return error => (TResponse)failure.Invoke(null, [error])!;
        }
        return _ => throw new InvalidOperationException(
            $"ValidationBehavior requires the response to be Result or Result<T>, but the handler returns {type}.");
    }
}
```

Wire it with `options.PipelineBehaviors = [typeof(ValidationBehavior<,>)]` in `AddMediator(...)` (MediatR: `cfg.AddOpenBehavior(...)`) + `services.AddValidatorsFromAssemblies(assemblies, includeInternalTypes: true)`. The `ValidationError` reaches the wire through the one Result → HTTP mapper (`ValidationError` → `ValidationProblem` 400 with `errors` = field → messages; any other `Error` → `Problem` with its status) — see `hardening` → Error Handling. Handlers assume a valid request and never see a `ValidationException`. A validated request whose handler does **not** return a `Result` type throws `InvalidOperationException` on first use — deliberate: validation failures must flow through the Result channel, not an exception.

## 4. Global `JsonSerializerOptions` hardening

Configure once in `Program.cs` or `DependencyInjection.Serialization.cs`. Apply to both `ConfigureHttpJsonOptions` (Minimal APIs / FastEndpoints) and `AddJsonOptions` (MVC) where used.

```csharp
services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.MaxDepth = InputLimits.MaxJsonDepth;
    o.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow;
    o.SerializerOptions.PropertyNameCaseInsensitive = false;
    o.SerializerOptions.AllowTrailingCommas = false;
    o.SerializerOptions.ReadCommentHandling = JsonCommentHandling.Disallow;
    o.SerializerOptions.NumberHandling = JsonNumberHandling.Strict;
    o.SerializerOptions.DefaultBufferSize = 16 * 1024;
    // Enums as strings with an explicit naming policy — never leak/accept bare integer enum values.
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseUpper));
    foreach (var converter in ValueObjectJsonConverters.JsonConverters)
        o.SerializerOptions.Converters.Add(converter);
});
```

Rationale: `Disallow` unmapped members causes unknown fields to return 400 — typos and probing attacks fail loudly. `MaxDepth = 32` blocks pathological nesting. Strict number handling rejects quoted/`NaN`/`Infinity` numbers.

For trimming / Native AOT (and to drop startup reflection), add a source-generated `JsonSerializerContext` to the resolver chain — keep these hardened options, just feed it the generated metadata (see `csharp` → JSON serialization):

```csharp
o.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
```

## 5. Kestrel & FormOptions limits

`Program.cs`:

```csharp
builder.WebHost.ConfigureKestrel(o =>
{
    o.Limits.MaxRequestBodySize = InputLimits.MaxRequestBodyBytes;
    o.Limits.MaxRequestLineSize = 8 * 1024;
    o.Limits.MaxRequestHeadersTotalSize = 32 * 1024;
    o.Limits.MaxRequestHeaderCount = 100;
    o.Limits.KeepAliveTimeout = TimeSpan.FromSeconds(120);
});

builder.Services.Configure<FormOptions>(o =>
{
    o.MultipartBodyLengthLimit = InputLimits.MaxUploadBytes;
    o.ValueLengthLimit = InputLimits.LongTextMaxLength;
    o.KeyLengthLimit = 256;
    o.ValueCountLimit = 1024;
});
```

## 6. Per-endpoint override (opt-in only)

Endpoints that legitimately need a larger body (file upload, bulk import) MUST opt in explicitly. They MUST NOT disable the limit.

```csharp
[RequestSizeLimit(InputLimits.MaxUploadBytes)]
[Consumes("multipart/form-data")]
public sealed class Endpoint : BaseEndpoint<Request, Result<UploadResult>>
{
    // ...
}
```

`[DisableRequestSizeLimit]` is forbidden — treat as a code-review block.

## 7. Pagination is mandatory

Every list/query endpoint paginates. No filterless `GetAll`. There is no `PagedRequest` base or paged validator to inherit: the page is read from the ambient request by `PageRequest.FromCurrentRequest()` and **clamped**, not validated (size < 1 → 20, > 200 → 200, page < 1 → 1), so a hostile or empty query can never ask for an unbounded set. Queries carry no `PageRequest`. Shape and the EF `ToPagedResultAsync()` extension live in `web-api` → Pagination.

## 8. Rate limiting

Every endpoint is rate-limited. Burst guard + steady quota + concurrency cap + failed-auth lockout, all partitioned by authenticated principal. Full policy and code live in `hardening` → **Tiered Rate Limiting & Burst Protection**.

## 9. Anti-patterns (forbidden)

- `dynamic` or `JsonElement` request payloads — define a typed DTO instead.
- Raw `string` properties on request/command/query types — use length-typed VOs.
- A validator with a `string` rule missing `MaximumLength`.
- `[DisableRequestSizeLimit]`.
- `new Regex(pattern)` without `RegexOptions.NonBacktracking` or a `TimeSpan` timeout.
- `PropertyNameCaseInsensitive = true` unless explicitly justified.
- Logging raw request bodies / payloads (PII + size risk). Log shape (counts, ids), not content.
- Returning unbounded result sets from queries.

## 10. Output encoding

When emitting user-controlled data into HTML/JS/CSS contexts, use `HtmlEncoder.Default`, `JavaScriptEncoder.Default`, or `UrlEncoder.Default`. Never concatenate `Text` value directly into a template. For JSON APIs the configured `JsonSerializerOptions` handles escaping; do not hand-write JSON.

## Related skills

- `dotnet:csharp` — value object / record / monad idioms.
- `dotnet:web-api` — endpoint/handler/validator shape.
- `dotnet:hardening` — rate limiting, authn/authz, headers, file upload, SSRF, deserialization safety.
- `dotnet:testing` — unit tests asserting `InputLimits`/VO factory rules; integration tests for the 400/validation envelope.
