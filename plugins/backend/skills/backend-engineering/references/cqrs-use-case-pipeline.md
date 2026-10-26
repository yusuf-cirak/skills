---
metadata:
  file: cqrs-use-case-pipeline.md
  sections:
    - {title: "1. When this applies", start: 17, end: 22}
    - {title: "2. Principles", start: 24, end: 32}
    - {title: "3. Design", start: 34, end: 94}
    - {title: "4. Traps", start: 96, end: 104}
    - {title: "5. Invariants to test", start: 106, end: 113}
    - {title: "6. Rationalizations / Red flags", start: 115, end: 125}
    - {title: "7. Checklist", start: 127, end: 135}
---
# CQRS and the Use-Case Pipeline

> **Golden path:** One request, one handler; cross-cutting checks are pipeline steps opted into by marker; declare the step order in one place and test it.

## 1. When this applies

- Adding a command or query, or changing what runs around every request.
- Adding a cross-cutting step (re-authorization, validation, locking, caching, auditing).
- Writing an endpoint, or deciding what the transport layer is allowed to do.
- Debugging a request that "skips" a check or runs steps in the wrong order.

## 2. Principles

1. **One use case = one request type + one handler.** Group them per use case (vertical slice): the command or query, its validator, its handler and its response live together. Navigation follows the business capability, not the technical layer.
2. **Cross-cutting concerns are pipeline steps, not code in handlers.** Steps wrap the handler in a fixed order declared in exactly one place.
3. **Steps opt in through marker interfaces on the request.** A request that does not implement a marker pays nothing for that step. The pipeline is generic, the opt-in is per request.
4. **Steps short-circuit through the result channel,** returning a failure value, never by throwing. Callers see one outcome shape.
5. **Queries read straight from the store.** They project into the response shape; they do not rebuild aggregates.
6. **The transport layer is thin: bind, send, map.** Policies (idempotency, scope, logging posture) are declared on the route as opt-ins, not hidden in middleware.
7. **Use a maintained mediator; never hand-roll one.** A custom mediator was built in the reference project and then replaced by a library; the pipeline order and lifetimes are subtle enough that owning it is a cost with no return.

## 3. Design

### Use case grouping

```
module Events.ScheduleEvent:
  type Command  { name, startsAt, capacity }          # implements: Lockable? Sensitive?
  type Validator for Command                          # request-shape rules only
  type Handler  (Command) -> Result<Response>:
      e = Event.schedule(...)                         # domain factory returns a result
      if e is failure: return failure
      store.add(e)
      outbox.enqueue(EventScheduledIntegration(e))    # same unit of work
      store.save()                                    # single commit: aggregate + outbox row
      return Success(Response(e.id))
  type Response { id }
```

A query handler returns a projection straight from the store query. [shipped]

### Pipeline and its fixed order

```
declared once (host composition):
  1. sensitive   (only requests marked Sensitive)  re-verify caller + token revocation
  2. validation  (all registered validators, aggregated)      -> Failure(ValidationError) on any breach
  3. lock        (only requests marked Lockable)   try-acquire by request-supplied key -> Failure(conflict 409)
  4. handler
```

Why this order: re-verify identity before spending effort on anything; validate before taking a lock so invalid input never contends for it; lock innermost so the critical section is as short as possible and the lock is released as soon as the handler finishes. Behaviors are constrained by their marker (a generic type constraint), so generated registration applies a step only to matching requests. Each step returns a failure value (sensitive: 401, validation: 400, lock: 409) rather than throwing. [shipped]

Lifetimes. Handlers hold request-scoped resources, so the mediator and its behaviors are registered with request scope. Registering them as singletons creates a captive dependency on the database context. The composition-root rules (who registers what, safe defaults that fail loudly) are in `architecture-modular-monolith.md`.

Without a mediator library (typical in Go or Rust) the same design is an ordered list of middleware functions wrapped around each handler function, selected by the request's declared capabilities (a trait or interface the request type implements). Keep the order in one place and keep each step returning the same result type.

### Thin endpoints

```
POST /events:
  cmd = bind(body)
  result = mediator.send(cmd)
  return result.toApiResult()           # the single mapper, see error-model.md
```

