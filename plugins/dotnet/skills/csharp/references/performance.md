# C# Performance

## Contents

- JSON serialization — source generation & AOT (.NET 6+; AOT .NET 8+)
- Related

Load when touching a per-request, per-record, or per-message path; building strings; pooling streams or collections; or configuring JSON source generation / Native AOT.

- Prefer `Span<T>` / `ReadOnlySpan<T>` over `string` / `ReadOnlyMemory<T>` when possible.
- Prefer `IEnumerable<T>` over `List<T>` when callers only enumerate.
- Prefer arrays over `List<T>` for fixed-size collections.
- **Pre-size a `List<T>`/`Dictionary<K,V>` when the final count is known or boundable** (`new List<T>(count)`, `collection.Query(ct).Count()` before materializing, a known page size): an unsized `List<T>` grows by **doubling + copying the whole backing array** on every resize past capacity — for a large collection built in a loop this is the actual allocation-and-copy cost, not the elements themselves. One upfront `capacity` argument skips every intermediate reallocation. `LinkedList<T>` is **not** a fix for this — it trades the array-copy cost for a separate heap node *per element*, which is more total allocation for most workloads, not less; reach for it only when you need O(1) insert/remove at an arbitrary known node and have measured that the per-node overhead is still cheaper than the alternative.
- Use `IAsyncEnumerable<T>` for async streams instead of materialized lists.
- Prefer singleton lifetime over scoped when state allows.
- **`FrozenSet<T>` / `FrozenDictionary<K,V>`** for static, read-mostly lookup sets built once at startup (sensitive-key sets, scope tables, allow-lists) — faster reads than `HashSet`/`Dictionary`.
- **Time-ordered ids**: `Guid.CreateVersion7()` (UUIDv7) for entity/message/correlation ids — index-friendly (monotonic) unlike random v4.

### String operations — ZString

ZString (Cysharp) is the preferred string-building/formatting library: zero-allocation `Concat`/`Format`/`Join` and pooled builders. **If the project already references ZString, use it by default** for any string build/concat/format. **If it doesn't, recommend it and ask before adding the package** (`dotnet add package ZString`); until it's in, fall back to `StringBuilder`/interpolation.

```csharp
using Cysharp.Text; // ZString

var line = ZString.Format("settled {0} in {1}ms", orderId, elapsedMs); // no boxing, no intermediate strings
var csv  = ZString.Join(',', ids);

using var sb = ZString.CreateStringBuilder(); // pooled buffer — always `using`
sb.Append(header);
sb.AppendFormat("{0:D8}", sequence);
var payload = sb.ToString();

using var utf8 = ZString.CreateUtf8StringBuilder(); // writes UTF8 directly — pairs with IBufferWriter<byte>
```

- `ZString.Concat`/`Format`/`Join` over `string.Concat`/`string.Format`/`string.Join`, and over `+`/interpolation on hot paths.
- `ZString.CreateStringBuilder()` over `new StringBuilder()` for loop concatenation — same rule as the hot-path discipline below, minus the builder allocation.
- `CreateUtf8StringBuilder()` when the destination is bytes (network, file, `IBufferWriter<byte>`) — skips the UTF16→UTF8 transcode.

### Pooled streams — `RecyclableMemoryStreamManager`

A `new MemoryStream()` built and thrown away per request/item (serializing a response, encoding an
image, buffering a file) is exactly the per-request allocation the Hot-path rules below target.
**`Microsoft.IO.RecyclableMemoryStreamManager`** (`Microsoft.IO.RecyclableMemoryStream` package,
Microsoft-maintained) is the standard fix — a pooled, chunked `MemoryStream` replacement with the same
API. Register one singleton `RecyclableMemoryStreamManager` per workload (not per call) and call
`.GetStream()` instead of `new MemoryStream()`.

**Size the pool's buffers to the workload's actual payload size, not a generic default.** The options
are a pooling *shape*, not a universal constant — a service handling 1–3 MB images needs different
numbers than one handling 10 KB JSON payloads. Pick `BlockSize` so a typical payload needs only a few
blocks (too small ⇒ a payload spans many blocks, more bookkeeping; too large ⇒ small payloads waste
pooled memory), and size `MaximumBufferSize`/the free-pool ceilings so your *measured* peak concurrent
usage fits without constantly growing/shrinking the pool.

```csharp
// Sized for an image-processing workload where payloads run 1–3 MB:
public static readonly RecyclableMemoryStreamManager ImageStreams = new(
    new RecyclableMemoryStreamManager.Options
    {
        BlockSize = 1024 * 1024,                    // 1 MB blocks — a 1-3 MB image needs only 1-3 of them
        LargeBufferMultiple = 1024 * 1024 * 2,       // once a stream outgrows block-pooling, grow in 2 MB steps
        MaximumBufferSize = 1024 * 1024 * 4,         // ceiling a bit above the largest expected payload
        MaximumSmallPoolFreeBytes = 1024 * 1024 * 8, // sized to expected concurrency, not guessed
        MaximumLargePoolFreeBytes = 1024 * 1024 * 16,
    });

var ms = ImageStreams.GetStream();   // pooled, not `new MemoryStream()`
await image.SaveAsJpegAsync(ms, encoder, cancellationToken: cancellationToken);
ms.Position = 0;                     // GetStream() doesn't reset position for you — do this before reading back
```

A service with multiple payload shapes (small JSON responses *and* multi-MB uploads) is a signal for
**two** differently-sized managers, not one generic one sized for the largest case.

### Hot-path allocation discipline

On per-request / per-record / per-message paths (middleware, log/OTel processors, serializers), allocation is the cost — be deliberate:

