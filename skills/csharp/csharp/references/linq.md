# C# LINQ

## Contents

- LINQ — common runtime pitfalls
- Related

Load when aggregating, projecting, joining, or correlating collections, or when choosing between LINQ and a loop.

- When aggregating, projecting, flattening, joining, or correlating collections, prefer LINQ over a `foreach` + manual accumulator.
- Prefer `Select`, `SelectMany`, `Where`, `Join`, `GroupBy`, `GroupJoin`, `Zip`, `Aggregate`, `ToDictionary`, `ToLookup` — they make intent explicit and compose.
- Reach for `foreach` only when the body has side effects (I/O, mutation of external state, logging, `await` per item without `await foreach`), or when LINQ would force materialization that hurts performance.
- Keep LINQ pipelines pure; keep captured state read-only inside `Select`/`Where`.
- Pair with `IEnumerable<T>` / `IAsyncEnumerable<T>` (see `performance.md`); materialize with `ToList()` only when a caller needs random access or multiple enumerations.
- **Zero-allocation LINQ (check before writing):** if the project already references **ZLinq** (Cysharp) — check `.csproj`/`Directory.Packages.props` — use it; its struct-based drop-in removes the usual "LINQ allocates, so drop to a loop on hot paths" trade-off, so LINQ stays the default even in measured-hot code. If the project uses a different zero-alloc LINQ approach, match it. If neither is present, plain `System.Linq` is fine for cold paths — but when a change touches a per-request/per-record/per-message LINQ chain (the Hot-path allocation discipline cases below), **proactively suggest adding ZLinq** there rather than quietly dropping to a manual loop; ask before adding the package.

### ZLinq drop-in setup (when ZLinq is the project's choice)

Install ZLinq as a **drop-in** so call sites keep plain LINQ syntax — no `.AsValueEnumerable()` chaining:

```bash
dotnet add package ZLinq
dotnet add package ZLinq.DropInGenerator
```

The source generator emits extension methods that take overload priority over `System.Linq` for the selected target types, so the ZLinq method is picked whenever name and arguments match. Configure it with one assembly attribute:

```csharp
// New project — most aggressive: everything (incl. IEnumerable<T>) routes through ZLinq.
// Generate into the app's default namespace, NOT global (""): with Enumerable included,
// a global drop-in makes normal System.Linq unreachable; a namespaced one lets a file
// opt back into System.Linq by not importing that namespace.
[assembly: ZLinq.ZLinqDropInAttribute("MyApp", ZLinq.DropInGenerateTypes.Everything)]

// Legacy/existing project — use Collection (Array | Span | Memory | List), NOT Everything:
// the Enumerable drop-in returns ValueEnumerable where existing code expects IEnumerable<T>
// (a real problem on net9+), so it breaks existing call sites. Without Enumerable,
// `.AsEnumerable()` stays available as the System.Linq escape hatch.
[assembly: ZLinq.ZLinqDropInAttribute("MyApp", ZLinq.DropInGenerateTypes.Collection)]
```

`DropInGenerateTypes` is a flags enum — `Array`, `Span` (Span/ReadOnlySpan), `Memory` (Memory/ReadOnlyMemory), `List`, `Enumerable` (IEnumerable), combinable (`Array | Span`), with predefined combos `Collection = Array | Span | Memory | List` and `Everything = Collection | Enumerable`. Where the drop-in isn't configured (a quick script, someone else's repo), chain `.AsValueEnumerable()` manually before the operators.

Example — aggregating order totals per customer with line items from a separate source:

```csharp
public static class OrderSummaryAggregator
{
    public static ImmutableList<CustomerOrderSummary> Aggregate(
        IEnumerable<Customer> customers,
        IEnumerable<Order> orders,
        IEnumerable<OrderLine> lines)
        => customers
            .GroupJoin(
                orders,
                customer => customer.Id,
                order => order.CustomerId,
                (customer, customerOrders) => (customer, customerOrders))
            .Select(pair => pair.customerOrders
                .Join(
                    lines,
                    order => order.Id,
                    line => line.OrderId,
                    (order, line) => (order, line))
                .GroupBy(x => x.order.Id)
                .Select(orderGroup => new OrderTotal(
                    OrderId: orderGroup.Key,
                    Total: orderGroup.Sum(x => x.line.Quantity * x.line.UnitPrice)))
                .Pipe(orderTotals => CustomerOrderSummaryFactory.Create(
                    customer: pair.customer,
                    orderTotals: orderTotals.ToImmutableList())))
            .ToImmutableList();
}
```

The imperative shape this replaces:

```csharp
// Imperative accumulation hides the shape of the transformation.
var summaries = new List<CustomerOrderSummary>();
foreach (var customer in customers)
{
    decimal total = 0m;
    foreach (var order in orders)
    {
        if (order.CustomerId != customer.Id) continue;
        foreach (var line in lines)
        {
            if (line.OrderId == order.Id)
                total += line.Quantity * line.UnitPrice;
        }
    }
    summaries.Add(new CustomerOrderSummary(customer.Id, total));
}
```

