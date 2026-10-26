# C# Composition: Options, Extensions, DI, Library Surface

## Contents

- Options pattern (fail-fast)
- Cross-cutting via extension members
- Dependency injection — keyed services (.NET 8+)
- XML docs
- Related

Load when binding configuration, writing AddX/UseX extensions, registering keyed services, or authoring a library/NuGet package.

## Options pattern (fail-fast)

Bind configuration to a typed options class and **validate at startup** — a misconfigured deployment crashes on boot with a clear message, not at the first request.

```csharp
services.AddOptions<JwtOptions>()
    .BindConfiguration(JwtOptions.SectionName)
    .ValidateDataAnnotations()
    .Validate(o => o.Mode != JwtMode.Symmetric || !string.IsNullOrWhiteSpace(o.SigningKey),
              "SigningKey required when Mode=Symmetric") // cross-field rules
    .ValidateOnStart();
```

Options classes are sealed, immutable where possible, and annotated (`[Required]`, `[Range]`). Read raw `IConfiguration` only at composition time.

**Trap — two copies of the options.** An `AddX(this WebApplicationBuilder, Action<TOptions> configure = null)` extension often needs the values *at registration time* to branch DI (`JwtMode.Authority` vs `Symmetric`, `Local` vs `Distributed` rate limiting). Reading an eager bound copy (`builder.Configuration.GetSection(...).Get<TOptions>()`) creates a **second object** that the `AddOptions()` pipeline above never sees: the validated `IOptions<T>` the runtime consumes and the copy that drove the wiring can disagree. Whatever the code-configure callback does must be applied to **both**:

```csharp
var optionsBuilder = services.AddOptions<JwtOptions>().BindConfiguration(JwtOptions.SectionName);
if (configure is not null) optionsBuilder.Configure(configure);   // 1. the IOptions<T> pipeline
optionsBuilder.ValidateDataAnnotations().Validate(/* cross-field */).ValidateOnStart();

var opts = configuration.GetSection(JwtOptions.SectionName).Get<JwtOptions>() ?? new JwtOptions();
configure?.Invoke(opts);                                           // 2. the eager copy that drives wiring below
services.AddAuthentication().AddJwtBearer(o => { if (opts.Mode == JwtMode.Authority) o.Authority = opts.Authority; /* ... */ });
```

The eager copy is also **unvalidated** (validation runs on the pipeline at start-up); keep its use to the DI branch and read everything else from `IOptions<T>`/`IOptionsMonitor<T>`.

For AOT/trimming and zero-reflection validation, source-generate the validator with **`[OptionsValidator]`** (.NET 8+) instead of `ValidateDataAnnotations()`:

```csharp
[OptionsValidator]
public sealed partial class JwtOptionsValidator : IValidateOptions<JwtOptions>;
services.AddOptions<JwtOptions>().BindConfiguration(JwtOptions.SectionName).ValidateOnStart();
services.AddSingleton<IValidateOptions<JwtOptions>, JwtOptionsValidator>();
```

## Cross-cutting via extension members

- One cross-cutting concern per file, exposed as an `AddX(this WebApplicationBuilder)` / `UseX(this WebApplication)` pair, so `Program.cs` stays a thin, readable list of capabilities.
- Use C# **extension members** (`extension(IServiceCollection services) { public IServiceCollection AddX() {…} }`) to group related extensions cleanly.
- **Endpoint opt-in conventions**: a marker metadata type + a `.RequireX()` extension on `IEndpointConventionBuilder` + a `context.GetEndpoint()?.Metadata.GetMetadata<T>()` read in the middleware (e.g. `.RequireIdempotency()`, `.RequireScope("…")`, `.SuppressLogging()`). Declarative at the route, enforced in one middleware.

### Framework / library surface (Microsoft-style)

When authoring a library, NuGet package, or EF Core provider/extension:

- Public DI registration extensions and fluent builders **return the builder/`IServiceCollection`** so
  calls chain; provider option methods return the same `DbContextOptionsBuilder`.
- Bundle a service's injected dependencies in a **`sealed record` with `required init` properties**
  (the EF Core `XxxDependencies` pattern) — immutable, `with`-copyable, one constructor parameter
  instead of ten. Consistent with records-everywhere.
- Offer **generic + non-generic overloads** where a caller may hold only a `Type`
  (`Set<TEntity>()` and `Set(Type entityType)`).
- Argument/precondition guards for **programmer error** stay exceptions at the public boundary — a
  contract check, not `Result<T>` business validation. If the project already references
  **Ardalis.GuardClauses** (a common choice for this vocabulary), use it consistently —
  `Guard.Against.Null(input)`, `Guard.Against.NullOrWhiteSpace(name)`, `Guard.Against.NegativeOrZero(qty)`,
  `Guard.Against.OutOfRange(page, nameof(page), 1, InputLimits.MaxPageSize)` — and add project-specific
  checks as **`IGuardClause` extension methods** so every call site stays `Guard.Against.X(...)`.
  Otherwise match whatever guard convention the codebase already has (hand-rolled static `Guard` class,
  etc.) rather than introducing a competing vocabulary mid-codebase. If guards are scattered and
  inconsistent (ad-hoc `if (x is null) throw` / bare `ArgumentNullException.ThrowIfNull` with no shared
  vocabulary), recommend adding **Ardalis.GuardClauses** and ask before adding the package — it's the
  de-facto standard for this and worth introducing once there's no existing convention to clash with.
  Reserve guards for impossible/contract violations — expected, user-facing validation failures flow
  through `Result<T>` / FluentValidation (see `dotnet:validation`, `dotnet:ddd` factory rules), never a thrown guard.

```csharp
Guard.Against.NullOrWhiteSpace(name);
Guard.Against.OutOfRange(page, nameof(page), 1, InputLimits.MaxPageSize);

// project-specific guard as an extension — call site stays Guard.Against.*
public static class GuardExtensions
{
    public static string InvalidEmail(this IGuardClause guard, string input,
        [CallerArgumentExpression(nameof(input))] string? name = null)
        => EmailRegex.IsMatch(input) ? input : throw new ArgumentException("invalid email", name);
}
```
- Mark framework-internal public API that is exempt from semver with an internal-API marker attribute
  (the `[EntityFrameworkInternal]` analog); prefer real `internal` + `[InternalsVisibleTo]` when the
  surface need not be public at all.

```csharp
public sealed record TimescaleDbTranslatorDependencies
{
    public required ISqlExpressionFactory SqlExpressionFactory { get; init; }
    public required IRelationalTypeMappingSource TypeMappingSource { get; init; }
}
```

## Dependency injection — keyed services (.NET 8+)

When one interface has several interchangeable implementations (strategy / variant / named backend),
register them **keyed** instead of a custom factory or marker types:

```csharp
services.AddKeyedSingleton<ICacheStore, RedisCacheStore>("redis");
services.AddKeyedSingleton<ICacheStore, MemoryCacheStore>("memory");

public sealed class Handler([FromKeyedServices("redis")] ICacheStore cache);
```

## XML docs

- XML doc comments on the public surface of a library/package.
- `<inheritdoc/>` on overrides and interface implementations instead of copy-pasting summaries.
- `<see cref="…"/>` for type/member links; `<see href="https://…">` for external links.

## Related

- `dotnet:validation` (`../validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
- `dotnet:ddd` (`../ddd/SKILL.md`) — .NET Domain-Driven Design & Architecture
