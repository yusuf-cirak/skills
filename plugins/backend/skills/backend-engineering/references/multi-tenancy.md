---
metadata:
  file: multi-tenancy.md
  sections:
    - {title: "1. When this applies", start: 17, end: 24}
    - {title: "2. Principles", start: 26, end: 33}
    - {title: "3. Design", start: 35, end: 95}
    - {title: "4. Traps", start: 97, end: 111}
    - {title: "5. Invariants to test", start: 113, end: 122}
    - {title: "6. Rationalizations / Red flags", start: 124, end: 135}
    - {title: "7. Checklist", start: 137, end: 147}
---
# Multi-Tenancy (Row-Based)

> **Golden path:** Apply the tenant predicate automatically on reads, enforce it fail-closed on every write path, resolve the tenant from a trusted source, and keep the bypass explicit and greppable.

## 1. When this applies

- One database serves many customers and each must see only their own rows.
- You are adding a new tenant-owned entity or a new module to a tenant-aware system.
- You are resolving "who is the tenant" for a request, a job or a consumer.
- You are reviewing a query, raw statement, bulk operation or admin path that might cross tenants.

Status legend: `[shipped]` exists in the reference system, `[proposed]` is uncommitted work in progress, `[known gap]` is a verified hole.

## 2. Principles

- **Isolation must be automatic on read and fail-closed on write.** A developer cannot forget it, because it is applied by the data layer, not by call sites.
- **Opt in with a marker.** An entity is tenant-scoped because it declares itself tenant-owned; the filter and the guard are generated from that marker.
- **The tenant is read at query time, not at construction time.** The filter re-reads the ambient tenant for every query, so pooled or reused contexts never leak a stale tenant.
- **The escape hatch is explicit and greppable**, reserved for audited admin or system paths.
- **The data layer is the only barrier unless you add a second one.** Without database-level row security, one bypass is a breach.
- **The tenant comes from a trusted source.** A claim in a verified token; a client-supplied header only from trusted callers.

## 3. Design

### Model [shipped]

Shared database, a `tenant_id` column on each tenant-owned table.

```
interface TenantOwned:
    tenant_id
    set_tenant_id(id)            # explicit, non-public: domain code cannot call it by accident

context:
    current_tenant_id = ambient_tenant.get_or_empty()       # re-read on EVERY query
    for each entity implementing TenantOwned:
        add global filter:  entity.tenant_id == context.current_tenant_id
```

- The filter captures the **context object**, not the tenant value, and reads its property when the query is built.
- A context implements a small "tenant-scoped context" interface exposing the current tenant, and registers the filters for all marked entities in one call.
- A migration adds `tenant_id` to the table and, usually, to the index that serves the common filter.

**Without an ORM (query builder, hand-written SQL).** There is no global filter or save hook, so isolation has to be structural instead:

- Reach the database only through a data-access layer whose query helpers **require a tenant argument and always append `WHERE tenant_id = $tenant`**. Expose no function that runs arbitrary SQL against tenant tables outside an allow-listed admin module.
- Put the write guard in the single commit path: every insert stamps the ambient tenant, every update and delete includes `AND tenant_id = $tenant` in its predicate and asserts rows-affected, and a missing tenant is an error, not a default.
- The compile-time or lint check that replaces the "marker interface" is a distinct type for tenant-scoped connections or transactions (`TenantTx`) that is the only type the query helpers accept.
- Database row-level security is the strongest substitute here, because the hook you lack in the ORM is enforced by the database itself (see Defense in depth).

### Write guard [shipped]

A save interceptor runs inside the unit of work:

```
for entry in tracked entities of type TenantOwned:
    if entry.state not in (ADDED, MODIFIED): continue
    if no ambient tenant: throw "cannot persist tenant-owned entity without an ambient tenant"   # fail closed
    if entry.state == ADDED and entry.tenant_id is empty: entry.set_tenant_id(current)            # stamp
    elif entry.tenant_id != current: throw "cross-tenant write blocked"
```

Guards throw rather than return a result: these are bugs, not expected outcomes (see `error-model.md`).

Interceptors run in registration order. If the entity is also soft-deletable, register the soft-delete rewrite (Deleted to Modified) **before** the tenant guard so the guard sees the change; see "Soft delete" in `persistence-migrations.md`. The reference system does not combine them on one entity yet, so this ordering is `[proposed]`.

### Resolving the ambient tenant [shipped]

Resolver chain, first match wins: **verified token claim `tenant_id`**, then **`X-Tenant-Id` header** (intended for trusted service-to-service callers). A middleware runs **after authentication and before authorization**, pushes the tenant into the scoped ambient tenant context, and writes `tenant_id` into the trace baggage so every log line and any outbox row written during the request carries it.

Jobs, consumers and startup tasks have no request. The ambient tenant exposes a scope override (`begin_scope(tenant_id)`, stored in async-local state) so background work runs as a named tenant and restores the previous value on exit.

### Tenant across asynchronous hops [proposed]

The request tenant reaches the outbox only through trace baggage, and the consumer side has no request. A consumer that writes tenant-owned rows must open an explicit tenant scope from a tenant id carried on the message (a header or payload field), validated against the tenant allowed for that topic. Without it the write guard refuses the write (fail closed), which is the correct failure but a surprising one. The reference system has no tenant-aware consumer yet, so treat this as a design obligation for the first one.

### Reference-module pattern [shipped]

The first tenant-aware module is the template: marker on the entity, tenant-scoped context, filters applied in model creation, the interceptor registered and added to the context's interceptors, a migration adding the column, and an integration test.

### Defense in depth [proposed]

Database-level row security (RLS) is explicitly deferred in the reference system (decision record: app-level filter only). Treat it as the planned second barrier, not as a current guarantee.

## 4. Traps