## LINQ — common runtime pitfalls

These fail at runtime, not compile time, and the bug is in the shape of the data, not the code — the
same LINQ call is correct on a clean sample and crashes (or silently loses rows) in production. Know
these before reaching for `Single`/`ToDictionary`/`Join`/`Zip`:

- **`Single()`/`SingleOrDefault()` throw `InvalidOperationException: Sequence contains more than one
  element`** the moment the source has a duplicate. Use `Single*` only when uniqueness is an actual
  invariant you want enforced (a PK/unique-index lookup — the exception is a real bug signal). Otherwise
  use `First()`/`FirstOrDefault()`, which don't assert cardinality.
- **`ToDictionary(keySelector)` throws `ArgumentException: An item with the same key has already been
  added`** on the first duplicate key — a very common crash once "the key is unique" turns out to be an
  assumption, not a constraint. Pick the right duplicate-handling tool instead of discovering this in
  prod:
  ```csharp
  // Throws on any duplicate OrderId — fine only if OrderId is truly unique in `lines`.
  var byId = lines.ToDictionary(l => l.OrderId);

  // Never throws — built for 1-to-many; indexer returns an empty sequence for a missing key.
  ILookup<Guid, OrderLine> byOrder = lines.ToLookup(l => l.OrderId);

  // Duplicates expected, want a Dictionary<K, List<T>> anyway:
  var grouped = lines.GroupBy(l => l.OrderId).ToDictionary(g => g.Key, g => g.ToList());

  // Duplicates expected, only want one (first-wins):
  var firstWins = lines.GroupBy(l => l.OrderId).ToDictionary(g => g.Key, g => g.First());
  ```
- **An in-memory `Join` fans out (duplicates rows) when the join key isn't unique on one side** — the
  same cartesian-explosion shape as the EF `Include` issue (see `ef-core-data-access.md`),
  just client-side and silent (no exception, just more rows than expected). If the relationship is
  naturally 1-to-many, use `GroupJoin` (or the `join … into g` query-syntax form) to get one row per
  left element with its matches grouped, instead of an `Join` that multiplies.
  **`GroupJoin`'s real payoff is N+1 avoidance, not just correctness**: batch-load the related data for
  *every* item in **one** query (not per-item), then correlate it to each item in memory. Nested
  `GroupJoin` handles a two-level "many items, each with many related rows, grouped by an intermediate
  key" shape without a second round trip per group:
  ```csharp
  // One query for ALL related rows across every requested owner — not one query per owner (that's N+1).
  var relatedRows = await db.RelatedRows
      .Where(r => ownerIds.Contains(r.OwnerId))
      .ToListAsync(ct);

  // Correlate entirely in memory: group once by the outer key, then — inside each group — by the
  // inner key, so every (owner, item) pair gets exactly its own matches, zero extra queries.
  var byOwner = relatedRows.GroupBy(r => r.OwnerId);
  var correlated = owners.GroupJoin(byOwner, o => o.Id, g => g.Key, (owner, ownerGroups) => new
  {
      Owner = owner,
      Matches = ownerGroups.SelectMany(g => g) // empty, not null, when an owner has no matches
  });
  ```
- **`Zip` silently truncates to the shorter sequence** — no exception, just dropped trailing elements
  from the longer one. If equal length is actually an invariant (paired data that must line up 1:1),
  assert it explicitly (`if (a.Count != b.Count) throw …` / `Guard.Against…`) before zipping — don't
  let a length mismatch disappear into quietly-wrong output.
- **Enumerating a deferred source twice re-runs the whole pipeline** — a second `foreach`/`.Any()`/
  `.Count()` over the same un-materialized `IEnumerable<T>`/`IQueryable<T>` re-executes it: a second DB
  round trip for an `IQueryable`, or a different result each time for a non-deterministic source
  (`Random`, `DateTime.Now`-filtered). Decide once per method: still composing a query (stay
  `IQueryable`/`IEnumerable`, see the EF reference on keeping subqueries composable) or about to consume
  it more than once (materialize once with `.ToList()`/`.ToArray()` first) — don't do both in the same
  method.
- **`Min()`/`Max()`/`Average()`/`Aggregate()` (no seed) throw `InvalidOperationException: Sequence
  contains no elements`** on an empty source. Guard with `.Any()` first, use the nullable-returning
  overload where one exists, or seed `Aggregate` with an explicit starting value so an empty source
  returns the seed instead of throwing.
- **`==`/`.Equals()` on two sequences compares references, not contents** — two logically identical
  `List<T>`s (or any two `IEnumerable<T>`) compare unequal. Use `SequenceEqual()` for element-wise
  comparison (and `SetEquals`/order-insensitive comparison explicitly when order shouldn't matter).

## Related

- `ef-core-data-access.md` — EF Core data access — performance & value-object persistence (single source of truth)
- `performance.md` — C# Performance
