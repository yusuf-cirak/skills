---
metadata:
  file: architecture-modular-monolith.md
  sections:
    - {title: "1. When this applies", start: 19, end: 29}
    - {title: "2. Principles", start: 31, end: 42}
    - {title: "3. Design", start: 44, end: 191}
    - {title: "4. Traps", start: 193, end: 211}
    - {title: "5. Invariants to test", start: 213, end: 222}
    - {title: "6. Rationalizations / Red flags", start: 224, end: 233}
    - {title: "7. Checklist", start: 235, end: 250}
---
# Architecture: Modular Monolith

> **Golden path:** One deployable; modules own their data and talk only through a published contracts package and events; enforce the dependency direction with an executable rule.

> **Also open:** `outbox-inbox-messaging.md` (a module publishes or consumes events: never dual-write, deliver at-least-once); `idempotency-locking-concurrency.md` (consumers run twice and handlers race on the same row or local copy: dedupe and version); `persistence-migrations.md` (per-module schema, migrations, tracking defaults); `observability.md` (every handler and consumer needs logs, traces and correlation ids); `ddd-tactical.md` (only when adding an aggregate, port or domain event); `testing-strategy.md` (only when adding a module or a boundary rule: boundary, boot and spine tests).

## 1. When this applies

- Starting a service that will grow several bounded contexts but must ship as one deployable.
- Adding a module, a shared building block, or a cross-module interaction.
- Reviewing a diff where one module imports another, or where "shared" code is growing business words.
- Wiring the composition root (what the host knows, what each module registers).
- Starting a new project: ask the architecture questions first ("New project: ask first").
- Writing new code inside an existing project that is not modular: keep the module seams anyway (Principle 9).
- Making a module runnable on its own, or calling another module.

Strategic DDD (bounded contexts, context maps, anti-corruption layers) is covered by the installed `architecture-patterns` skill; this file covers the structural rules around it and the failure modes found in practice. Related: shared capabilities a module opts into include the hybrid cache (`caching.md`); the full middleware order the host builds is in `api-surface.md`.

## 2. Principles

1. **One deployable by default, many bounded contexts.** Each module is a vertical slice that owns its model, its schema, its migrations and its outbox. Splitting into services later should be a deployment change, not a rewrite.
2. **Shared code is product-neutral and layered.** Shared building blocks know nothing about tickets, orders or users. They are grouped by layer (domain core, application abstractions, infrastructure adapters, presentation/host concerns) and depend inward only.
3. **The only cross-module surface is a contracts package.** It holds integration-event records, public DTOs, public interfaces and the request/response records (queries and commands) that other modules send through the mediator, nothing else. No module references another module's non-contracts code.
4. **Cross-module calls are async in signature and in-process by default.** A module asks another module by sending a contracts request through the in-process mediator; the call is non-blocking in the language's idiom (see "Async call shape per language"), and the caller never knows what runs behind the handler. A state change is announced as an integration event through the module's own outbox in the same transaction, and other modules consume it through an inbox. Never through shared tables, never over a network call between modules of the same process.
5. **Capabilities are opt-in.** A module gains caching, locking, messaging or rate limiting by adding a dependency and calling one registration helper with an options callback. Nothing is on by default, so a module cannot be surprised by behavior it did not ask for.
6. **The monolith host is the single composition root of the deployed application.** It names modules by type, builds the pipeline and holds no business logic. Each module registers its own services, consumers and endpoints. Framework-level wiring is one call per concern.
7. **Reusable capability goes to the shared library; only module-specific policy stays in the module.** If a class would work unchanged in another module, it belongs in the shared layer. Module-specific helpers keep the module prefix even when they physically live in a shared project, so a generic-looking name never implies reuse that was not designed.
8. **Fail-closed gates sit at the write boundary,** in the command that persists a setting, not deep inside the consumer that later reads it.
9. **If the existing project uses a different architecture, follow its structure and record the deviation** (one decision record) so the session stays consistent. Follow it without breaking the module seams: new code does not read another feature's tables, depends on an interface or contract plus ids, and keeps its own data and handlers together so it can be lifted into a module later. Never write new coupling because the old code is coupled.
10. **Every module can run alone, but one host is deployed.** Each module has a thin API host (own entry point, own mediator registration, own migrations) on top of shared building blocks, so extraction is a deployment change. Until there is a named reason, the single deployed application is the monolith host.

