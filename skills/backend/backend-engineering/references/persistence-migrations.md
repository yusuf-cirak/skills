---
metadata:
  file: persistence-migrations.md
  sections:
    - {title: "1. When this applies", start: 17, end: 25}
    - {title: "2. Principles", start: 27, end: 34}
    - {title: "3. Design", start: 36, end: 133}
    - {title: "4. Traps", start: 135, end: 149}
    - {title: "5. Invariants to test", start: 151, end: 160}
    - {title: "6. Rationalizations / Red flags", start: 162, end: 173}
    - {title: "7. Checklist", start: 175, end: 184}
---
# Persistence, Migrations and Pagination

> **Golden path:** Derive names by convention, make writes explicit about tracking, migrate with expand/contract, clamp page size at the boundary, and prefer keyset paging at scale.

## 1. When this applies

- Configuring an ORM or data-access layer for a service or module.
- Writing or deploying a schema migration, especially with rolling deploys.
- Designing list endpoints and pagination.
- Deciding where the transaction boundary and interceptors live.
- A write "succeeds" but the row did not change.

Status legend: `[shipped]` exists in the reference system, `[proposed]` is uncommitted work in progress, `[known gap]` is a verified hole.

## 2. Principles

- **Derive, do not hand-name.** Table and column names come from one convention, so schema, migrations, raw SQL, CDC config and dashboards cannot drift from hand-written names.
- **Reads dominate; they should not pay for change tracking.** Default to no-tracking, and make writes opt in explicitly.
- **The unit of work is the context's single save.** Interceptors (tenant guard, domain-event dispatch, audit) hang off that save. There is no second transaction abstraction.
- **One context, one schema, one history table per module.** Modules migrate independently.
- **Every instance migrates at boot, so a rolling deploy runs old code against the new schema.** Safety comes only from how each migration is written (expand, then contract).
- **Clamp at the boundary, order before paging, count the same set you page.**

## 3. Design

### Conventions in one place [shipped]

```
module_context_options():
    naming_convention = snake_case              # tables from set names, columns from property names
    tracking_default  = NO_TRACKING
    # plus model-level conventions: typed-id converters, null string -> empty string

register_module_context(options):
    options.provider(connection, migrations_history_table = ("__migrations_history", module_schema))
    options.apply(module_context_options())
```

- Hand-written configuration holds only what a convention cannot infer: keys, "never generated" value generation, column types such as `jsonb`, indexes.
- **Every place that builds options must apply the convention**, or the model and the migrations disagree:
  1. the design-time factory used by the migration tooling (without it, the tool silently generates a non-snake migration when run against the module alone);
  2. any test that builds its own options (without it, migrating on a model mismatch fails).
- Anything outside the ORM that names columns (CDC field mappings, raw SQL, dashboards) uses the derived snake_case names. The primary key is `id`.
- Why snake_case on PostgreSQL: unquoted identifiers fold to lower case, so mixed-case names must be double-quoted in every raw query and tool.

### Default no-tracking and the opt-in [shipped]

```
read:   db.events.where(...).select(...)                      # no operator needed
write:  e = db.events.as_tracking().where(id == x).first()    # MUST opt in to track
        e.change(...)
        db.save()                                             # now the UPDATE is emitted
```

`add`, `attach` and `update` are unaffected; the default governs only entities returned by queries. In the reference system the opt-ins are security-critical token-revocation paths (refresh and logout) and the concurrency test.

**Mapping for a Go or Rust reader.** "Tracking" is the ORM's unit-of-work memory: it remembers what it loaded and emits an UPDATE for whatever changed at `save()`. With no-tracking, loaded objects are plain data and nothing is remembered. In a query-builder or hand-written-SQL stack (sqlx, sqlc, diesel, database/sql) there is no such memory: every write is an explicit statement, so the "silent no-op" cannot happen, but neither do the save-time hooks below exist. Keep the rule, translate the mechanism: a write must be an explicit statement that you assert on (rows affected is 1), never an assumption that "load, mutate, save" did something.

### Unit of work and interceptors [shipped]

`save()` is the transaction boundary. Interceptors attached to the context run inside it, in registration order:

- tenant stamp and guard (see `multi-tenancy.md`);
- domain-event dispatch (pre-commit events inside the transaction, post-commit events after it; see `ddd-tactical.md`);
- audit stamping: on Added sets created-by/at, on Modified sets modified-by/at from the current-user port and an injected clock; the actor falls back to `"system"` when there is no user, so background writes are still attributable. The audit **port** (the structured audit-event logger) is a separate thing, see `security-hardening.md`;
- soft delete: a Deleted entry of a soft-deletable entity is rewritten to Modified with `is_deleted = true` and who/when stamped.