- Allocate **nothing** when there's nothing to do (early-return before building a list); build **one pre-sized** collection when you must.
- **Closures are the easiest allocation to miss.** A lambda that captures outer-scope state (a local, `this`) compiles to a heap-allocated display class *plus* a delegate — invisible in the source; a heap-allocation profiler (JetBrains "Heap Allocations" / CLR Heap Allocation Analyzer) is how you actually spot it. On a path invoked thousands of times/sec (message pipelines, middleware, a `ConcurrentDictionary.GetOrAdd` factory) this is a measured cost, not a theoretical one. Mark the lambda `static` (C# 9+) to forbid capture at compile time — the compiler raises **CS8820** on any captured variable, turning an invisible allocation into a build error. If the lambda needs outer state, pass it through the generic `Action<TState>`/`Func<TState,TResult>` state-overload (not `Action<object>` — that boxes a value-type state):

  ```csharp
  // Captures `multiplier` → display-class + delegate allocation every call.
  IEnumerable<int> Doubled(IEnumerable<int> xs) => xs.Select(x => x * multiplier);

  // static + generic state → no closure, no boxing.
  IEnumerable<int> Doubled(IEnumerable<int> xs, int multiplier) => xs.Select(multiplier, static (x, m) => x * m);
  ```

  Known BCL gotcha: `dict.GetOrAdd(key, k => Expensive(k, captured))` allocates the closure on **every call, even cache hits** (the factory is built before the lookup runs) — use the 4-arg overload instead: `dict.GetOrAdd(key, static (k, state) => Expensive(k, state), captured)`. For a chained delegate pipeline (a behavior/middleware chain) where each link would otherwise capture the next, thread the ordered link collection through the context object instead, so each static lambda reads its neighbor from context rather than closing over it.

  **Method groups follow the same rule, with one asset you get for free.** A method-group conversion to a delegate (`xs.Select(SomeMethod)`, `Run(worker.Handle)`) is sugar for exactly the same `new Func<...>(...)` as a lambda — **unless the target is a `static` method**, in which case the compiler caches the delegate in a static field and reuses it, so converting the same static method group inside a loop costs nothing even without hoisting (measured: 1M iterations, `xs => f(x)` with `f` rebound to a static method-group every iteration → **0 bytes** allocated). An **instance** method group (`worker.InstanceMethod`) captures the target instance like a closure and is **not** cached — the same loop with an instance method group measured **64 bytes/iteration** (one delegate per conversion). If the target is an instance method and the conversion happens inside a hot loop, convert it **once** outside the loop into a local and reuse that — measured back down to a one-time 64 bytes total, regardless of iteration count.
- If the project references a zero-alloc LINQ library (ZLinq or equivalent — see the `linq.md`), reach for it to keep LINQ allocation-free here. Otherwise drop to an indexer loop for the measured-hot bit — plain `System.Linq` iterator + delegate objects ARE real allocations on these paths.
- Read a **known key set directly** (e.g. `Activity.GetBaggageItem(key)`) instead of enumerating a collection whose getter allocates an iterator (`Activity.Baggage`).
- **Cache** reflection results, compiled delegates, and converted strings; use `ReferenceEquals` fast-paths when an unchanged value is cached as the same instance.
- **Microsoft-style primitives** for these paths: `ArrayPool<T>.Shared.Rent(n)` for transient buffers, returned in `finally`; `stackalloc` for small buffers under a ~256-byte ceiling with a heap fallback (`Span<char> b = len <= 256 ? stackalloc char[len] : new char[len];`); `ZString.CreateStringBuilder()` — or `StringBuilder` when ZString isn't referenced (see String operations above) — when concatenating in a loop (never `+=` a string per iteration); `[MethodImpl(MethodImplOptions.AggressiveInlining)]` only on a proven-hot tiny method, with a one-line comment saying why.
- **Pooled collections** when a collection is built and discarded every request/iteration: `Collections.Pooled` (`PooledList<T>`/`PooledDictionary<K,V>`) rents its backing array from `ArrayPool<T>` and returns it on `Dispose()` — always `using`. Reserve for measured hot spots; plain `List<T>` everywhere else.
- **`params ReadOnlySpan<T>`** (C# 13) on hot variadic APIs — zero per-call array allocation vs `params T[]`.
- **Provider query translators are the canonical LINQ-violation site** — the no-LINQ/no-closures rule above applies hardest there.
- **`readonly struct` escape hatch**: a value object **proven** (benchmark in hand) to allocate on a hot per-row path may become a `readonly struct` instead of a `record` — still immutable, still factory-constructed, kept out of the domain layer. Default stays `record`.
- Keep these tricks **out of cold paths** — readability wins everywhere that isn't measured-hot.

## JSON serialization — source generation & AOT (.NET 6+; AOT .NET 8+)

- Declare a **`JsonSerializerContext`** for serialized types so there is no startup reflection and the
  code is trimming / Native-AOT safe.

```csharp
[JsonSerializable(typeof(ActivityResponse))]
[JsonSerializable(typeof(IReadOnlyList<ActivityResponse>))]
public sealed partial class AppJsonContext : JsonSerializerContext;
```

- **Wiring is owned by `dotnet:validation`** (§4 Global `JsonSerializerOptions` hardening) — feed the context
  to the hardened options' resolver chain there; do **not** configure `ConfigureHttpJsonOptions` here.
- For a Native-AOT service set `<PublishAot>true</PublishAot>`; prefer Minimal API + `TypedResults` and
  avoid reflection-based serializers/mappers.

## Related

- `linq.md` — C# LINQ
- `dotnet:validation` (`../validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
