---
metadata:
  file: architecture-modular-monolith.md
  sections:
    - {title: "1. When this applies", start: 19, end: 26}
    - {title: "2. Principles", start: 28, end: 38}
    - {title: "3. Design", start: 40, end: 144}
    - {title: "4. Traps", start: 146, end: 160}
    - {title: "5. Invariants to test", start: 162, end: 169}
    - {title: "6. Rationalizations / Red flags", start: 171, end: 180}
    - {title: "7. Checklist", start: 182, end: 193}
---
# Architecture: Modular Monolith

> **Golden path:** One deployable; modules own their data and talk only through a published contracts package and events; enforce the dependency direction with an executable rule.

> **Also open:** `outbox-inbox-messaging.md` (a module publishes or consumes events: never dual-write, deliver at-least-once); `idempotency-locking-concurrency.md` (consumers run twice and handlers race on the same row or local copy: dedupe and version); `persistence-migrations.md` (per-module schema, migrations, tracking defaults); `observability.md` (every handler and consumer needs logs, traces and correlation ids); `ddd-tactical.md` (where aggregates, ports and domain events live); `testing-strategy.md` (boundary, boot and spine tests).

## 1. When this applies

- Starting a service that will grow several bounded contexts but must ship as one deployable.
- Adding a module, a shared building block, or a cross-module interaction.
- Reviewing a diff where one module imports another, or where "shared" code is growing business words.
- Wiring the composition root (what the host knows, what each module registers).

Strategic DDD (bounded contexts, context maps, anti-corruption layers) is covered by the installed `architecture-patterns` skill; this file covers the structural rules around it and the failure modes found in practice. Related: shared capabilities a module opts into include the hybrid cache (`caching.md`); the full middleware order the host builds is in `api-surface.md`.

## 2. Principles

1. **One deployable, many bounded contexts.** Each module is a vertical slice that owns its model, its schema, its migrations and its outbox. Splitting into services later should be a deployment change, not a rewrite.
2. **Shared code is product-neutral and layered.** Shared building blocks know nothing about tickets, orders or users. They are grouped by layer (domain core, application abstractions, infrastructure adapters, presentation/host concerns) and depend inward only.
3. **The only cross-module surface is a contracts package.** It holds integration-event records, public DTOs and public interfaces, nothing else. No module references another module's non-contracts code.
4. **Cross-module communication is asynchronous by default.** A module publishes an integration event through its own outbox in the same transaction as its state change; other modules consume it through an inbox. Synchronous calls go through a contracts interface, never through shared tables.
5. **Capabilities are opt-in.** A module gains caching, locking, messaging or rate limiting by adding a dependency and calling one registration helper with an options callback. Nothing is on by default, so a module cannot be surprised by behavior it did not ask for.
6. **The host names modules by type and nothing else.** Each module registers its own services, consumers and endpoints. Framework-level wiring is one call per concern.
7. **Reusable capability goes to the shared library; only module-specific policy stays in the module.** If a class would work unchanged in another module, it belongs in the shared layer. Module-specific helpers keep the module prefix even when they physically live in a shared project, so a generic-looking name never implies reuse that was not designed.
8. **Fail-closed gates sit at the write boundary,** in the command that persists a setting, not deep inside the consumer that later reads it.
9. **If the existing project uses a different architecture, follow it** and record the deviation (one decision record) so the session stays consistent.

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
host/                composition root: names modules, builds the pipeline
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

Safe defaults for ports. Application registers a default for every port its behaviors need, using add-if-missing semantics, and the host overrides:

```
current-user      -> anonymous
token-blacklist   -> no-op            # explicit, documented fail-open
distributed-lock  -> throws on use    # fail loud: a lock-requiring request without a backend must not run unlocked
```

The rule: a default is either harmless-and-visible or it throws. It never silently degrades a safety property.

Lifetimes. Handlers and pipeline behaviors hold per-request resources (database context), so they are registered with request scope. A singleton behavior holding a scoped dependency is a captive dependency: it works in a one-request test and corrupts state under load.

### Cross-module data access (choose per need)

Never read another module's tables or database context. Four sanctioned routes, in order of preference:

1. **Integration event + local copy.** Module B subscribes to A's event and keeps its own read-only copy of the fields it needs. Treat the copy as a cache: never write to it; send a command to A to change the source of truth. Best for reactive, performance-sensitive reads.
2. **Contracts query, in-process.** A's contracts package declares `Query(id) -> Result<Response>` (record types); A's module-internal handler answers it; B sends it through the in-process mediator. B never references A's handler. Use for synchronous read-time needs.
3. **Materialized view** owned by the reader, fed by events. Same rule as 1 for writes.
4. **Cache decorator** over a hot read path (read-through), so caching stays out of the repository.

Navigation properties across modules are forbidden; hold the other module's id and load separately. Sync HTTP between modules inside one deployable is wrong: use the in-process mediator and keep HTTP for a real extraction.

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

Because data, contracts and events are already separate, extracting a module is: (1) swap in-process mediator dispatch for HTTP or a broker at the contracts seam, (2) ship the contracts package to both sides, (3) move the module's schema to its own database. Extract only for a named operational reason (independent scaling, release cadence, team autonomy), never pre-emptively.

### Scaffold a new module (checklist order)

Core project (all internal) -> contracts project (events, DTOs, query records only) -> tests project -> internal database context + schema constant + migrations -> registrar (the one public type; adds its assembly to the mediator scan list) -> register in host -> boundary rule (NsDepCop or arch test) -> confirm no module references this core project. Template: `Ardalis.Modulith` (`dotnet new modulith`, `dotnet new modulith-module`) generates this shape.

## 4. Traps

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
- [ ] Contracts contain only events, DTOs and interfaces.
- [ ] Core project types are internal; only the registrar is public.
- [ ] Each module has its own database context, schema name and migrations.
- [ ] Cross-module reads use an event-fed local copy or a contracts query, never another module's context.
- [ ] Per-module services (writer, migrator, context) are keyed or otherwise unambiguous.
- [ ] Port defaults are either harmless-and-visible or throw.
- [ ] Module added to every external list (connector include list, topic list, probe list).
- [ ] Boundary tests, spine test and boot test pass.
- [ ] Any deviation from the shared architecture has a one-page decision record.
