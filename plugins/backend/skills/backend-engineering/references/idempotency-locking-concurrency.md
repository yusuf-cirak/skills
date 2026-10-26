---
metadata:
  file: idempotency-locking-concurrency.md
  sections:
    - {title: "1. When this applies", start: 17, end: 26}
    - {title: "2. Principles", start: 28, end: 35}
    - {title: "3. Design", start: 37, end: 95}
    - {title: "4. Traps", start: 97, end: 109}
    - {title: "5. Invariants to test", start: 111, end: 122}
    - {title: "6. Rationalizations / Red flags", start: 124, end: 135}
    - {title: "7. Checklist", start: 137, end: 146}
---
# Idempotency, Locking and Concurrency

> **Golden path:** Scope idempotency keys by caller and tenant, claim them atomically, use a renewing non-blocking lock only for genuinely-once work, and detect lost updates with a database-maintained version.

## 1. When this applies

- A client may retry an unsafe request (POST, PUT, PATCH, DELETE) and the effect must not happen twice.
- Work must run at most once at a time across instances (a long operation, a once-only job).
- Two writers may update the same row and the loser must be detected, not silently overwritten.
- You are deciding how long to keep idempotency records.

This file extends the installed `api-and-interface-design` skill. That skill owns the **contract** of an idempotency key (derive from intent, atomic claim, payload guard, in-flight strategy, three outcomes, retention). This file covers **where to place it, what the reference system implements, and its concrete limits**.

Status legend: `[shipped]` exists in the reference system, `[proposed]` is uncommitted work in progress, `[known gap]` is a verified hole.

## 2. Principles

- **A retry of an unsafe request replays the first stored response; it never re-runs the handler.** Keys are scoped to the caller, so one caller cannot read another's response.
- **Idempotency is opt-in per endpoint, declared on the route.** Hidden global middleware makes safe and unsafe endpoints indistinguishable and caches things nobody intended.
- **Idempotency covers sequential retries; a lock covers concurrent duplicates.** They are different tools. Use both where both failure modes exist.
- **A lock is a lease, not a flag.** It must renew while held, release only by its owner, and fail loudly when no lock backend is configured.
- **Detect lost updates with a version the database maintains**, not a hand-bumped column.
- **Every call has three outcomes: success, failure, unknown.** A timeout says nothing about whether the effect applied.

## 3. Design

### HTTP idempotency filter [shipped]

```
route.post("/orders", handler).require_idempotency()      # opt-in on the route

filter(request, next):
    if method not in (POST, PUT, PATCH, DELETE): return next()
    key = request.header("Idempotency-Key")
    if missing or length(key) > 200: return 400            # reference limit: 200 characters
    if cache is unavailable: log warning; return next()    # degrade, do not fail
    cache_key = "idempotency:{caller}:{method}:{path}:{key}"
    if stored = cache.get(cache_key): return replay(stored) + header "Idempotency-Replayed: true"
    response = next()
    if response.status is 2xx and size(response) <= 1 MB:
        cache.set(cache_key, encode(status, content_type, body), ttl = 24h)
    return response
```

- **The caller part of the key is the authenticated subject, or the server-observed IP for anonymous callers.** An unscoped key let one user replay another user's stored response (a cross-user disclosure, fixed). Method and path are part of the key so the same string used on a different endpoint never collides.
- **Only successful (2xx) responses within a size cap are stored.** Errors are never cached, so they stay retryable.
- **Store a length-prefixed binary blob** (`[status][content_type][body]`), not base64 inside JSON. About one third smaller and no double encoding.
- **Execute the handler's result into a buffer, stream it to the client, and store the buffered copy.**
- **Replay is tagged** with `Idempotency-Replayed: true` so clients and tests can tell a replay from a first run.
- **No cache backend registered: warn and process without idempotency.** This degrades protection rather than failing the request; it is a deliberate fail-open and belongs on the named fail-open list in `resilience-lifecycle.md`.
- **Where records live.** In a plain shared distributed store reachable by every instance, not in a per-node memory layer: a per-node copy would replay on one instance and re-run on the next. In the reference system it uses the shared Redis through the distributed-cache abstraction directly, **bypassing** the hybrid L1/L2 cache layer, and has its own TTL, size cap and scoping rules. See `caching.md` for what does belong in the hybrid cache.

