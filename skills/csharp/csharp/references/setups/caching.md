# Setup: hybrid cache library and registration

Load when adding a cache to a project that has none, or when picking the library. The rules (stampede protection, fail-safe, backplane, jitter) live in `../caching.md`.

## Library pick

Check the project first. If a hybrid-cache library is already referenced, keep it: the rules are the requirement, not the package. For a new setup:

- **`HybridCache`** (.NET 9+, `Microsoft.Extensions.Caching.Hybrid`): in-box, L1 + L2 and stampede protection, fewer knobs (no built-in fail-safe or soft-timeout). Prefer it when that is enough.
- **FusionCache** (`ZiggyCreatures.FusionCache`): fail-safe stale-serving, factory soft-timeouts, a backplane. Recommend it, and confirm before adding the package, when the project needs those extras.

## FusionCache sketch

L2 payloads use MessagePack (`FusionCacheNeueccMessagePackSerializer`) over JSON: smaller and faster on the hot path.

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
