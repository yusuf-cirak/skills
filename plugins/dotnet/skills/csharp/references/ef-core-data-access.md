# EF Core data access — performance & value-object persistence (single source of truth)

## Contents

- DbContext defaults — no-tracking, split query
- PostgreSQL naming — snake_case, no hand-written names
- Projectables — one expression, in memory and in SQL
- Migrations on a rolling deploy — expand / contract
- Bulk operations (EF 7+)
- N+1 — the other half of the cartesian-explosion coin
- Query performance
- Query shaping — selective, fan-out-free, composed
- Value-object & strongly-typed-id persistence
- Keyset paging, transactions & bulk backfills
- Related

> EF Core. Version tags inline. Security/hardening rules for EF live in `dotnet:hardening` → EF Core
> Hardening; this ref owns **performance** and **domain-type persistence**.

## DbContext defaults — no-tracking, split query

Set both once on the context so call sites never repeat them and a forgotten operator cannot slow a read:

```csharp
services.AddDbContextPool<AppDbContext>(o => o
    .UseNpgsql(cs, npgsql => npgsql.UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery))
    .UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking));
```

- **Reads need no operator**: no `AsNoTracking()` / `AsSplitQuery()` on queries.
- **Write paths opt in**: load the row you will mutate with `.AsTracking()`.
- **Opt out of split where one join is cheaper**: `.AsSingleQuery()` on a query with a single small collection.
- Keep `AsNoTrackingWithIdentityResolution()` for graph reads that share references.
- **Footgun — no-tracking silently drops writes.** A handler that loads an aggregate by query, mutates it and calls
  `SaveChangesAsync()` MUST load it with `.AsTracking()`; on an untracked entity change detection finds nothing and the
  `UPDATE` is skipped with no error (and an `xmin`/rowversion concurrency check never runs). `Add`, `Attach` and
  `Update` are unaffected — the default only governs entities *returned by queries*.

## PostgreSQL naming — snake_case, no hand-written names

On Npgsql, use the **`EFCore.NamingConventions`** package and let EF derive every table and column name. Never write
`ToTable(...)` / `HasColumnName(...)` per entity.

- **Why snake_case on Postgres:** unquoted identifiers fold to lower case, so PascalCase names EF generates
  (`"UserId"`) must be double-quoted in every raw query, `psql` session, BI tool and CDC/Debezium config. Snake_case
  (`user_id`) never needs quoting.
- Table name comes from the `DbSet` property, columns from the CLR property names, both snake-cased.
  `OnModelCreating` then holds only what a convention cannot infer: keys, `ValueGeneratedNever()`, and Postgres types
  (`HasColumnType("jsonb")`).
- Put the defaults in **one extension** so every module context is a single call:

  ```csharp
  public static DbContextOptionsBuilder UseModuleConventions(this DbContextOptionsBuilder o) =>
      o.UseSnakeCaseNamingConvention().UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking);

  // module registration
  services.AddDbContext<EventsDbContext>(o => o
      .UseNpgsql(cs, npg => npg.MigrationsHistoryTable("__ef_migrations", EventsDbContext.Schema))
      .UseModuleConventions());
  ```

  Model-level conventions (Vogen converters, `string` null→empty) go in a sibling
  `ApplyAppConventions(this ModelConfigurationBuilder, Assembly)` called from `ConfigureConventions`.
- **Every place that builds options must apply the convention**, or the model and the migrations disagree:
  1. the module's `IDesignTimeDbContextFactory<T>` — without it `dotnet ef migrations add` against the module
     project silently generates a non-snake migration;
  2. any test that builds its own `DbContextOptions` — otherwise `MigrateAsync` fails on a model/migration mismatch.
- One schema per module (`HasDefaultSchema`) and the migrations history table in that schema, so modules migrate
  independently.
- Anything outside EF that names columns (Debezium `table.field.*`, raw SQL, dashboards) uses the snake_case names —
  the PK is `id`, not `Id`.

## Projectables — one expression, in memory and in SQL

