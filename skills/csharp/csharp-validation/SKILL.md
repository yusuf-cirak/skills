---
name: csharp-validation
description: Enforces input limits and JSON/serialization hardening for ASP.NET Core. Use when defining or reviewing request DTOs/commands/queries, request validators, JSON/serialization config, or any code that accepts client input. Rate limiting, authn, and other network hardening live in `csharp-hardening`.
---

# ASP.NET Core Input Security & Serialization Limits

## Contents

- What we require
  - Never trust client input
  - Central limits → `../csharp/references/input-limits.md`
  - Length-typed text value objects → `../csharp/references/monads.md`, `../csharp/references/value-object-base.md`
  - Mandatory validator rules
  - Validators run in the pipeline → `../csharp/references/mediator.md`, `yusufcirak-skills:csharp-hardening`
  - Serialization and request-size limits
  - Pagination and rate limiting → `yusufcirak-skills:csharp-hardening`
  - Output encoding
  - Anti-patterns (forbidden)
- .NET implementation
  - Length-typed `Text` value object
  - ValidationBehavior
  - Global `JsonSerializerOptions` → `yusufcirak-skills:csharp`
  - Kestrel and FormOptions
  - Per-endpoint size override
- Related skills → `yusufcirak-skills:csharp`, `yusufcirak-skills:csharp-web-api`, `yusufcirak-skills:csharp-hardening`, `yusufcirak-skills:csharp-testing`

## Files