- **Manual filter forgotten (the motivating incident).** A previous project required a manual `apply_tenant_filter()` on every query; one forgotten call leaked data across tenants. The automatic global filter is the fix. Any design where isolation depends on a call someone must remember will fail.
- **Client-controlled header is the only working resolver [known gap].** The tenant claim on login is not implemented yet, so today a caller can choose any tenant by sending the header. Before production, restrict the header resolver to trusted or internal callers, or ship the token claim first. Also note a demo route marked anonymous on a tenant-scoped resource is a convenience, not a pattern.
- **Filter bypass.** The "ignore filters" operator removes isolation entirely. Raw SQL bypasses everything. Reserve both for audited admin or system code.
- **Filters are all-or-nothing, so a second feature built on them can breach tenancy.** The "ignore filters" operator removes every filter on the query. A soft-delete "include deleted" admin view implemented that way also drops the tenant filter and becomes a cross-tenant read. Combine predicates into one filter and give each need its own narrow escape hatch (`persistence-migrations.md`, "Soft delete").
- **Bulk update and bulk delete skip save interceptors**, so the write guard does not run. The query filter still applies to them, which is the only protection; do not rely on the guard for set-based operations.
- **The guard covers Added and Modified only [known gap, verified in code].** A Deleted entry is not tenant-checked, so a stub entity attached and removed by id could delete a row across tenants. Extend the guard to the Deleted state, or never delete by attached stub.
- **No-tracking silently skips the guard.** Untracked entities are invisible to the change tracker; a load-modify-save without opting into tracking changes nothing and the guard never sees it (see `persistence-migrations.md`).
- **Empty tenant id.** With no ambient tenant the current id is the empty value and reads return nothing (fail closed on reads), but only as long as no row was ever stored with an empty tenant id. The guard that refuses tenant-less writes protects that assumption; keep it.
- **Tenant id type.** The tenant id is a plain UUID, not a typed id, because generating the ORM converter requires an ORM dependency the shared domain layer must not have. Accept the weaker typing knowingly; do not let it become a reason to skip the filter.
- **Rate limiting and caching must include the tenant** where responses or buckets differ by tenant; otherwise one tenant's traffic or data bleeds into another's keys.
- **Tests that share a rate-limit budget** (anonymous burst limit per IP) need their state reset between methods, or they fail with spurious 429s unrelated to tenancy.
- **Token blacklist, idempotency keys and cache keys** that omit the tenant can collide across tenants.
- **The idempotency key omits the tenant [known gap, verified in code].** The stored-response key is `{caller}:{method}:{path}:{client key}` where the caller is the authenticated subject or, for anonymous requests, the source IP. The tenant is not part of it. The events route group is anonymous and the tenant arrives in a client-chosen header, so two tenants calling from the same IP (shared NAT, or every client behind a proxy whose forwarded headers are not trusted) with the same path and the same client key would be handed each other's stored response. It needs the same client-chosen key, so it is unlikely, not impossible. Fix: include the resolved tenant id in the key (`idempotency-locking-concurrency.md`).

## 5. Invariants to test

- Unit: insert stamps the ambient tenant; a cross-tenant write throws; a tenant-less write is refused; a modified entity under another tenant is blocked.
- Integration (real database): tenant B cannot list or get tenant A's resource; a tenant-less create is refused.
- A test that the filter re-reads the tenant per query (change the ambient tenant between two queries on the same context).
- `[proposed]` a test that deleting an entity of another tenant by stub is blocked, once the guard covers Deleted.
- `[proposed]` Static rule (grep or architecture test): the "ignore filters" operator and raw SQL appear only in an allow-listed admin or system namespace. A new occurrence anywhere else fails the build. The reference system has only five dependency-direction architecture tests; this rule does not exist there yet.
- A test that every entity implementing the marker is covered by a filter (no marked entity without one).
- `[proposed]` A test that the idempotency key differs across tenants (same caller IP, path and client key, two tenants, two stored responses), once the tenant is part of the key.
- Resolver tests: claim wins over header; header ignored for untrusted callers once restricted.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "We'll remember to filter by tenant" | You will not, once. That is the incident. |
| "The header is fine for now" | Any caller can pick any tenant. Gate it before production. |
| "Admin tooling needs to see everything" | Then use an explicit, audited, allow-listed path, not an inline bypass. |
| "The filter protects bulk operations too, so no guard needed" | The filter protects reads and bulk predicates; it does not stamp inserts or stop forged modified rows. |
| "RLS is overkill" | Fine, but then the app filter is the only barrier and every bypass is a breach. |
| "The guard covers all writes" | Not deletes of attached stubs. |

Red flags in a diff: the ignore-filters operator; raw SQL touching a tenant table; a tenant id taken from a route, query string or body; a new entity with `tenant_id` but no marker; a query mutated through the tracker without tracking; a cache or idempotency key without the tenant; a tenant resolver that trusts a header from the public internet.

## 7. Checklist

- [ ] New tenant-owned entities implement the marker; the context registers filters for all marked entities.
- [ ] The interceptor is registered and attached to the context; migration adds `tenant_id`.
- [ ] Tenant is resolved from a verified claim first; the header is restricted to trusted callers.
- [ ] Middleware sits after authentication and before authorization; tenant id is in the trace baggage.
- [ ] Jobs and consumers run inside an explicit tenant scope.
- [ ] No filter bypass or raw SQL outside the allow-listed admin path.
- [ ] Delete and bulk paths are covered (guard extended or deletes avoid stubs).
- [ ] Tenant is part of every per-caller key (idempotency, cache, rate-limit bucket where responses differ by tenant).
- [ ] Unit and integration isolation tests exist; known gaps (header trust, Deleted guard, tenant-less idempotency key, no RLS) are recorded as gaps.