## 3. Design

Layout (names illustrative; folder = layer):

```
shared/
  domain/            aggregate base, entity base, value-object base, domain-event markers, traits (auditable, tenant-owned)
  application/       ports (current-user, audit, token-blacklist, distributed-lock, tenant-context),
                     pipeline behaviors, telemetry constants, result/option primitives
  infrastructure/    persistence (conventions, interceptors, outbox/inbox), messaging adapter, cache, lock, secrets
  presentation/      web defaults, security, observability, health, rate limiting, module registry
modules/
  <module>/          domain/, application/, infrastructure/, host/ (folders; layering is convention inside a module)
  <module>.contracts integration events + public interfaces only
hosts/
  <module>.api       thin standalone host: shared presentation blocks + ONE module (own entry point, own mediator registration)
  monolith           THE composition root: composes all modules; the single deployed host until an extraction
```

A module may be one project with folders or several projects; what matters is that the boundary tests below pass. Presentation may depend on infrastructure where a concern genuinely needs it (rate limiting on top of the cache); infrastructure never depends on presentation. [shipped]

Module contract and registration:

```
interface Module {
  name
  assembly            # scanned for validators, consumers, endpoints
  register(services, config)
  mapEndpoints(router)
}
host:
  addModules(registry => registry.add<PlatformModule>().add<IamModule>().add<EventsModule>())
```

Registration is type-safe (no assembly-name strings). The module's `register` is its capability checklist: domain-event dispatch, tenant interceptor, database context with conventions, keyed outbox writer, self-applying migrations, optional polling relay. [shipped]

Boundary rules, expressed as executable tests:

```
domain          must not reference ORM / broker / driver packages
domain          must not reference application, infrastructure, presentation
application     may reference domain only (plus abstractions)
infrastructure  must not reference presentation
module A        must not reference module B except B.contracts
```

How to enforce this outside the reference's language:

| Language | Mechanism |
|---|---|
| .NET | Type/assembly dependency tests (NetArchTest-style) run in the unit-test project |
| Go | `internal/` packages for module-private code (compiler-enforced), plus an import-boundary linter (depguard or go-arch-lint style rules) for layer direction |
| Rust | One crate per module and per layer with `pub(crate)` for internals; dependency direction is the `Cargo.toml` graph, checked with `cargo deny` / `cargo tree` rules or a workspace lint test |
| TypeScript | Path-boundary lint rules or a dependency-graph checker (dependency-cruiser style) in CI |

Prefer mechanisms the compiler enforces (`internal/`, crate visibility) over linters, and linters over code review. Whatever the mechanism, it must fail the build.

### Standalone hosts and the monolith host `[proposed]`

```
building-blocks/   shared infra for EVERY host: authentication, middleware pipeline, observability, health, result-to-HTTP mapping
modules/orders/    orders + orders.contracts
modules/payments/  payments + payments.contracts
hosts/orders.api       = building-blocks + orders                (can run as its own process)
hosts/payments.api     = building-blocks + payments
hosts/monolith         = building-blocks + orders + payments + ... (single composition root, the deployed application)
```

- Auth and middleware live in the shared building blocks, once; no host copies them.
- Each host owns its own mediator registration and applies only its modules' migrations.
- When a host runs a module alone and that module sends a contract owned by another module, the other module's handler is not loaded: register a remote adapter for that contract (gRPC first, HTTP only if gRPC is not possible; see "Extraction path"). A host that sends a contract with no handler fails at boot, not at the first request.
- Having the thin module host ready is cheap; deploying it, moving data and adding remote adapters is extraction, and extraction needs a reason. Do not extract prematurely.

### Async call shape per language `[proposed]`

"Async" here means non-blocking call signatures, not that a message queue sits in the middle.