### Limits of the reference implementation

- **The tenant is not in the key [known gap, verified in code].** The key is `idempotency:{caller}:{method}:{path}:{client key}` with `caller` = authenticated subject, else the source IP, else `"anonymous"`. A tenant-scoped, anonymous route (the events group) resolves its tenant from a client-supplied header, so two tenants behind one IP could be replayed each other's stored response if they send the same path and client key. Add the resolved tenant id to the key (`multi-tenancy.md`).
- **IP scope is only as trustworthy as the proxy setup.** For anonymous callers the scope is the server-observed remote address. If forwarded headers are not configured with the known proxies, every client sits behind the load balancer's address and shares one scope; if they are trusted blindly, a client can pick its own scope. See `security-hardening.md`.
- **Sequential retries only [known gap].** Two truly concurrent requests with the same key both execute. The reference system closes this with a lock behavior on specific requests (below), not in the filter.
- **The body is not hashed [known gap].** Same key with a different body replays the old response instead of failing. `[proposed]` upgrade: store a request hash with the record and return 422 on mismatch.
- **No atomic reservation [known gap].** `[proposed]` upgrade: insert `{key, state = in_progress, request_hash}` under a unique constraint first, run the handler, then update to `succeeded` with the response; a concurrent duplicate gets 409, or a 202 plus status URL for long operations. This also gives the "unknown outcome" record: the in-progress row survives a crash and tells a later reconciler that something must be resolved.
- **Retention.** 24 hours in the reference system. Set retention from the longest retry chain, not from storage cost: it must outlive every path that can re-deliver the intent, including a dead-letter queue replayed days later and any provider dispute window. A 24-hour key behind a 7-day replay path is a duplicate waiting to happen.

### Distributed lock [shipped, library swap is WIP]

```
lock = lock_backend.try_acquire(key, wait = 0)        # non-blocking
if lock is null: return conflict (409)
try: run critical section
finally: lock.release()                               # owner-only; disposal releases immediately
```

- **Try-acquire, never block.** Contention returns 409 to the loser immediately.
- **The lease auto-renews in the background while held.** Default expiry 30 seconds, renewed for as long as the holder is alive. Release is by the owner only (compare-and-delete semantics).
- **Fail loudly when no backend is configured.** The default registration is an implementation that throws if a lock-requiring request runs, rather than one that silently runs unlocked.
- **Single-flight as a pipeline step.** A request type implementing a "lock request" marker supplies a lock key; a pipeline behavior acquires it before the handler and returns a conflict result on contention. Order in the pipeline: authentication re-check, then validation, then lock, so invalid requests never take a lock (`cqrs-use-case-pipeline.md`). Lock keys are per-module concerns like every other registration: see `architecture-modular-monolith.md` for why module-scoped registrations must be keyed rather than shared.
- **Lease-renewal gap lesson.** The first, hand-rolled lock used set-if-absent with expiry plus compare-and-delete release, with no renewal. A critical section longer than the expiry was evicted mid-flight and a second holder entered. The replacement delegates to a library that renews the lease. `[proposed]`: that replacement is uncommitted work in the reference system; describe it as the intended design, not shipped behavior.
- **Infrastructure present, unused:** no module request implements the lock marker or the sensitive-request marker yet. The seam exists; do not claim usage.

### Optimistic concurrency [shipped]

Map a version token onto a column the database already maintains (a system row-version such as PostgreSQL `xmin`). It is never emitted in migrations. Without an ORM the same thing is one statement you write yourself: read the version with the row, then `UPDATE ... WHERE id = $id AND xmin = $version` and treat zero rows affected as a conflict. An update becomes `UPDATE ... WHERE id = @id AND version = @original`; zero rows affected raises a concurrency exception.

