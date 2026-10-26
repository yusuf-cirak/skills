# C# Async, Concurrency & Background Work

## Contents

- Concurrency primitives
- Background work & channels (.NET 8+)
- Related

Load when writing async library code, fan-out, locks/gating, streams, channels, or hosted services.

Library/framework code runs under callers we don't control — follow the dotnet/runtime + EF Core rules:

- `ConfigureAwait(false)` on **every** `await` in library/framework code. Drop it only in app-level
  ASP.NET request or UI code where the synchronization context is wanted.
- Return `ValueTask`/`ValueTask<T>` when the method frequently completes synchronously (cache hits,
  fast-path lookups) — avoids a per-call `Task` allocation. Use `Task` when it almost always awaits.
- Thread `CancellationToken` through to every downstream async call; default it as the last public
  parameter (`CancellationToken cancellationToken = default`).
- No `async void` except event handlers — an unobserved exception there crashes the process.

## Concurrency primitives

- **`Parallel.ForEachAsync`** (.NET 6) for throttled async fan-out (`MaxDegreeOfParallelism` +
  `CancellationToken`) — prefer it over a hand-rolled `SemaphoreSlim` loop.
- **`SemaphoreSlim`** for async gating, **`Interlocked`** for lock-free counters, **`Lazy<T>`** for
  thread-safe one-time init. Reach for a `lock` only when none of these fit.
- **`IAsyncEnumerable<T>` streaming** annotates the token with **`[EnumeratorCancellation]`** and yields
  bounded batches rather than materializing the whole set:

```csharp
public async IAsyncEnumerable<IReadOnlyList<Row>> StreamAsync(
    [EnumeratorCancellation] CancellationToken ct = default) { /* yield batches of N */ }
```

## Background work & channels (.NET 8+)

- In-process producer/consumer → **`System.Threading.Channels`** (`Channel.CreateBounded<T>` for
  backpressure), drained by a `BackgroundService`. No external broker for purely internal hand-offs —
  for **distributed/broker reliability** (retry, DLQ, outbox) see `dotnet:hardening` → Background Jobs & Messaging.
- Use **`IHostedLifecycleService`** (.NET 8) when you need ordered `Starting/Started/Stopping/Stopped`
  hooks rather than ad-hoc startup code.

```csharp
public sealed class WorkQueue : BackgroundService
{
    private readonly Channel<WorkItem> _channel = Channel.CreateBounded<WorkItem>(1000);
    public ValueTask EnqueueAsync(WorkItem item, CancellationToken ct) => _channel.Writer.WriteAsync(item, ct);
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        await foreach (var item in _channel.Reader.ReadAllAsync(ct)) await ProcessAsync(item, ct);
    }
}
```

## Related

- `dotnet:hardening` (`../hardening/SKILL.md`) — Production Hardening (FAANG-level)
