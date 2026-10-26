# Mediator selection & licensing (single source of truth)

## Contents

- Decision rule
- API parity (why the swap is cheap)
- Object mapping — no reflection mappers
- Unified alternative — Wolverine
- Related

> Requires .NET 8+. Owns the **which-mediator** decision for `dotnet:web-api` and `dotnet:validation`.

MediatR, AutoMapper, and MassTransit moved to **commercial/paid licensing** (MediatR v13+,
AutoMapper v15+, MassTransit v9+, during 2024–2025; free only under a revenue threshold). The skills
no longer assume MediatR is free. The reference codebase (TicketMaster) runs the source-generated
**`Mediator` 3.0.2** (`Mediator.Abstractions` + `Mediator.SourceGenerator`); it replaced a pinned
MediatR 12.x in a refactor, so the samples in these skills use the `Mediator` shapes. Pick the mediator
**before scaffolding a handler**:

## Decision rule

1. Inspect the project's package references.
2. **`Mediator` (`martinothamar/Mediator`)** present → **preferred**. Source-generated, Apache-2.0, no
   per-seat cost, near drop-in API.
3. **`MediatR` ≤ v12** present → acceptable (still free); keep existing patterns.
4. **`MediatR` ≥ v13** present → **licensed**. Confirm the team holds a license; otherwise propose
   migrating to `Mediator`.
5. **No mediator package** present → **ASK THE USER which to install** (`Mediator` recommended) before
   writing the slice. Do not silently add a licensed package.

## API parity (why the swap is cheap)

The handler/behavior contracts are the same shape, so the slice skeleton (`dotnet:web-api`) is reused
almost verbatim. The differences are mechanical: `Mediator` handlers and behaviors return `ValueTask`,
a behavior's `next` is a `MessageHandlerDelegate<TRequest, TResponse>` called as `next(request, ct)`, and
behaviors constrain on the `IMessage` marker:

```csharp
public sealed record CreateActivity(...) : IRequest<Result<ActivityId>>;
public sealed class Handler : IRequestHandler<CreateActivity, Result<ActivityId>>
{
    public ValueTask<Result<ActivityId>> Handle(CreateActivity request, CancellationToken ct) { /* ... */ }
}
public sealed class ValidationBehavior<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull, IMessage
{
    public ValueTask<TResponse> Handle(TRequest request, MessageHandlerDelegate<TRequest, TResponse> next, CancellationToken ct) { /* ... */ }
}
```

Registration differs:

```csharp
// martinothamar/Mediator (source-gen) — preferred. Scoped, not the library default Singleton: handlers take
// scoped EF DbContexts, and a Singleton handler holding one is a captive-dependency bug.
builder.Services.AddMediator(o =>
{
    o.ServiceLifetime = ServiceLifetime.Scoped;
    o.PipelineBehaviors = [typeof(SensitiveRequestBehavior<,>), typeof(ValidationBehavior<,>), typeof(LockBehavior<,>)]; // declared order
});

// MediatR (≤ v12, free) — acceptable
builder.Services.AddMediatR(c => c.RegisterServicesFromAssembly(typeof(Program).Assembly)
    .AddOpenBehavior(typeof(ValidationBehavior<,>)));
```

`Mediator.SourceGenerator` only generates `AddMediator()` in the **outermost** project (the host), so a
library cannot register the mediator itself; with `Assemblies` left unset it discovers handlers across every
referenced assembly. The full `ValidationBehavior<,>` (failed `Result`, no exception) is in
`dotnet:validation` §3b; the other pipeline behaviors (`ILockRequest`/`LockBehavior`,
`ISensitiveRequest`/`SensitiveRequestBehavior`) and their order are in `dotnet:web-api` → Pipeline behaviors.

## Object mapping — no reflection mappers

AutoMapper is commercial **and** reflection-based. Use **`riok/Mapperly`** (source-gen, free,
zero-alloc, compile-time-checked) or hand-written mapping. Never add reflection AutoMapper to new code.

```csharp
[Mapper]
public partial class ActivityMapper
{
    public partial ActivityResponse ToResponse(Activity activity); // generated at build time
}
```

## Unified alternative — Wolverine

For greenfield services that want **mediator + messaging + outbox in one** free (Apache-2.0,
source-gen) package, **JasperFx/Wolverine** replaces MediatR **and** MassTransit. Handlers are plain
methods; `IMessageBus.PublishAsync` carries the durable outbox. Consider it when the licensing of both
MediatR and MassTransit is in play; otherwise the `Mediator` + existing outbox guidance is sufficient.

## Related

- `dotnet:web-api` (`../web-api/SKILL.md`) — ASP.NET Core Web API
- `dotnet:validation` (`../validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