- `../csharp/references/input-limits.md` — InputLimits constants
- `../csharp/references/monads.md` — Monadic error handling (Railway Oriented Programming)
- `../csharp/references/value-object-base.md` — Value Object base type + converters
- `../csharp/references/mediator.md` — Mediator selection & licensing (single source of truth)
- `../csharp/references/setups/mediator.md` — Setup: mediator package and registration
- `yusufcirak-skills:csharp-hardening` (`../csharp-hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `yusufcirak-skills:csharp` (`../csharp/SKILL.md`) — C# House Style
- `yusufcirak-skills:csharp-web-api` (`../csharp-web-api/SKILL.md`) — ASP.NET Core Web API
- `yusufcirak-skills:csharp-testing` (`../csharp-testing/SKILL.md`) — C# Testing Standard

Never trust client input: every endpoint, DTO, validator, value object and JSON configuration enforces hard limits on size, depth and shape, by default. Only relax a limit with an explicit, justified opt-in. The first half of this skill is what we require, whatever the framework. The second half is the ASP.NET Core code that enforces it. Pairs with `csharp-web-api` (endpoint shape) and `csharp` (VO and record idioms).

## What we require

### Never trust client input

Limits are enforced at three layers, so one forgotten rule cannot open the door: the **type** (length-typed value objects instead of raw `string`), the **validator** (mandatory rules on every request), and the **host** (serializer, server and per-endpoint size limits). Failures travel as values through the Result channel and reach the wire as one RFC 9457 problem, never as a thrown exception.

### Central limits

All length, size and count limits live in one shared static class `InputLimits` (in `BuildingBlocks.Domain` or the project's shared layer). Validators, value objects, endpoints and server config reference it, never inline magic numbers. Canonical definition: `../csharp/references/input-limits.md`.

### Length-typed text value objects

- Free-form `string` properties on DTOs and domain types are forbidden. Use a value object whose type carries the length constraint, so the limit cannot be forgotten.
- Tiers: `ShortText` (up to 256), `MediumText` (1 024), `LongText` (4 000), `XLongText` (16 000). Semantic shapes: `Email`, `Slug`, `Url` (https-only), `PhoneNumber`, each with its own factory rules.
- Factories return `Result<T>` (YC.Monad if available, otherwise the codebase's existing monad, see `../csharp/references/monads.md`). Base type: `../csharp/references/value-object-base.md`.
- DTOs, commands and queries declare these VO types, never raw `string`.

### Mandatory validator rules

Every request validator includes:

- `string` field: `.NotEmpty().MaximumLength(InputLimits.X)` matching the chosen tier.
- Collection field (`IEnumerable<T>`, `ImmutableList<T>`): `.NotNull()` plus a count cap `<= InputLimits.MaxCollectionItems`.
- `enum` field: `.IsInEnum()`.
- Email: `.EmailAddress().MaximumLength(InputLimits.ShortTextMaxLength)`.
- URL: absolute URI with a scheme whitelist (`https` only unless deliberately broader).
- Reject control characters: `.Must(s => s is null || !s.Any(char.IsControl))`.
- Regex: always `RegexOptions.NonBacktracking` or an explicit `TimeSpan` timeout. A plain `new Regex(pattern)` is forbidden (ReDoS).

Forbidden:

```csharp
RuleFor(x => x.Title).NotEmpty(); // missing MaximumLength
RuleFor(x => x.Tags).NotNull();   // missing count cap
```

### Validators run in the pipeline

Validators execute before the handler automatically, not through a hand-written `Validate()` call a developer can forget. A mediator pipeline behavior runs every validator for the request and short-circuits on failure. It does not throw: it returns a failed `Result` / `Result<T>` carrying a `ValidationError` (field to messages), and the single endpoint result mapper renders that as the RFC 9457 400 (any other `Error` becomes a `Problem` with its own status; see `csharp-hardening` → Error Handling). Handlers assume a valid request and never see a `ValidationException`. A validated request whose handler does not return a `Result` type throws `InvalidOperationException` on first use, deliberately: validation failures flow through the Result channel, never an exception. Which mediator to use: `../csharp/references/mediator.md`.

### Serialization and request-size limits

- Strict JSON: unknown members rejected (typos and probing fail loudly with 400), bounded depth, case-sensitive names, no trailing commas or comments, strict number handling (no quoted, `NaN` or `Infinity` numbers), enums as strings with an explicit naming policy, never bare integers.
- Server limits on body size, header sizes and counts, form value and key lengths.
- A larger body is an explicit per-endpoint opt-in (upload, bulk import) with its own size cap. Disabling the limit is forbidden and a code-review block.

### Pagination and rate limiting

- Every list or query endpoint paginates. No filterless `GetAll`. The page is read from the ambient request and clamped, never validated (size below 1 becomes 20, above 200 becomes 200, page below 1 becomes 1), so a hostile or empty query cannot ask for an unbounded set. Queries carry no `PageRequest`. Shape and EF extension: `csharp-web-api` → Pagination.
- Every endpoint is rate-limited: burst guard, steady quota, concurrency cap and failed-auth lockout, all partitioned by authenticated principal. Policy and code: `csharp-hardening` → Tiered Rate Limiting & Burst Protection.

### Output encoding

When emitting user-controlled data into HTML, JS or CSS contexts use `HtmlEncoder.Default`, `JavaScriptEncoder.Default` or `UrlEncoder.Default`. Never concatenate a `Text` value into a template. For JSON APIs the configured serializer handles escaping; do not hand-write JSON.

### Anti-patterns (forbidden)

- `dynamic` or `JsonElement` request payloads: define a typed DTO.
- Raw `string` properties on request, command or query types: use length-typed VOs.
- A validator with a `string` rule missing `MaximumLength`.
- `[DisableRequestSizeLimit]`.
- `new Regex(pattern)` without `NonBacktracking` or a timeout.
- `PropertyNameCaseInsensitive = true` unless explicitly justified.
- Logging raw request bodies or payloads (PII and size risk): log shape (counts, ids), not content.
- Returning unbounded result sets from queries.

## .NET implementation

### Length-typed `Text` value object

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

### ValidationBehavior

Shape below is `Mediator` 3.x (`ValueTask`, `MessageHandlerDelegate<TRequest,TResponse>`, `next(request, ct)`, `IMessage` marker constraint).

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

Wire it with `options.PipelineBehaviors = [typeof(ValidationBehavior<,>)]` in `AddMediator(...)` (MediatR: `cfg.AddOpenBehavior(...)`) plus `services.AddValidatorsFromAssemblies(assemblies, includeInternalTypes: true)`.

### Global `JsonSerializerOptions`

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
    // Enums as strings with an explicit naming policy: never leak or accept bare integer enum values.
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseUpper));
    foreach (var converter in ValueObjectJsonConverters.JsonConverters)
        o.SerializerOptions.Converters.Add(converter);
});
```

`Disallow` on unmapped members makes unknown fields return 400. `MaxDepth = 32` blocks pathological nesting. Strict number handling rejects quoted, `NaN` and `Infinity` numbers.

For trimming and Native AOT (and to drop startup reflection), add a source-generated `JsonSerializerContext` to the resolver chain and keep these hardened options (see `csharp` → JSON serialization):

```csharp
o.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
```

### Kestrel and FormOptions

In `Program.cs`:

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

### Per-endpoint size override

```csharp
[RequestSizeLimit(InputLimits.MaxUploadBytes)]
[Consumes("multipart/form-data")]
public sealed class Endpoint : BaseEndpoint<Request, Result<UploadResult>>
{
    // ...
}
```

## Related skills

- `yusufcirak-skills:csharp` — value object / record / monad idioms.
- `yusufcirak-skills:csharp-web-api` — endpoint/handler/validator shape.
- `yusufcirak-skills:csharp-hardening` — rate limiting, authn/authz, headers, file upload, SSRF, deserialization safety.
- `yusufcirak-skills:csharp-testing` — unit tests asserting `InputLimits`/VO factory rules; integration tests for the 400/validation envelope.