- **It only works on tracked entities.** See `persistence-migrations.md`: with no-tracking reads, a load-modify-save without opting into tracking skips the update and the check never runs.
- Documentation drift: keep the extension's name and its doc comment in sync; a comment naming a method that does not exist misleads readers.

## 4. Traps

- **Unscoped idempotency key** discloses one caller's response to another. Scope by authenticated subject (or IP for anonymous), and by tenant in a multi-tenant system `[known gap in the reference]`.
- **Key regenerated per attempt** (random id, timestamp, hash of mutable data) turns every retry into a new operation. The key comes from the client or the initiating event, never from the retrying layer.
- **Check-then-insert** (`exists` then `insert`) is a race. The unique constraint chooses the winner.
- **Same key, different body, silently replays** the first response `[known gap]`. Hash the payload.
- **Caching errors** makes a transient failure permanent for 24 hours. Cache only 2xx.
- **Cache backend down means no idempotency**, not an outage. Decide that consciously, log it, expose a metric.
- **Lock without renewal** is a time bomb on long operations. **Lock with blocking wait** stacks threads. **Lock released by a non-owner** frees someone else's critical section.
- **Silent unlocked execution** when the backend is missing hides the real defect. Fail loudly.
- **A stalled attempt of unknown fate is the worst time to let a duplicate through.** Never admit the second caller because the first "seems stuck".
- **Optimistic concurrency on an untracked entity** does nothing. **Bulk updates** (set-based) bypass versions and interceptors.
- **Retention shorter than the longest re-delivery path** produces duplicates days later, exactly when nobody is watching.

## 5. Invariants to test

- Repeat request with the same key: handler not re-run, same status, replay header present (unit test at the filter).
- End to end: replaying a create request through the real endpoint returns the same resource and creates one row.
- A different caller using the same key does not receive the first caller's response.
- `[proposed]` A different **tenant** from the same IP using the same path and key does not receive the first tenant's response (does not hold today).
- Error responses are not cached; a retry after a 5xx runs the handler again.
- With the cache unregistered, the request still succeeds and a warning is logged.
- `[proposed]` once body hashing exists: same key with a different body returns 422.
- Lock: a held lock survives three times its initial expiry; disposal releases immediately; a second `try_acquire` returns null while held; a lock-requiring request with no backend fails loudly.
- Lock behavior: contention returns 409 and the handler does not run.
- Optimistic concurrency: two contexts load the same row, the first commit wins, the second throws a concurrency exception (real database).

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "Accepting the header is enough" | The header is the contract; honouring it is the implementation. A key accepted but not honoured tells the client retrying is safe when it is not. |
| "Duplicates are rare" | They correlate with degraded dependencies, exactly when retries spike. |
| "The key can be a UUID we generate server-side" | Then every retry is a new key. |
| "A global middleware is simpler" | It silently caches endpoints that were never meant to be replayed. |
| "The lock TTL is long enough" | Until the day the operation is longer. Renew the lease. |
| "No lock backend in dev, just skip" | Then the dev environment hides the production race. Fail loudly. |

Red flags: `exists` followed by `insert`; a key built from a timestamp or random value; a stored response keyed without the caller; a lock with no renewal; a retention window shorter than the retry path; a version column bumped by hand.

## 7. Checklist

- [ ] Idempotency is declared per route and scoped by caller (and tenant), method and path; key length is bounded.
- [ ] Only 2xx responses under the size cap are stored; errors are never cached.
- [ ] Missing cache backend degrades with a warning and a metric, and is on the fail-open list.
- [ ] Concurrent duplicates are handled (lock or atomic reservation), not assumed away.
- [ ] Retention is derived from the longest retry or replay path.
- [ ] Locks are non-blocking, auto-renewing, owner-released, and fail loudly without a backend.
- [ ] Optimistic concurrency uses a database-maintained version on tracked entities.
- [ ] `[known gap]` items (body hash, atomic reservation) are recorded, not implied.
