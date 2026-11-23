# Application caching — hybrid L1/L2 (shared reference)

## Contents

- Rules
- Related

Linked from `yusufcirak-skills:csharp-hardening` (Application Caching) and `yusufcirak-skills:csharp` (keyed DI cache stores). Owns *how* an in-process cache layer behaves. Don't hand-roll a cache, and don't run a bare `IMemoryCache` or `IDistributedCache` directly: neither gives stampede protection, fail-safe, or cross-node invalidation, and you will re-implement all three badly.

If a hybrid-cache library is already referenced, keep using it: these rules are the requirement, not the package. Library pick (`HybridCache` vs FusionCache), registration and serializer: `setups/caching.md`.

## Rules

- **L1 + L2 + backplane.** In-memory L1 for hot reads; Redis L2 shared across instances; a backplane (Redis pub/sub) so a write on one node evicts or updates that key's L1 on every node. Otherwise nodes serve stale L1 entries until expiry.
- **Stampede protection** is the main reason to use this: concurrent misses for the same key collapse to a single factory call; the rest await it.
- **Fail-safe:** on a factory failure (the backing call throws or times out) serve the stale value past its logical expiry instead of propagating the error. Availability over freshness for cacheable reads.
- **Factory soft-timeout:** bound how long a read waits on the backing call; on soft-timeout return stale and let the refresh complete in the background, so one slow dependency cannot stall callers.
- **Jitter** expiry (a few percent or seconds) so keys written together do not all expire on the same tick.
- **Never cache** authenticated or per-user responses in a shared L2 under a non-user-scoped key, secrets, or anything the `yusufcirak-skills:csharp-hardening` redaction policy forbids logging. Scope the key by tenant or user where the value is principal-specific.

## Related

- `yusufcirak-skills:csharp-hardening` (`../csharp-hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `yusufcirak-skills:csharp` (`../csharp/SKILL.md`) — C# House Style
