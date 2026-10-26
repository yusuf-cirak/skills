---
name: ddd
description: Guides .NET domain modeling and solution layout. Use when modeling a domain, adding or changing an aggregate/entity/domain-event, scaffolding a new module or feature, or deciding project/layer layout. Request validation and JSON config live in `validation`; endpoint wiring in `web-api`.
---

# .NET Domain-Driven Design & Architecture

## Contents

- Domain Driven Design → `../csharp/references/monads.md`, `../csharp/references/value-object-base.md`, `../csharp/references/strongly-typed-ids-and-value-objects.md`, `../csharp/references/state-as-types.md`
- Modular Monolith Architecture
- Vertical Slice Architecture (inside Application) → `dotnet:web-api`
- Strongly-typed IDs → `../csharp/references/strongly-typed-ids-and-value-objects.md`
- Persisting domain types (EF Core) → `../csharp/references/ef-core-data-access.md`
- Domain-event dispatch (concrete) → `dotnet:hardening`, `dotnet:csharp`
- Placement & naming of reusable capabilities
- Cross-cutting ports & primitives live in Application, not Domain
- Related skills → `dotnet:csharp`, `dotnet:web-api`, `dotnet:validation`, `dotnet:hardening`, `dotnet:testing`

## Files

- `../csharp/references/monads.md` — Monadic error handling — library selection & usage
- `../csharp/references/value-object-base.md` — Value Object base type + converters
- `../csharp/references/strongly-typed-ids-and-value-objects.md` — Strongly-typed IDs & value objects (Vogen)
- `../csharp/references/state-as-types.md` — State as types — polymorphic state machines (no boolean flags)
- `../csharp/references/ef-core-data-access.md` — EF Core data access — performance & value-object persistence (single source of truth)
- `dotnet:web-api` (`../web-api/SKILL.md`) — ASP.NET Core Web API
- `dotnet:hardening` (`../hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `dotnet:csharp` (`../csharp/SKILL.md`) — C# House Style
- `dotnet:validation` (`../validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
- `dotnet:testing` (`../testing/SKILL.md`) — C# Testing Standard

Owns **where domain logic lives** and how the solution is structured: DDD tactical patterns (business logic in domain models, domain services, domain events, private-constructor + static-factory aggregates, value objects for primitives, discriminated unions for variants), the Modular Monolith layout (`BuildingBlocks/{Application,Domain,Infrastructure,Presentation}/*`, `Modules/<Name>/{<Name>,<Name>.Contracts}` with layers as folders, `Host/*.AppHost`), and Vertical-Slice module structure. Record/value-object/discriminated-union *language patterns* come from `csharp`; this skill governs domain modeling and module layout. Apply alongside `csharp`.

## Domain Driven Design

- Apply DDD principles. Business logic lives in domain models. Add domain services in the domain layer when needed.
- Pass services into domain methods as parameters when needed — only for operations without side effects.
- Use **Domain Events** for cross-cutting concerns.
- Domain models: **private constructor + static factory methods**. Never construct directly when a factory exists.
- Validation goes in the factory method. Return a monad type (`Result<T>` / `Option<T>` — from YC.Monad if available, otherwise the codebase's existing equivalent) when validation can fail. See `../csharp/references/monads.md`.
- Use **value objects** for complex primitives. Hand-rolled base: `../csharp/references/value-object-base.md`; source-generated (Vogen `[ValueObject<string>]`, `NormalizeInput`/`Validate`/`[GeneratedRegex]`): `../csharp/references/strongly-typed-ids-and-value-objects.md`.
- Use **discriminated unions** for types with multiple variants.
- Model aggregate/entity **state machines as types**, not boolean flags or a status enum: sealed
  per-state subtypes that expose only their legal operations, a DU for the state payload, capability
  interfaces, and `Try*` pattern-matched transitions. Pick the stored shape (flat record, TPH, or
  polymorphic JSON) from the domain and the DB technology; callers use one `WriteTo`-style method and
  the state decides whether it writes or no-ops. Full pattern: `../csharp/references/state-as-types.md`.

## Modular Monolith Architecture

Default layout (the reference repo, TicketMaster):

- `src/BuildingBlocks/` — **one project per cross-cutting capability, grouped by layer folder** (~13 blocks):
  - `Application/BuildingBlocks.Application` — Mediator pipeline behaviors (`Validation`/`Lock`/`SensitiveRequest`), ports (`ICurrentUser`, `ITokenBlacklist`, `IDistributedLock`), pagination.
  - `Domain/BuildingBlocks.Domain` — `Entity`, `AggregateRoot`/`IAggregateRoot`, `IDomainEvent` (+ `IPreDomainEvent`/`IPostDomainEvent`), `Error`/`ValidationError`.
  - `Infrastructure/BuildingBlocks.{Persistence,Caching,Locking,Messaging.Kafka,Configuration.Secrets}` — EF conventions + outbox + interceptors, FusionCache/Redis, Redis lock + token blacklist, MassTransit Kafka rider, encrypted config.
  - `Presentation/BuildingBlocks.{Web,Security,RateLimiting,Observability,HealthChecks,Modularity}` — service defaults + idempotency + Result→HTTP mapper, JWT/scopes, rate limiting, OTel, health, `IModule`.
- `src/Modules/<ModuleName>/` — **one project plus a Contracts project**, layers are folders, not projects:
  - `<Solution>.Modules.<ModuleName>/{Application,Domain,Infrastructure,Host,Migrations}` — commands/queries/handlers, aggregates, DbContext + repositories, endpoints + the `IModule` class, EF migrations.
  - `<Solution>.Modules.<ModuleName>.Contracts` — integration events + public DTOs for cross-module use.
- `src/Host/<Solution>.AppHost` — the only executable; registers modules by type and owns `AddMediator()` (the source generator runs only in the outermost project).
- `<Solution>.slnx` — solution file.

Module registration is a named opt-in, no assembly scanning for modules:

```csharp
// each module: Name, Assembly (scanned for handlers/validators), Add(services, config), MapEndpoints(group)
public sealed class EventsModule : IModule { /* ... */ }

// host
builder.AddModules(m => m.Add<PlatformModule>().Add<IamModule>().Add<EventsModule>());
api.MapModuleEndpoints(); // every module's MapEndpoints on the shared /api group
```

If the existing project uses a different architecture, **follow that architecture** and record the deviation so it stays consistent across the session.

## Vertical Slice Architecture (inside Application)

- Organize by business capability under `Features/`.
- Structure: `Features/<FeatureName>/<Scope>/<Commands|Queries>/`.
- Example: `Features/VendorActivities/Backoffice/Commands/CreateActivityCommand.cs`.
- One slice file holds Command/Query + Handler + slice-specific DTOs/Validators.

The concrete slice skeleton (Endpoint/Request/Validator/Handler/Response) and FluentValidation conventions live in `web-api` — this skill only fixes *where* slices sit in the module layout.

## Strongly-typed IDs

An entity id is never a raw `Guid`/`int` (prevents `customerId == orderId` mixing at compile time).
Two acceptable forms: a `ValueObject<T>` id (see `value-object-base.md`) when it should share the VO
base + factory rules, or a **Vogen** `[ValueObject<Guid>]` when you want equality/validation/converters
generated. Full Vogen depth (int reference-data ids, converter registration, `IParsable`, packaging,
`TryFrom` vs `Result`): `../csharp/references/strongly-typed-ids-and-value-objects.md`.

## Persisting domain types (EF Core)

Value objects and strongly-typed ids map to the DB without leaking persistence into the domain:

- **Complex types** (`ComplexProperty`, EF/.NET 8) for multi-field VOs that share the owner's table.
- **Value converters** (`HasConversion`, EF 5+) for single-value VOs / ids — Vogen ships one.

Full idioms + query-perf rules: `../csharp/references/ef-core-data-access.md`.

## Domain-event dispatch (concrete)

Aggregates implement `IAggregateRoot` (`DomainEvents` + `ClearDomainEvents()`) and raise events into an
internal list; **a scoped `SaveChangesInterceptor` drains and dispatches them** — not a hand-called publish the
developer can forget. Cross-process delivery always goes through the outbox row committed with the state
(never dual-write to a broker; see `hardening` → Background Jobs), relayed by Debezium or a polling
`BackgroundService` (`../csharp/references/outbox-debezium-masstransit.md`).

**Primary path — the command enqueues the integration event.** `IOutboxWriter.Enqueue` only appends an
`OutboxMessage` to the current change tracker; the handler's own `SaveChangesAsync` commits state + row in one
transaction. The writer is **keyed by DbContext** (one per module — an unkeyed registration collides across
modules):

```csharp
public sealed class Handler(
    EventsDbContext db,
    [FromKeyedServices(nameof(EventsDbContext))] IOutboxWriter outbox) : IRequestHandler<Command, Result<Response>>
{
    public async ValueTask<Result<Response>> Handle(Command request, CancellationToken ct)
    {
        var scheduled = Event.Schedule(request.Name, request.Venue, request.StartsOn, request.Capacity);
        if (!scheduled.IsSuccess) return scheduled.Error;

        var ev = scheduled.Value;
        db.Events.Add(ev);
        outbox.Enqueue(new EventScheduledIntegrationEvent(ev.Id.Value, ev.Name, /* ... */),
            aggregateType: nameof(Event), aggregateId: ev.Id.Value.ToString());
        await db.SaveChangesAsync(ct); // state + outbox row, one transaction
        return Result.Success(new Response(ev.Id.Value));
    }
}
```

**Alternative — a pre-commit domain-event handler writes the row.** When the aggregate raises a domain event
and the command should not know about integration events, one `INotificationHandler<T>` per event does the
`Enqueue`, run by the interceptor **pre-commit** (`IPreDomainEvent`) so the row commits atomically with the
state:

```csharp
public sealed class OrderPaidOutbox([FromKeyedServices(nameof(OrdersDbContext))] IOutboxWriter outbox)
    : INotificationHandler<OrderPaid>
{
    public ValueTask Handle(OrderPaid e, CancellationToken ct)
    {
        outbox.Enqueue(new OrderPaidIntegrationEvent(e.OrderId), aggregateType: "Order", aggregateId: e.OrderId.ToString());
        return ValueTask.CompletedTask; // same DbContext, same SaveChanges
    }
}
```

**Two-model persistence** (flat row, aggregate not tracked; `state-as-types.md` §5a): the tracker holds
the row, not the `AggregateRoot`, so the interceptor below finds nothing. Have the repository hand the
drained events to a scoped `DomainEventCollector` and let the same interceptor dispatch from it:

```csharp
public sealed class DomainEventCollector
{
    private readonly List<IDomainEvent> _events = [];
    public void Add(IEnumerable<IDomainEvent> events) => _events.AddRange(events);
    public IDomainEvent[] Drain() { var e = _events.ToArray(); _events.Clear(); return e; }
}
// repository: order.WriteTo(record); collector.Add(order.DrainDomainEvents()); await db.SaveChangesAsync(ct);
// interceptor: var events = tracked-aggregate events.Concat(collector.Drain())
```

```csharp
public sealed class DomainEventDispatchInterceptor(IPublisher publisher) : SaveChangesInterceptor
{
    private readonly List<IPostDomainEvent> _postCommit = [];

    public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData e, InterceptionResult<int> r, CancellationToken ct = default)
    {
        var aggregates = e.Context!.ChangeTracker.Entries<IAggregateRoot>()
            .Where(x => x.Entity.DomainEvents.Count > 0).Select(x => x.Entity).ToArray();
        var events = aggregates.SelectMany(a => a.DomainEvents).ToArray();
        foreach (var a in aggregates) a.ClearDomainEvents();

        foreach (var pre in events.OfType<IPreDomainEvent>()) await publisher.Publish(pre, ct); // same transaction
        _postCommit.AddRange(events.OfType<IPostDomainEvent>());
        return await base.SavingChangesAsync(e, r, ct);
    }
    // SavedChangesAsync publishes _postCommit; SaveChangesFailed(Async) clears it so a rolled-back save leaks nothing.
}
```

Register the interceptor **scoped** and add it to the DbContext from the same scope, so `IPublisher` resolves
handlers against the very DbContext being saved (works identically under an HTTP scope and a consumer scope).

> Bulk `ExecuteUpdate`/`ExecuteDelete` bypasses the change tracker, so it does **not** raise domain
> events — use it only for maintenance paths, never to mutate event-raising aggregates.

**Pre/Post split.** `IPreDomainEvent : IDomainEvent` is published inside `SavingChangesAsync` (SAME
transaction, before commit — invariants / derived writes that must persist atomically); `IPostDomainEvent`
is published in `SavedChangesAsync` (AFTER commit — side-effects: notifications, integration/outbox
events). One interceptor drains the aggregate's events and splits by marker.

## Placement & naming of reusable capabilities

- **Reusable capability → the shared library, behind a surface parallel to the existing ones.** If the library
  already exposes `service.Document.AnalyzeAsync`, a new capability is `service.Decision.DecideAsync` — not a
  module-local service that re-implements provider selection, fallbacks, retries or caching. Building on the
  existing pipeline makes every cross-cutting behavior apply for free.
- **The module keeps only what is specific to it**: the policy text/rules, orchestration, usage/audit recording,
  and mapping the result to the module's own failures. If a class would work unchanged in another module, it
  belongs in the library.
- **Module-specific helpers carry the module prefix even when they live in a shared project** (`ExpensePromptBlock`,
  `ExpenseOcrLimits`), so a generic-looking name never implies reuse that was not designed.
- **Fail-closed gates sit at the write boundary** (the command that persists the setting), not deep inside the
  consumer — reject before bad data can be stored or served.

## Cross-cutting ports & primitives live in Application, not Domain

`BuildingBlocks.Domain` holds **only business concepts**: aggregate bases, value objects, domain events, and real domain
traits that aggregates implement (`IAuditable`, `ITenantOwned`). Anything that models *no business concept* but that many
layers need goes in `BuildingBlocks.Application` — every Infrastructure, Presentation and module project already
references it (directly or transitively), so it is the lowest common home that does not pollute the domain:

| Lives in `BuildingBlocks.Application` | Why not Domain |
|---|---|
| `ICurrentUser`, `ITokenBlacklist` (+ `Anonymous…`/`NoOp…` defaults) | who is calling / revoked tokens is a request concern, not a business rule |
| `IAuditLogger` | a port for recording audits; the *trait* `IAuditable` stays in Domain |
| `TelemetryConstants` (correlation / instrument-name keys) | telemetry contract, not domain language (broker wire headers such as `MessageHeaders` stay in the messaging Infrastructure project that owns that wire contract) |
| `MigrationReadinessTracker` and similar startup-coordination primitives | ops plumbing |

Test: *"would a domain expert recognise this word?"* Yes → Domain. No → Application (a port) or Infrastructure (its
implementation). Ports are declared in Application and implemented in Infrastructure/Presentation — dependencies point
inward only.

Footgun for the architecture test: **NetArchTest reads `const string` IL literals as dependencies.** A constants class whose
values equal layer namespaces (e.g. OTel meter names `"BuildingBlocks.RateLimiting"`) makes
`Application_must_not_depend_on_infrastructure…` fail with a false positive. Exclude that type
(`.That().DoNotHaveName("TelemetryConstants")`) or avoid namespace-valued literals. Architecture tests enforce dependency
*direction* only — placement above is a convention they cannot check.

## Related skills

- `dotnet:csharp` — record/VO/DU/monad language patterns used by domain models.
- `dotnet:web-api` — slice skeleton, handlers, endpoints.
- `dotnet:validation` — request DTO limits and validators.
- `dotnet:hardening` — multi-tenancy, outbox, EF hardening for the infra layer.
- `dotnet:testing` — architecture tests enforce these layer boundaries; unit tests for domain factories.
