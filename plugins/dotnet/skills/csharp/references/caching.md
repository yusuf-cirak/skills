# Application caching — hybrid L1/L2 (shared reference)

## Contents

- Library pick
- Rules
- Sketch
- Related

Linked from `dotnet:hardening` (Application Caching) and `dotnet:csharp` (keyed DI cache stores). Owns *how* an
in-process cache layer is built. Don't hand-roll a cache, and don't run a bare `IMemoryCache` or
`IDistributedCache` directly — neither gives you stampede protection, fail-safe, or cross-node
invalidation, and you'll re-implement all three badly.

## Library pick

**Check the project first.** If a hybrid-cache library is already referenced, keep using it — these
rules (stampede protection, fail-safe, backplane invalidation, jitter) are the requirement, not the
specific package.

For a new setup, two good options:

- **`HybridCache`** (.NET 9+, `Microsoft.Extensions.Caching.Hybrid`) — in-box, no extra package. Covers
  L1+L2 and stampede protection out of the box; fewer knobs (no built-in fail-safe/soft-timeout). Prefer
  it when its feature set is enough — it's one dependency fewer.
- **FusionCache** (`ZiggyCreatures.FusionCache`) — richer: fail-safe stale-serving, factory soft-timeouts,
  a backplane. Recommend it (and confirm before adding the package) when the project needs those extras.

## Rules

- **L1 + L2 + backplane.** In-memory L1 for hot reads; Redis L2 shared across instances; a **backplane**
  (Redis pub/sub) so a write on one node evicts/updates that key's L1 on **every** node — otherwise nodes
  serve stale L1 entries until expiry.
- **L2 serializer:** MessagePack (`FusionCacheNeueccMessagePackSerializer`) over JSON for L2 payloads —
  smaller and faster on the hot path.
- **Stampede protection** is the main reason to use this: concurrent misses for the same key collapse to a
  **single** factory call; the rest await it. Never let N requests all rebuild the same entry.
- **Fail-safe:** on a factory failure (the backing call throws/times out) serve the **stale** value past
  its logical expiry instead of propagating the error — availability over freshness for cacheable reads.
- **Factory soft-timeout:** bound how long a read waits on the backing call; on soft-timeout return stale
  (fail-safe) and let the refresh complete in the background, so one slow dependency can't stall callers.
- **Jitter** expiry (a few % / a few seconds) so keys written together don't all expire on the same tick
  and stampede the backing store at once.
- **Never cache** authenticated/per-user responses in a shared L2 under a non-user-scoped key, secrets, or
  anything the `dotnet:hardening` redaction policy forbids logging. Scope the key by tenant/user where the value
  is principal-specific.

## Sketch

```csharp
services.AddFusionCache()
    .WithDefaultEntryOptions(o =>
    {
        o.Duration = TimeSpan.FromMinutes(5);
        o.JitterMaxDuration = TimeSpan.FromSeconds(10);
        o.IsFailSafeEnabled = true;                          // serve stale on factory failure
        o.FailSafeMaxDuration = TimeSpan.FromHours(1);
        o.FactorySoftTimeout = TimeSpan.FromMilliseconds(100);
    })
    .WithSerializer(new FusionCacheNeueccMessagePackSerializer())
    .WithDistributedCache(sp => sp.GetRequiredService<IDistributedCache>()) // Redis L2
    .WithBackplane(new RedisBackplane(new() { Configuration = redisConnString }));

var product = await cache.GetOrSetAsync(
    $"product:{id}", _ => repo.LoadAsync(id, ct), token: ct);  // misses collapse to one factory call
```

## Related

- `dotnet:hardening` (`../hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `dotnet:csharp` (`../csharp/SKILL.md`) — C# House Style