| Language | Shape of a cross-module contract call |
|---|---|
| C# | `Task<Result<T>> Send(request, CancellationToken)`; handlers are `async`; never `.Result` or `.Wait()` |
| Rust | `async fn` handler (native async fn in traits or `async_trait`), cancellation passed through; never `block_on` inside a handler |
| Go | plain `func(ctx context.Context, req Req) (Resp, error)` through an interface or registered function; do NOT spawn a goroutine or channel only to look async; use goroutines for real concurrency only |
| TypeScript | `Promise<Result<T>>` |

### New project: ask first `[proposed]`

When the user starts a new project, ask these before laying out folders (skip any question the user already answered):

1. Modular monolith, with modules that can later run alone?
2. Which modules (bounded contexts), and which data does each own?
3. Database: one server with a schema per module (default), or a separate database per module? Migrations are per module either way.
4. Standalone API host per module from day one (thin, default yes) in addition to the monolith host?
5. Cross-module calls: in-process mediator over contracts (default). Is any module already planned for a separate process, and why?
6. Shared building blocks for auth, middleware, observability: confirm one set for every host.
7. Mediator choice for the language (C# Mediator or MediatR; Go interface plus registration; Rust trait with async fn).

If the project is not modular and will stay that way, skip the questions and apply Principle 9.

Safe defaults for ports. Application registers a default for every port its behaviors need, using add-if-missing semantics, and the host overrides:

```
current-user      -> anonymous
token-blacklist   -> no-op            # explicit, documented fail-open
distributed-lock  -> throws on use    # fail loud: a lock-requiring request without a backend must not run unlocked
```

The rule: a default is either harmless-and-visible or it throws. It never silently degrades a safety property.

Lifetimes. Handlers and pipeline behaviors hold per-request resources (database context), so they are registered with request scope. A singleton behavior holding a scoped dependency is a captive dependency: it works in a one-request test and corrupts state under load.

### Cross-module data access (choose per need)

Never read another module's tables or database context. Four sanctioned routes:

1. **Contracts request through the mediator (default).** A's contracts package declares `Query(id) -> Result<Response>` (and commands the same way) as record types; A's module-internal handler answers; B sends it through the in-process mediator with an async call. B never references A's handler and never knows what is behind it (A's own code today, a remote adapter after extraction).
2. **Integration event + local copy.** Module B subscribes to A's event and keeps its own read-only copy of the fields it needs. Treat the copy as a cache: never write to it; send a command to A to change the source of truth. Use for reactive or performance-sensitive reads where a call per request is too chatty.
3. **Materialized view** owned by the reader, fed by events. Same rule as 1 for writes.
4. **Cache decorator** over a hot read path (read-through), so caching stays out of the repository.

Navigation properties across modules are forbidden; hold the other module's id and load separately. Do not call another module of the same process over HTTP: the contract plus its mediator handler exists for that. A remote adapter behind the same contract is reserved for a true microservice split, where the module now runs in another process (see "Extraction path"): gRPC first, HTTP only if gRPC is not possible, a broker for events. Record the reason. The callers do not change.

### Visibility and boundary tooling (.NET)

- Every type in a module's core project is `internal`. The only public type is the module registration class (`AddXModuleServices`-style); anything another module needs lives in the `.Contracts` project, never made public in the core project.
- Compile-time guard: `NsDepCop` as a Roslyn analyzer, one `config.nsdepcop` per project folder (only that file name is read), enabled for any project that has one via `Directory.Build.props`. `Name.*` matches a namespace and its sub-namespaces. Allow-list only: `Allowed From="App.B.*" To="App.A.Contracts"`; no rule means forbidden.
- Test-time guard: NetArchTest or ArchUnitNET asserting all module-core types are internal except the registrar.
- Compiler-enforced `internal` beats the analyzer, the analyzer beats the arch test, the arch test beats review.

### Per-module data isolation

Each module owns its database context (internal), a schema name constant (`internal const string SchemaName = "Books"`), and its migrations folder. Storage technology may differ per module (SQL, document store, Redis); that is allowed, because the boundary is the contract, not the engine.

### Two event tiers