Bulk set-based operations bypass the change tracker, so interceptors and domain events do not run; restrict them to maintenance paths.

**Without an ORM:** there is no hook point. Put the same rules in the single function every write goes through (a repository method or a "commit" helper that stamps tenant and audit columns, issues `UPDATE ... SET is_deleted = true` instead of `DELETE`, and writes the outbox row in the same transaction). Make that function the only way to reach the connection (unexported pool), so a bypass needs a visible, reviewable import.

### Soft delete [shipped in one module]

```
interface SoftDeletable: is_deleted, deleted_at, deleted_by
model:    for each SoftDeletable entity: add global filter  NOT entity.is_deleted
save hook: Deleted -> Modified, is_deleted = true, deleted_at = now, deleted_by = actor
```

- Wired in the identity module only. The query filter hides deleted rows from every ordinary query; "include deleted" is a per-query escape hatch.
- **Global filters are all-or-nothing.** The reference extensions each install one unnamed filter per entity, so an entity that is both tenant-owned and soft-deletable would have one filter overwrite the other, and the "include deleted" escape hatch removes **every** filter on that query, including the tenant filter. Result: an admin "show deleted" feature that silently becomes a cross-tenant read. No entity combines both today `[known gap, latent]`. If one ever does, combine the predicates into one filter expression and give "include deleted" its own narrower mechanism than "ignore all filters".
- **Interceptor order matters when combined with the tenant guard.** The guard only checks Added and Modified (see `multi-tenancy.md`). If soft delete runs first and turns the Deleted entry into Modified, the guard sees it and checks the tenant. That closes the Deleted gap for soft-deletable entities only; hard-deletable ones remain unguarded. In the reference system no module registers both interceptors, so this ordering is `[proposed]`, not exercised.
- **Unique indexes and soft delete.** A plain unique index on email or name keeps a deleted row's value reserved forever. Either include `is_deleted` in the unique key or use a partial unique index (`WHERE NOT is_deleted`). Guidance; not verified in the reference system, which keeps plain unique indexes on identity fields.

### Migrate at boot, expand/contract [shipped]

A hosted service runs the migrations per module and marks a readiness tracker. The expected migrator count is registered at configuration time, so the health check cannot report "applied" before every module has registered.

Rule for every breaking change, in three steps:

1. **Expand:** an additive, backward-compatible migration (new column nullable or defaulted, new table). Ships and runs first.
2. **Migrate code:** deploy code that writes the new shape while still reading and writing the old shape.
3. **Contract:** only after every old-code instance is gone, a later migration drops the old column or adds the NOT NULL.

Never rename or drop a column and add its replacement in the same migration: that instant is exactly when an old instance still expects the old shape. Example from the reference system: the relay columns were added as nullable, unused by the CDC path.

- **No cross-instance migration lock [known gap, optional].** Concurrent instances rely on the driver and database. `[proposed]` hardening: take a distributed lock so only one instance migrates; expand/contract is the real safety either way. Do not state in a skill or runbook that a lock exists unless the code takes one.
- **Probes:** a separate **startup** probe reports "migrations applied". Do not put it in the **readiness** probe when an external component (CDC connector) gates on migrations and readiness probes that component: deadlock. The reference system does exactly this split: the migrations check carries the startup tag; readiness (database, cache, broker, the CDC connector URL) does not include it. See `outbox-inbox-messaging.md` and `resilience-lifecycle.md`.
- Each module owns its schema and history table; `architecture-modular-monolith.md` explains why modules must migrate independently.

### Indexes [shipped]

- A partial index on pending outbox rows serves the relay claim query.
- A composite index serves filter plus sort for list endpoints.

### Pagination [shipped: offset only]

```
page_request.normalize():  page = max(page, 1)
                           size = (size < 1) ? 20 : min(size, 200)     # below 1 -> DEFAULT (20), above 200 -> 200
list(query, page_request):
    ordered = query.order_by(stable_key)                       # order BEFORE paging
    total   = ordered.count()                                  # SAME filtered set as the page
    items   = ordered.skip((page - 1) * size).take(size).stream()
```

