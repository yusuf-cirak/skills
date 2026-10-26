---
metadata:
  file: ddd-tactical.md
  sections:
    - {title: "1. When this applies", start: 17, end: 23}
    - {title: "2. Principles", start: 25, end: 34}
    - {title: "3. Design", start: 36, end: 133}
    - {title: "4. Traps", start: 135, end: 142}
    - {title: "5. Invariants to test", start: 144, end: 152}
    - {title: "6. Rationalizations / Red flags", start: 154, end: 164}
    - {title: "7. Checklist", start: 166, end: 174}
---
# Domain Modeling: Tactical DDD

> **Golden path:** Build aggregates only through factories that return success-or-error, give every aggregate its own id type, keep cross-cutting ports out of the domain layer, and raise events inside the aggregate.

## 1. When this applies

- Adding or changing an aggregate, entity, value object, typed id, domain event or domain state.
- Deciding whether a concept belongs in the domain layer or one layer out (a port).
- Reviewing a factory, a constructor, an id type, or a "status" field.

Strategic DDD (bounded contexts, context maps, anti-corruption layers, ubiquitous language across teams) is in the installed `architecture-patterns` skill. This file is the tactical layer and the lessons that cost real time.

## 2. Principles

1. **An aggregate is a consistency boundary.** One transaction changes one aggregate. Other aggregates are referenced by id, never held as object graphs. Cross-aggregate effects travel as domain events.
2. **Invalid instances cannot exist.** Construction goes through a factory that returns success-or-error; the constructor is private. Validation lives in the factory (and in value-object constructors), not scattered across callers.
3. **Value objects replace primitives that carry rules.** Email, money, phone, ip address. They are immutable, validated at construction, compared by value, and they own their security posture (below).
4. **Ids are distinct types per aggregate.** Mixing an order id and a customer id is a compile error, not a data-corruption bug.
5. **State is modeled, not flagged.** Prefer types or guarded transitions over a bag of booleans and a status field anyone can set.
6. **The domain layer holds business concepts only.** Cross-cutting ports (current user, audit logger, token blacklist, distributed lock, tenant context) are declared one layer out, in application.
7. **Business logic lives in the domain model.** Domain services exist for logic that spans aggregates; they take dependencies as parameters and perform no side effects.
8. **Use the language of the domain expert.** Every name in code matches the term used by the people who own the rule.

## 3. Design

### Aggregate with a factory

```
type Event (aggregate root)
  private constructor(...)
  static schedule(input, clock) -> Result<Event>:
      validate(input)                       # return Failure(code, message, 400) on any breach
      e = new Event(id = newTimeOrderedId(), ...)
      e.raise(EventScheduled(e.id))         # appended to an internal list
      return Success(e)
  transitions return Result, e.g. lock() fails with conflict when the state is already disabled
```

The aggregate base keeps a private event list, `raise(event)` appends, the persistence layer reads and clears it on save. Trait interfaces (auditable, soft-deletable, tenant-owned) are real domain traits and stay in the domain layer; implement the risky ones explicitly so domain code cannot call them (`setTenantId` is explicit-interface only, so only the write guard stamps it). [shipped]

### Value object with a security posture

For anything parsed from untrusted input, the value object is a trust boundary:

```
Email.parse(raw):
  if length(raw) > MAX + small slack: reject      # BEFORE trim/lowercase: those allocate a copy
  value = trim(raw); length caps (total 254, local 64, domain 253, label 63)
  ASCII-only                                      # defeats homograph / confusable-character attacks
  lowercase; non-backtracking pattern             # no ReDoS; linear-time engine or hand parser
  reject reserved TLDs (local, test, example, invalid, localhost, device-name TLDs)
  reject disposable-provider domains              # frozen set loaded once; policy choice, make it configurable
  store  value                                    # what the user typed (trimmed, lowercased)
  derive canonical                                # provider-specific folds ONLY for providers known to alias
  dedupe / unique-index on canonical, never on value
```