- **Domain event:** internal to the module, raised by the aggregate, dispatched after the save commits. Internal type.
- **Integration event:** public record in the contracts package, published by a domain-event handler inside the originating module. Other modules handle it without referencing the originator. Flow: aggregate raises domain event -> save -> dispatcher publishes -> handler maps to integration event -> mediator delivers to other modules. For events that must not be lost, replace the in-process publish with the outbox (`outbox-inbox-messaging.md`).

### Shared kernel scope

Only: base classes (entity, value object, domain/integration event bases), marker interfaces (`IHaveDomainEvents`, domain-event dispatcher), and cross-cutting pipeline behaviors (logging, validation, telemetry). No business logic; framework abstractions only as dependencies. Publish as a package when several solutions share it.

### Extraction path

Because data, contracts and events are already separate and every module already has its thin API host, extracting a module is: (1) deploy that host alone, (2) on the calling side register a remote adapter (gRPC first, HTTP only if gRPC is not possible, a broker for events) as the handler for each contract the caller sends to it, so callers do not change, (3) ship the contracts package to both sides, (4) move the module's schema to its own database if needed. Do this only for a named operational reason (independent scaling, release cadence, team autonomy). Do not extract prematurely: until then the monolith host is the single deployed application, one database server with a schema per module, one pipeline. A separate server, pipeline or process per module before there is a reason is cost without benefit.

### Scaffold a new module (checklist order)

Core project (all internal) -> contracts project (events, DTOs, request/response records only) -> thin API host for the module -> tests project -> internal database context + schema constant + migrations -> registrar (the one public type; adds its assembly to the mediator scan list) -> register in host -> boundary rule (NsDepCop or arch test) -> confirm no module references this core project. Template: `Ardalis.Modulith` (`dotnet new modulith`, `dotnet new modulith-module`) generates this shape.

## 4. Traps

- **A per-module host that copies the infrastructure.** The standalone host re-implements authentication or middleware instead of using the shared building blocks, and the hosts drift. One shared set, every host references it.
- **A standalone host with an unresolved contract.** The module runs alone, sends a contract owned by another module, and no handler is registered: it fails on the first request in production. Register the adapter and cover every host with a boot test.
- **Fake async.** In Go, a goroutine and channel wrapped around an in-process call; in C#, `.Result` or `.Wait()` on the mediator; in Rust, `block_on` inside a handler. Use the idiom in "Async call shape per language".
- **A network call between modules of the same process** because "it is how microservices do it". It adds a network failure mode to a function call. A remote adapter (gRPC, else HTTP) is for a true microservice split and needs a recorded reason.
- **Public type made to "get around" the boundary.** A core type turned `public` so another module can use it silently kills the encapsulation and the compiler no longer guards it. Move it to contracts or expose a query instead.
- **Shared database context or cross-module navigation property.** Couples schemas and makes extraction a rewrite. Keep ids only.
- **Business logic in the host project.** The composition root becomes a god class. Host wires modules and nothing else.
- **Unkeyed per-module registrations.** Two modules each register "the outbox writer" without a key; the last registration wins, a handler silently enqueues into the other module's context, the row is never saved, the broker never sees it and the inbox stays empty. It surfaced when the second producing module broke the end-to-end spine test. Register such services keyed by their database context and inject by key. Any "one per module" service needs the same treatment.
- **Registry read before the container is built.** The module registry is consumed during setup; reading it before `addModules` has run returns nothing. Keep the order explicit and cover it with a boot test.
- **Whole-program code generation lives in the outermost project.** A source generator or reflection scan that needs to see every handler can only run where all modules are visible (the host), not in a shared library. Test projects that build their own container need the generator installed locally.
- **Namespace-valued constants fool the architecture test.** A `const` string whose value equals a layer namespace (for example an instrument name like `"Shared.RateLimiting"`) is read from compiled output as a dependency and produces a false violation. Exclude that type by name, or avoid namespace-valued literals.
- **Architecture tests enforce direction, not placement.** "Application must not depend on infrastructure" passes even when a business concept sits in application. Placement (see `ddd-tactical.md`) is a review convention.
- **Domain purity is a trade-off, not a fact.** The reference system's domain layer still referenced a mediator abstraction and a source generator, one module's `User` extended the identity framework's base class, and a query-translation attribute lived on an aggregate. The boundary test forbids ORM, broker and driver only. Document such exceptions; do not claim a framework-free domain you do not have. `[known gap]`
- **Contracts packages are inconsistent.** One module's contracts referenced its domain, others referenced application. Nothing pins what a contracts package may depend on. It should depend on nothing but primitives and shared contracts. `[known gap]`
- **No real cross-module consumer exists yet.** The reference system's integration event has no subscriber; the platform module consumes its own ping. The outbox/inbox spine is proven, the multi-module topology is not. `[known gap]`
- **Connector or topic lists drift from modules.** A CDC `include` list naming only one module's outbox silently drops every other module's events under the default relay (see `outbox-inbox-messaging.md`). Adding a module is a checklist item, not a code change.
- **Handlers use the database context directly** in this style (vertical slice, no repository wrapper). That is deliberate; the cost is that persistence conventions (tracking default, tenant filter) must live in the context configuration, not in a repository layer.