`EntityFrameworkCore.Projectables` makes a computed domain member usable inside an EF query, so the rule is written
once instead of once as a C# property and again as a duplicated `Where` predicate:

```csharp
// Domain
[Projectable] public bool IsLargeVenue => Capacity >= LargeVenueThreshold;   // expression-bodied only

// DbContext options
options.UseProjectables();

// Query — translated to SQL (WHERE capacity >= 1000), not evaluated client-side
db.Events.Where(e => e.IsLargeVenue).Select(e => new EventDto(e.Id, e.Name, e.IsLargeVenue));
```

- Members must be **expression-bodied and made only of things EF can translate**; a `[Projectable]` that calls an
  untranslatable method fails at query time, so cover each with an integration test against the real provider.
- Call `.UseProjectables()` on every context whose queries use them — missing it makes the member evaluate
  client-side or throw.
- **Packaging:** reference it with `PrivateAssets="analyzers"`, **not** `"all"`. The package ships a runtime library
  the generated LINQ depends on, so `"all"` compiles but every query throws `FileNotFoundException` at runtime
  (same trap as Vogen). Pure Roslyn analyzers with no runtime lib (Meziantou) are the only ones that take `"all"`.
  Where the domain is its own project, reference only `EntityFrameworkCore.Projectables.Abstractions` there.

## Migrations on a rolling deploy — expand / contract

If migrations run at startup on every instance, a rolling deploy briefly runs **old and new code against the new
schema**. Safety comes only from how each migration is written. Break a breaking change into three steps:

1. **Expand** — an additive, backward-compatible migration (new column nullable or defaulted, new table). Ships and runs first.
2. **Migrate code** — deploy code that writes the new shape while still reading/writing the old one.
3. **Contract** — only after every old-code instance is gone, a later migration drops the old column or adds the `NOT NULL`.

Never rename or drop a column and add its replacement in the same migration: that instant is exactly when an
old-code instance still expects the old shape. Take a distributed lock (see `dotnet:hardening` → Background Jobs) so
only one instance migrates at a time.

## Bulk operations (EF 7+)

Mutate sets server-side — no load-modify-save round trip.

```csharp
await ctx.Orders.Where(o => o.IsStale)
    .ExecuteUpdateAsync(s => s
        .SetProperty(o => o.Archived, true)
        .SetProperty(o => o.UpdatedAt, timeProvider.GetUtcNow()), ct);

await ctx.Sessions.Where(s => s.ExpiresAt < now).ExecuteDeleteAsync(ct);
```

**Caveat:** bulk ops bypass the change tracker, so `SaveChanges` interceptors don't run and **domain
events don't fire** — the rule and rationale live in `dotnet:ddd` → Domain-event dispatch. Maintenance/bulk
paths only.

## N+1 — the other half of the cartesian-explosion coin

Split query (the context default, above) fixes too-*eager* loading (multiple collection `Include`s fanning out into a
cartesian product). N+1 is the opposite failure: too-*lazy* loading — one query to fetch a set, then one
extra round trip **per row** to fetch each row's related data. Both come from the same root cause
(navigation-property access without a plan for how it hits the database), and both are silent in the
LINQ — neither throws, neither shows up in review unless you're looking at the generated SQL/query count.

- **Lazy-loading proxies are the classic N+1 trigger — don't reference them by default.** Don't add
  `Microsoft.EntityFrameworkCore.Proxies` / `UseLazyLoadingProxies()` unless a specific scenario needs
  it and the cost is accepted. Without it, touching an unloaded navigation property returns `null`/empty
  instead of silently issuing a query — the bug surfaces at the call site, not in a profiler three weeks
  later.
- **Eager-load with `.Include()`/`.ThenInclude()` for anything you'll touch per row.** The canonical N+1
  shape and its fix:
  ```csharp
  // N+1: one query for orders, then one query PER order inside the loop to fetch its lines.
  var orders = await ctx.Orders.Where(o => o.CustomerId == id).ToListAsync(ct);
  foreach (var order in orders)
      order.Lines = await ctx.OrderLines.Where(l => l.OrderId == order.Id).ToListAsync(ct); // N extra round trips

  // Fixed: one query — the join happens in the database.
  var orders = await ctx.Orders.Where(o => o.CustomerId == id)
      .Include(o => o.Lines)
      .ToListAsync(ct);
  ```