- Clamp page size at the boundary so a hostile query cannot request an unbounded set. Clamping replaces validation here. An unparseable or missing size takes the default; a size below 1 also takes the default (20), it is **not** raised to 1; only an oversized value is cut to the maximum (200).
- The page request is read from the query string through an ambient accessor, so queries and handlers carry no pagination parameters. Items stream rather than materialize.
- **Count the same shape you page.** Counting a pre-join query while listing a fan-out join makes the badge disagree with the list. Derive total and page keys from a join-light query, then hydrate only the page.
- **Keyset (cursor) pagination was built and reverted.** The ORM could not translate an order or filter that reached into a wrapped typed id inside a DTO projection; only anonymous-type projections translated. Lesson: apply the keyset filter and ordering **before** projecting to the DTO, over the raw key. Off-by-one: with an exclusive lower bound `key > cursor`, seeding the cursor with the minimum key drops the first row; start strictly below it.
- **Response DTO consistency [known gap]:** one command responds with a raw UUID, a query with the typed id. Pick one wire representation per kind of value.

## 4. Traps

- **No-tracking load-modify-save silently no-ops.** Change detection finds nothing, the UPDATE is skipped, and the optimistic-concurrency check and tenant guard never run either. Symptom: success response, unchanged row. It surfaced as a logout and token-rotation security bug.
- **Design-time factory without the convention** generates a migration with mixed-case names; the running app then fails on a model mismatch.
- **Hand-built test options without the convention** fail `migrate` on mismatch.
- **Rename or drop plus replace in one migration** breaks the old instances still serving traffic mid-deploy.
- **Contract before every old instance is gone** is an outage. Verify instance versions, not just "the deploy finished".
- **Readiness includes "migrations applied" while the connector gates on migrations** deadlocks startup.
- **Projecting a wrapped id value in a query** (`e.id.value`) does not translate; project the property itself and filter before the DTO.
- **Counting a different set than you page.**
- **N+1 and fan-out.** Lazy loading hides one query per row; multiple collection includes multiply rows. Eager-load what you touch, project columns instead of whole entities, and filter the driving table first. Keep subqueries composable instead of materializing them into an `IN` list (parameter ceilings on some databases).
- **Wrap mutually dependent reads in one transaction** with an isolation level strong enough to prevent interleaving. Read-committed does not guarantee two counts reflect the same instant.
- **Bulk operations bypass interceptors and domain events.** Maintenance paths only. A bulk delete also skips the soft-delete rewrite: it is a hard delete.
- **"Include deleted" via ignore-all-filters removes the tenant filter too** (see Soft delete). Narrow the escape hatch or compose the filters.
- **Bulk loads:** drop secondary indexes and a random clustered key, load, rebuild once; make each DDL step idempotent.

## 5. Invariants to test

- A test that loads **without** the tracking opt-in, mutates, saves, and asserts the row is unchanged. It documents the footgun so nobody "fixes" it by accident.
- An architecture or boot test that every context applies the conventions (naming and tracking default).
- Migration readiness: the tracker reports not-ready until the expected count of migrators has run.
- Page request clamping: page below 1 becomes 1, size above 200 becomes 200, size below 1 becomes the default 20 (not 1).
- Pagination: total equals the count of the same filtered set; ordering is stable.
- A real-database test for every computed member used inside a query, since untranslatable members fail only at query time.
- A statement-count test for a known endpoint to catch N+1 regressions.
- Expand/contract review gate: a migration that both drops and adds in one step fails review.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "I'll name this column by hand, just once" | The next CDC or raw-SQL consumer quotes the wrong name. |
| "Tracking everywhere is safer" | You pay change detection on every read to protect the rare write. Opt in on writes. |
| "The save succeeded, so the row changed" | Not with untracked entities. Assert on the row. |
| "Rename and backfill in one migration is atomic" | The migration is; the rolling deploy is not. |
| "We'll add pagination when lists get big" | The first hostile request is the big list. Clamp from day one. |
| "Cursor pagination is a drop-in" | Not over wrapped ids inside DTO projections. Filter before projecting. |

Red flags: a column or table name written by hand; a handler that queries, mutates and saves without an explicit tracking opt-in; a migration containing both a drop and an add for the same field; an unbounded list endpoint; a count that runs over a different query than the page; a readiness probe that includes migrations.

## 7. Checklist

- [ ] Naming and tracking default come from one extension used by every context, the design-time factory and every test.
- [ ] Every load-modify-save path opts into tracking, and a documenting test exists.
- [ ] Each module has its own schema and history table.
- [ ] Breaking schema changes follow expand, migrate code, contract, across separate deploys.
- [ ] Startup probe reports migrations; readiness does not depend on them.
- [ ] Page size is clamped at the boundary; ordering precedes paging; total counts the paged set.
- [ ] Hot queries are indexed (partial for pending rows, composite for filter plus sort).
- [ ] Migration locking and keyset pagination are recorded as gaps or lessons, not claimed as shipped.