Return a failure value, not an exception, on bad input. Caps come before parsing so an attacker cannot burn CPU with a megabyte string. Canonicalization is deliberately narrow: fold dots and `+tag` only for providers known to treat them as aliases (the reference folds one provider's two domains) and leave every other address as its exact lowercase form, because wrongly merging two real accounts is worse than allowing a duplicate.

**Trap: the identity store must use the same canonical form.** If the framework that stores users computes its own lookup key (an upper-cased address by default), then creation, lookup and recovery each canonicalize differently and aliases create duplicate accounts or let a confusable address collapse onto a victim's. Plug the value object's canonical form into the store's lookup normalizer (the reference registers a normalizer that parses with the value object and uppercases `canonical`, falling back to the raw input when it does not parse) so there is exactly one canonicalization path across registration, login and recovery.

### Typed ids

```
type EventId  = Id<UUID>      # one distinct type per aggregate
type RoleId   = Id<int>       # reference data: DB-assigned ints, zero allowed before insert, no validation

rules:
  - database never generates aggregate ids; the application mints them (time-ordered UUID),
    mark "generated never" in the mapping
  - conversion to/from storage and JSON is generated or table-driven, zero reflection per call
  - registered once at startup by scanning, never listed id by id
  - in queries, compare/project the converted property itself, never reach into its inner value
```

Lesson learned (twice): a hand-rolled id type rebuilt through reflection and needed a marker interface; it was tried, then reverted to a source-generated one. Cursor pagination was also built and reverted because the query provider could not translate an ordering or filter that reached into the wrapped id inside a DTO projection; only anonymous projections translated. If the id needs a storage converter, that converter lives where the storage reference lives (the module), which is why a tenant id stayed a plain UUID in the reference system. Response DTOs should use one convention (typed id or raw primitive), not both. `[known gap]`

### Entity vs aggregate (child entity)

A refresh token is a child entity of the user, not an aggregate: it stores only a hash, carries a rotation chain, answers `isActive(now)`, and is idempotent to revoke (`revokedAt ??= now`). It has no business invariants of its own beyond that and is not auditable. Ask: "does this need its own transaction boundary and its own events?" If no, it is a child.

### State as types

```
enum + guarded transition (cheap):    lock() -> Failure(conflict) if state == Disabled
types per state (when states differ in data or legal operations):
    Draft{...}  Published{publishedAt}  Cancelled{reason}
    each exposes only its legal operations; transitions are tryX(...) returning Result/Option
variants of data: tagged union / discriminated union, never nullable-field soup
stored shape (flat, single-table, or polymorphic json) is chosen by the database technology;
callers use one "write to record" method and the state decides whether it writes or no-ops
```

State-as-types is thin in the reference system (mostly enum plus guarded transition). Do not over-model; reach for per-state types when booleans start to contradict each other.

### Domain events: pre-commit vs post-commit

```
pre-commit  (marker: pre)  : published inside the save, same transaction, before rows are written.
                             Use for derived writes and outbox rows that must commit atomically.
post-commit (marker: post) : stashed, published after a successful save, cleared if the save fails.
                             Use for notifications. Never for anything that must happen.
```

A save interceptor (not a hand-called publish) collects events from tracked aggregates, clears them, and dispatches by marker. The loss window: post-commit events live in memory only; a crash between commit and publish drops them. Anything durable goes through the outbox (pre-commit). Events raised by a pre-commit handler on aggregates added during the same save are not re-collected (single pass). Bulk set-based updates bypass the change tracker and therefore raise no events; use them only on maintenance paths, never on event-raising aggregates.

Two ways to get outbox rows, both valid: (a) a pre-commit event handler writes the row, so adding an integration event is one event record plus one handler and no call-site change; (b) the command handler calls a keyed outbox writer directly (the reference system's choice, see `outbox-inbox-messaging.md`). Pick one per module and keep it consistent. Never dual-write to the broker.

Two-model persistence (flat row with an untracked aggregate): the tracker sees the row, not the aggregate root, so the interceptor finds no events. The repository must hand drained events to a request-scoped collector that the same interceptor reads.

### Port placement

```
Domain      : aggregate/entity/value-object bases, domain events, real domain traits (auditable, tenant-owned)
Application : ports with no business meaning (current-user, token-blacklist, audit-logger, distributed-lock,
              tenant-context), telemetry constants, startup-coordination primitives; safe defaults for each port
Infra / Web : implementations
test: "would a domain expert recognise this word?"  yes -> Domain.  no -> Application (port) or Infrastructure.
```

Moving these ports out of the domain (a real refactor in the reference system) fixed a layer that had become a dumping ground.

## 4. Traps

- **Domain is not framework-free in practice.** The reference domain layer referenced a mediator abstraction (domain events extend a notification marker) and a generator library for ids, used a query-translation attribute on an aggregate, and one module's `User` extended the identity framework's base class, merging aggregate and credential store. These are pragmatic, documented trade-offs, and the dependency test forbids only ORM, broker and driver. Do not describe this as pure DDD. `[known gap]`
- **Load-modify-save with a no-tracking default** silently no-ops (see `persistence-migrations.md`). Aggregates you mutate must be loaded with tracking opted in.
- **Validation in the domain vs in the request.** The request pipeline validates shape and length; the factory validates business rules. The reference commands carried raw strings with maximum-length validators rather than length-typed value objects, so the value-object rule is partly unmet there. `[known gap]`
- **Hash the secret, not the object.** Child entities that hold credentials store hashes only; equality by identity (type plus id), not by content.
- **Time-ordered ids leak creation time.** Fine for internal ids; reconsider for public ones.
- **Do not let the database mint aggregate ids.** The aggregate must have an id at construction so events raised in the factory can reference it.

## 5. Invariants to test

- One unit test per factory: valid input trims and succeeds; exactly one event is raised; each invalid input maps to its error code.
- Every aggregate has no public constructor and every factory returns a result (reflection rule or review checklist).
- Id types reject the empty value; two different id types do not compare or convert implicitly.
- Interceptor test: pre-commit handlers see uncommitted state in the same context; post-commit handlers run only after a successful save and never after a failed one; the event list is cleared either way.
- Value-object security tests: homograph input rejected, over-length input rejected before pattern evaluation, reserved TLD and disposable domain rejected, canonical form dedupes dot/plus variants for aliasing providers and leaves other providers' `+tag` addresses distinct.
- Store normalizer test: the identity store's lookup key for `A.B+x@alias-provider` equals the value object's canonical form (one canonicalization path).
- Guarded transitions: `lock()` on a disabled user returns the conflict error.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "A public constructor is simpler, we validate in the service" | The next caller will not. Private constructor, factory, result. |
| "The database should generate the id" | Events raised before insert then reference an id that does not exist yet. |
| "A status string plus a few booleans is flexible" | Contradictory combinations become reachable states. |
| "Publish the event after save, we do not need the outbox" | Crash between commit and publish loses it. Durable effects go through the outbox. |
| "Put the audit port in domain so everyone can reach it" | Application is already referenced everywhere; domain is not a utility bin. |

Red flags: a raw primitive id in a signature; a string typed as email passed unvalidated; an aggregate holding another aggregate's object; post-commit handling of something business-critical; boolean pairs like `isActive` and `isDeleted` that can both be true; an infrastructure type imported into a value object.

## 7. Checklist

- [ ] Constructor private, factory returns a result, one event raised on creation.
- [ ] Value objects validate and cap length before parsing; canonical key used for dedupe, including in the identity store's lookup normalizer.
- [ ] Ids are per-aggregate types, minted by the app, converters generated.
- [ ] Cross-aggregate references are ids; cross-aggregate effects are events.
- [ ] Anything that must happen is in the outbox, not a post-commit handler.
- [ ] Ports are in application with a safe default; domain contains only business words.
- [ ] Known purity exceptions are written down.
