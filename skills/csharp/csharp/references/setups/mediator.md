# Setup: mediator package and registration

Load when no mediator package is referenced yet, or when wiring `AddMediator` in the host. The decision (which library and why) lives in `../mediator.md`.

## Pick the package

1. Inspect the project's package references.
2. `Mediator` (`martinothamar/Mediator`, `Mediator.Abstractions` + `Mediator.SourceGenerator`) present: keep it. Source-generated, Apache-2.0, no per-seat cost.
3. `MediatR` v12 or older present: keep existing patterns, it is still free.
4. `MediatR` v13 or newer present: licensed. Confirm the team holds a license, otherwise propose migrating to `Mediator`.
5. Nothing present: ask the user which to install (`Mediator` recommended) before writing the slice. Never add a licensed package silently.

## Registration

```csharp
// martinothamar/Mediator (source-gen), preferred. Scoped, not the library default Singleton:
// handlers take scoped EF DbContexts, and a Singleton handler holding one is a captive-dependency bug.
builder.Services.AddMediator(o =>
{
    o.ServiceLifetime = ServiceLifetime.Scoped;
    o.PipelineBehaviors = [typeof(SensitiveRequestBehavior<,>), typeof(ValidationBehavior<,>), typeof(LockBehavior<,>)]; // declared order
});

// MediatR (v12 or older, free), acceptable
builder.Services.AddMediatR(c => c.RegisterServicesFromAssembly(typeof(Program).Assembly)
    .AddOpenBehavior(typeof(ValidationBehavior<,>)));
```

- `Mediator.SourceGenerator` generates `AddMediator()` only in the outermost project (the host), so a library cannot register the mediator itself. With `Assemblies` unset it discovers handlers across every referenced assembly.
- The behaviors and their order: `yusufcirak-skills:csharp-web-api` (Pipeline behaviors). The full `ValidationBehavior<,>`: `yusufcirak-skills:csharp-validation` (Validators run in the pipeline).