## 5. Invariants to test

- `[shipped]` Dependency-direction tests above run on every build and fail the pipeline on any new breach.
- `[shipped]` A module never references another module's non-contracts namespace (assembly-reference test).
- `[shipped]` Runtime spine test: write, outbox, broker, inbox, in one pass, against real infrastructure. It also boots the full host with every module registered, so an unregistered or mis-ordered module fails there.
- `[proposed]` A dedicated, fast boot test (host with every module registered; startup succeeds; registry populated) that does not need containers. In the reference system only the container-backed spine fixture boots the host.
- `[proposed]` A rule or grep test that no handler injects an unkeyed outbox writer. No such test exists in the reference system; the keyed-registration lesson is currently held by the spine test and by convention.
- `[proposed]` Boot test per host: each host starts, and every contract request its modules can send resolves to a handler (in-process or a remote adapter). A module host starts without the other modules loaded.
- `[proposed]` No module project references another host or another module's non-contracts code; no call to another module goes through a network client unless a remote adapter is registered for that contract.
- `[proposed]` Registered pipeline sequence equals the declared order (see `cqrs-use-case-pipeline.md`). Not present in the reference system.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "It's just one shared table, a join is easier than an event" | The first cross-module join welds two contexts together; every later split pays for it. |
| "Put it in shared, someone will reuse it" | Unreviewed reuse is how module words leak into shared code. Prefix it or keep it in the module. |
| "The domain layer can just use the framework helper" | Each exception is fine once and a pattern by the fifth. Record it. |
| "A default that quietly no-ops is friendlier" | A silently disabled safety property is a production incident waiting for a trigger. |

Red flags in a diff: a module project reference to another module; business vocabulary in a shared project; a service registered once but needed once per module; a registration that works in tests but is a singleton holding request-scoped state; a new constant whose string value is a namespace.

## 7. Checklist

- [ ] New module references only shared blocks and its own contracts.
- [ ] Contracts contain only events, DTOs, interfaces and request/response records.
- [ ] The module has a thin API host on the shared building blocks; hosts do not copy auth or middleware.
- [ ] Cross-module calls are async contract requests through the mediator; no network call between modules of the same process; a remote adapter (gRPC, else HTTP) only for a true split with a recorded reason.
- [ ] One deployed host (the monolith composition root) until a named extraction reason exists.
- [ ] New project: the architecture questions were asked; non-modular project: new code keeps the module seams.
- [ ] Core project types are internal; only the registrar is public.
- [ ] Each module has its own database context, schema name and migrations.
- [ ] Cross-module reads use an event-fed local copy or a contracts query, never another module's context.
- [ ] Per-module services (writer, migrator, context) are keyed or otherwise unambiguous.
- [ ] Port defaults are either harmless-and-visible or throw.
- [ ] Module added to every external list (connector include list, topic list, probe list).
- [ ] Boundary tests, spine test and boot test pass.
- [ ] Any deviation from the shared architecture has a one-page decision record.
