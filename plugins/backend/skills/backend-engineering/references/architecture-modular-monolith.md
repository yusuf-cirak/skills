---
metadata:
  file: architecture-modular-monolith.md
  sections:
    - {title: "1. When this applies", start: 17, end: 24}
    - {title: "2. Principles", start: 26, end: 36}
    - {title: "3. Design", start: 38, end: 103}
    - {title: "4. Traps", start: 105, end: 116}
    - {title: "5. Invariants to test", start: 118, end: 125}
    - {title: "6. Rationalizations / Red flags", start: 127, end: 136}
    - {title: "7. Checklist", start: 138, end: 146}
---
# Architecture: Modular Monolith

> **Golden path:** One deployable; modules own their data and talk only through a published contracts package and events; enforce the dependency direction with an executable rule.

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

## 4. Traps

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
- [ ] Per-module services (writer, migrator, context) are keyed or otherwise unambiguous.
- [ ] Port defaults are either harmless-and-visible or throw.
- [ ] Module added to every external list (connector include list, topic list, probe list).
- [ ] Boundary tests, spine test and boot test pass.
- [ ] Any deviation from the shared architecture has a one-page decision record.