Route-level opt-ins read like documentation of the contract:

```
.requireIdempotency()     # replay stored response for a repeated key (see idempotency-locking-concurrency.md)
.requireScope("events:write")
.requireAuthorization()
.logWithoutBody()         # sensitive bodies never logged
.suppressLogging()        # probes, noisy routes
.allowAnonymous()         # must be explicit; default policy is "authenticated"
```

Versioning and pagination belong to `api-surface.md`.

### Where lock and idempotency meet

Idempotency replays a stored response for sequential retries. It does not serialize two simultaneous requests carrying the same key. The lock marker covers that: the loser gets a conflict, the winner proceeds, and a later sequential retry replays. The two are complementary, not alternatives.

## 4. Traps

- **A validated request whose handler does not return the result type throws at first use.** The validation step has to construct a failure of the handler's response type; it does so with a cached, per-closed-type factory (the one place reflection is used). A handler returning a bare value or a differently-shaped result fails only when validation first rejects something. Add a test that sends an invalid request through every validated use case, or constrain the type system so it cannot happen.
- **Marker interfaces with no users.** The sensitive-request and lock steps and their markers are built and unit-tested, but no module request implements either today. The infrastructure is ready, the usage is not. `[known gap]` Do not claim a use case is "protected by single-flight" until it actually carries the marker.
- **Generator-registered steps and the outermost project.** If the mediator is source-generated, it only sees handlers in the project that runs the generator; keep the registration in the host and the behaviors constrained by marker so the generated code applies them selectively.
- **Order drift.** Adding a step by appending it to a list changes semantics (a new step before validation sees unvalidated input). The order lives in one array. A test asserting the registered sequence is `[proposed]`: the reference system has unit tests for each behavior and a sender test showing a registered behavior runs, but none that pins the order.
- **Hidden policy in middleware.** If the only way to know a route is idempotent is to read a middleware's path list, the contract is invisible. Declare on the route.
- **Response id conventions diverge.** One command response returned a raw id while a query returned the typed id. Pick one. `[known gap]`
- **Dropping a step "just for this request".** Marker interfaces mean opt-in per request, but opting out of validation or re-authorization needs a written reason and a reviewer.

## 5. Invariants to test

- `[proposed]` The registered pipeline sequence equals the declared order (sensitive, validation, lock).
- Validation: an invalid request returns the validation failure with the field-to-messages map; a request with no validators passes through; every validated use case, given invalid input, returns a result rather than throwing.
- Lock step: a second concurrent request with the same key gets a conflict while the first runs; a request without the marker never touches the lock backend.
- Sensitive step: a revoked token is rejected with 401 even though signature and lifetime are valid.
- A sender test proves a registered behavior runs for a matching request.
- `[proposed]` A grep or architecture rule: handlers do not publish directly to a broker; they enqueue to the outbox (`outbox-inbox-messaging.md`). Not an existing test in the reference system.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "I'll check authorization inside the handler, it's one line" | It will be forgotten in the next handler. Marker plus pipeline step. |
| "Throwing from the behavior is simpler" | Callers now need two error paths. Return the failure value. |
| "Our own mediator is 40 lines" | Until lifetimes, ordering and generics bite. Use the maintained one. |
| "Validation can run after the lock" | Invalid input then holds the lock and causes contention. |
| "The endpoint can do the mapping and a bit of logic" | The next endpoint copies it. Bind, send, map only. |

Red flags: a handler injecting a broker client; business rules in an endpoint; a behavior registered singleton; a request type that carries both a lock marker and no key; a new step with no entry in the order test; a handler returning a bare value in a validated use case.

## 7. Checklist

- [ ] One request, one handler, grouped per use case.
- [ ] Validator covers shape and length; the domain factory covers business rules.
- [ ] Handler returns the result type used by the pipeline's short-circuits.
- [ ] Cross-cutting needs expressed as markers, not handler code.
- [ ] Pipeline order declared once (and, ideally, pinned by a test: not present in the reference system).
- [ ] Endpoint is bind/send/map plus route opt-ins.
- [ ] Events that must leave the process are enqueued to the outbox in the same save.
