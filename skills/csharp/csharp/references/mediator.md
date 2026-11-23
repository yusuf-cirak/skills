# Mediator selection & licensing (single source of truth)

## Contents

- Decision rule
- API parity (why the swap is cheap)
- Related

> Requires .NET 8+. Owns the **which-mediator** decision for `yusufcirak-skills:csharp-web-api` and `yusufcirak-skills:csharp-validation`.

MediatR, AutoMapper and MassTransit moved to commercial licensing (MediatR v13+, AutoMapper v15+, MassTransit v9+). Prefer the source-generated, Apache-2.0 **`Mediator`** (`martinothamar/Mediator`): same handler shapes, no per-seat cost. Keep an existing free MediatR (v12 or older). Never add a licensed package silently: if no mediator is referenced, ask the user which to install before writing the slice.

Package choice flow, registration, lifetime and pipeline order: `setups/mediator.md`.

## API parity (why the swap is cheap)

The handler and behavior contracts have the same shape, so the slice skeleton (`yusufcirak-skills:csharp-web-api`) is reused almost verbatim. `Mediator` handlers and behaviors return `ValueTask`, a behavior's `next` is a `MessageHandlerDelegate<TRequest, TResponse>` called as `next(request, ct)`, and behaviors constrain on the `IMessage` marker:

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

## Related

- `yusufcirak-skills:csharp-web-api` (`../csharp-web-api/SKILL.md`) — ASP.NET Core Web API
- `yusufcirak-skills:csharp-validation` (`../csharp-validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