- **Split query is the context default** (see "DbContext defaults"), so multiple sibling collection
  `Include`s on one root no longer fan out. A single small collection `Include` can be cheaper as one
  `JOIN`: opt out per query with `.AsSingleQuery()`.
- **Project instead of `Include` when you only read a few columns of the related data** — see "Project
  columns, not whole entities" below; a nested `Select` into the navigation inside the projection avoids
  loading (and N+1-ing) columns nothing reads.
- **When `.Include()` can't express the shape at all** — no direct navigation property, a conditional or
  non-FK join, pulling fields from an unrelated aggregate — don't fall back to a separate round trip
  (that's N+1 again, just with extra steps). Drop to LINQ **query syntax** (`from x in … join y in … on …
  equals …`, see "Query shaping" below): it stays `IQueryable`, translates to one SQL join, and reads
  better than the equivalent fluent `.Join()`/`.SelectMany()` chain once there are 3+ sides to the join.
- **Catch it before prod, not after**: in local/dev, log the `Microsoft.EntityFrameworkCore.Database.Command`
  category at `Information` and watch for a statement count that scales with the row count — that's the
  N+1 smell. A snapshot/integration test asserting the SQL-statement count for a known endpoint (count
  `DbCommand` executions via an interceptor, or assert on a captured log) catches a regression before it
  ships, the same way `dotnet:hardening`'s header/429-envelope snapshot tests catch a contract regression.

## Query performance

- **`AddDbContextPool<T>`** (EF 2+) — reuse `DbContext` instances; default pool 1024. Big latency/GC
  win under load. Constructor must take only `DbContextOptions` (no per-request injected state).
- **Compiled queries** (EF 5+) — pre-compile hot, repeated LINQ:
  ```csharp
  private static readonly Func<AppDbContext, Guid, CancellationToken, Task<Order?>> s_byId =
      EF.CompileAsyncQuery((AppDbContext c, Guid id, CancellationToken ct) =>
          c.Orders.FirstOrDefault(o => o.Id == id));
  ```
- **Split query** (EF 5+): the context default; avoids cartesian explosion on multiple collection
  `Include`s (one row per child × child blows up the result set). `.AsSingleQuery()` opts out.
- **`AsNoTrackingWithIdentityResolution()`** (EF 5+) — read graphs without tracking but still
  de-duplicating shared references. Default reads are no-tracking at the context level (see "DbContext defaults").
- **Compiled models** (EF 6+) — `dotnet ef dbcontext optimize` for large schemas / fast cold start;
  wire with `optionsBuilder.UseModel(MyModels.Instance)`.

## Query shaping — selective, fan-out-free, composed

How you *write* the LINQ decides the plan. Applies to all EF Core versions; `IN`/parameter limits are
SQL Server. Learned rules, most impactful first:

- **Filter the driving table first ("filter driving tables first").** Lead the query from the
  smallest / most-selective set (ideally an indexed seek) and join outward — don't scan the big table
  and test membership after the join. Prefer
  `from link in Links.Where(l => l.OwnerKey == id) join e in Entities on link.EntityId equals e.Id`
  over `from e in Entities where e.Links.Any(l => l.OwnerKey == id)`. Same result, index seek instead
  of a scan-then-filter.
- **Push predicates into the join, not after it.** `join loc in Loc.Where(l => l.Lang.StartsWith(c))
  on e.Id equals loc.EntityId into g from loc in g.DefaultIfEmpty()` filters the joined side *before*
  the join. A trailing `where` on a joined column joins everything first.
- **Keep subqueries `IQueryable` — don't materialize mid-pipeline.** `.ToList()` then
  `.Contains(theList)` emits a client-side `IN (@p0..@pN)`: an extra round trip **and** on SQL Server
  it breaches the **~2100-parameter ceiling** on big sets. Leave the subquery composable so it becomes
  `IN (SELECT …)` / `EXISTS`. Materialize only at the edge — the page you actually return.
- **`EXISTS` / semi-join instead of a fan-out `LEFT JOIN`.** Joining a one-to-many (or a bridge table
  used only to test membership) multiplies rows and forces `Distinct()` / in-memory `GroupBy`. When you
  only need "a match exists" or "is a member", use `.Any(...)` or `memberIds.Contains(e.Id)` — no
  fan-out, no dedup, no wrong counts.
- **Project columns, not whole entities.** Selecting entities (or an intermediate DTO holding whole
  entities) and projecting in memory pulls every column of every joined table. Project the exact fields
  into the response shape inside the `IQueryable` so SQL selects only those — EF then prunes
  cardinality-preserving joins whose columns you never read.
- **Count the same shape you page.** `totalRecord` and the returned rows must run over the *same*
  filtered set, or the total won't match. Counting a pre-join query while listing a fan-out join (or
  vice versa) makes the badge disagree with the list.
- **Lean base for count + page-keys; hydrate only the page.** Derive the total and the page's key set
  from a join-light query (no display-only joins ⇒ no fan-out, no `Distinct`), then join the heavy
  display tables only for the ≤ pageSize keys you return. Turns 3 full-width scans into 2 cheap ones + 1
  tiny hydrate.
- **Delete no-op work.** `Include(...)` before a projection is silently ignored by EF — remove it (it
  misleads readers into thinking data is fetched). Drop `Distinct()` when the key is already the PK and
  nothing fans out. Cut dead entity projections the caller never reads.

## Value-object & strongly-typed-id persistence

- **Complex types** (EF / .NET 8) — map a value object into the owner's table without a separate
  entity:
  ```csharp
  modelBuilder.Entity<Order>().ComplexProperty(o => o.ShippingAddress);
  ```
- **Value converters** (EF 5+) — persist single-value VOs / strongly-typed IDs as primitives:
  ```csharp
  modelBuilder.Entity<Order>().Property(o => o.Id)
      .HasConversion(id => id.Value, value => OrderIdFactory.Create(value).Value);
  ```
  Vogen-generated IDs (see `dotnet:ddd`) ship an EF converter — register it via
  `HasConversion<OrderId.EfCoreValueConverter>()`. Pair with the JSON converter list in
  `value-object-base.md` so the same VO round-trips over HTTP and the DB.

## Keyset paging, transactions & bulk backfills

- **Exclusive keyset lower-bound off-by-one.** With `WHERE key > @cursor`, seeding `@cursor = MIN(key)` drops
  the minimum row. Start strictly below it (`min.AddTicks(-1)` or a sentinel) so the first exclusive window
  includes the earliest row(s).
- **Wrap mutually-dependent reads in one transaction.** When a decision compares several values that must
  reflect the same instant — e.g. two `COUNT`s expected to be equal — reading them as separate queries lets a
  concurrent write land between them and skew the comparison. Read them inside a single transaction with an
  isolation level strong enough to prevent that interleaving (Serializable, or Snapshot where the store
  supports it); the default read-committed level does not guarantee it even within one transaction. This
  applies to any such batched/consistency-sensitive operation, not one database. (EF Core 3.1 / C# 7.3 note:
  no `await using` — use sync `using (var tx = await db.BeginTransactionAsync(isolation, ct)) { …; await
  tx.CommitAsync(ct); }`.)
- **Bulk-load into a heap, rebuild indexes after.** Before a very large insert, drop the secondary indexes
  and the clustered key (a random/GUID clustered key causes page splits on every insert), stream the rows in,
  then rebuild the key + indexes once at the end. Guard each DDL step so it is idempotent (`DROP … IF EXISTS`,
  create only when missing). Only drop the primary key when the load needs no per-row uniqueness check
  (disjoint ranges / dup-free resume) — otherwise duplicates surface at the final key rebuild.

## Related

- `value-object-base.md` — Value Object base type + converters
- `dotnet:hardening` (`../hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `dotnet:ddd` (`../ddd/SKILL.md`) — .NET Domain-Driven Design & Architecture
