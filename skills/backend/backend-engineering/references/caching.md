---
metadata:
  file: caching.md
  sections:
    - {title: "1. When this applies", start: 17, end: 24}
    - {title: "2. Principles", start: 26, end: 33}
    - {title: "3. Design", start: 35, end: 95}
    - {title: "4. Traps", start: 97, end: 107}
    - {title: "5. Invariants to test", start: 109, end: 115}
    - {title: "6. Rationalizations / Red flags", start: 117, end: 127}
    - {title: "7. Checklist", start: 129, end: 137}
---
# Caching

> **Golden path:** Use a two-level cache with single-flight, stale-while-revalidate and cross-node invalidation from a library; never cache counters or freshness-critical decisions.

## 1. When this applies

- Adding any cache: in-process, shared, or both.
- Seeing stale data after a write, a thundering herd after expiry, or nodes disagreeing.
- Deciding whether a value may be cached at all (counters, authorization, per-user data).
- Choosing timeouts and fallbacks for a slow dependency behind a cache.

The reference system uses a single hybrid-cache library. The principles below are library-neutral: any library that provides the listed levers is acceptable, and a library that does not should not be hand-extended.

## 2. Principles

1. **Read local, write through, invalidate everywhere.** A hot read hits process memory (L1). A shared store (L2) survives restarts and serves cold nodes. A backplane tells every node to drop its L1 copy when any node writes.
2. **One in-flight loader per key.** Concurrent misses collapse into a single call to the backing store. The rest wait for it.
3. **Serve stale rather than fail or stampede.** Past logical expiry, keep a value for a fail-safe window and return it when the loader errors or is slow.
4. **Do not hand-roll the hard parts.** A homemade stale-while-revalidate plus a lock has its own race. Use the library's native levers.
5. **Cache what is cheap to be wrong about.** Never cache counters, authorization decisions that must be fresh, or secrets.
6. **A cache outage is a performance event, not an availability event.**

## 3. Design

### Layers `[shipped]`

```
read(key, loader):
   v = L1.get(key)                       -> hit
   v = L2.get(key)                       -> hit, populate L1
   v = single_flight(key, loader)        -> one loader call for all concurrent callers
   write L1 (sync) and L2 (background); publish "evict key" on the backplane
```

- **L1** in-process memory, **L2** a shared distributed store, **backplane** pub/sub on the same store so a write on one node evicts the key from every other node's L1.
- **Serialization for L2:** a compact binary format over JSON. It is smaller and faster on the hot path. The format is a deployment contract: changing it needs a key-prefix bump or a flush.
- **Key prefix:** `"{service}:cache:{key}"`. It prevents collisions between services sharing a store and makes bulk invalidation possible. Scope keys by tenant or user when the value is principal-specific.

### Defaults worth copying `[shipped]`

| Lever | Reference value | Why |
|---|---|---|
| Duration | 5 min + up to 10 s jitter | Jitter stops keys written together from expiring on the same tick. |
| Fail-safe window | 1 h, 5 s throttle | Keep serving a stale value when the loader fails; throttle stops hammering a sick dependency. |
| Factory soft timeout | 100 ms | Past it, return stale and let the refresh finish in the background. |
| Factory hard timeout | 2 s | Upper bound when there is no stale value to return. |
| Eager refresh | at 80% of duration | The next reader triggers a background refresh before expiry, so most callers never see a miss. |
| L2 writes | background | A slow shared store does not slow the response. |
| L2 physical TTL | 10 min | Bounds shared-store memory independent of logical duration. |

### Stale-while-revalidate shape `[shipped]`

```
get_or_set_swr(key, loader, soft_ttl, hard_ttl):
   duration        = soft_ttl                # value is "fresh" until here
   fail_safe_extra = hard_ttl - soft_ttl     # value is "stale but servable" until here
   eager_refresh   = 0.8
```

This is a thin helper over the library's levers, not a second implementation. The race-free single-flight comes from the library.

### Connection behaviour `[shipped]`

One shared connection multiplexer, created with abort-on-connect-fail disabled so that a store blip at startup or runtime degrades to L1 plus loader calls instead of crashing the process. The same connection serves L2, the backplane, rate limiting, and locks.

### Invalidation and miss semantics

- Prefer write-through plus backplane eviction to time-based waiting.
- A negative result (not found) is a value and may be cached briefly; an error is not, and must not overwrite a good stale value.
- Cache the loader's result type, not the HTTP response. HTTP-level caching (shared caches, conditional requests) is a separate decision: authenticated responses default to no-store and anything varying per user varies on the credential.

### What to cache and what not to

| Cache | Do not cache |
|---|---|
| Reference data, per-principal policy overrides, expensive read models, derived group or role lookups | Rate-limit counters, burst bans' source of truth, idempotency state (not through this L1/L2 hybrid; see below) |
| Results of slow, idempotent reads with a tolerable staleness bound | Revocation or permission decisions that must be fresh |
| Negative lookups, briefly | Secrets, raw credentials, anything the logging redaction policy forbids logging |
| Values scoped by tenant or user in the key | Principal-specific values under an unscoped key |

State the tolerable staleness next to every cached read. If nobody can say it, do not cache it.

**Idempotency state is stored, not cached.** "Do not cache idempotency state" means: never route it through the L1/L2 hybrid. L1 would serve a stale or per-node copy, and the stored response must be the one authoritative record. The reference system writes it through the plain distributed-cache interface (get and set with its own key prefix and a 24 h TTL), not through the hybrid cache, which is correct. It degrades to "no idempotency, with a warning" if no such store is registered. The distinction is the access path (direct, authoritative, with expiry) and not the physical server. See `idempotency-locking-concurrency.md`. The same applies to rate-limit counters (`rate-limiting-load-shedding.md`) and revocation lists (`security-hardening.md`).

## 4. Traps

- **Caching a counter.** Each node counts alone and admits the full limit. Counters live in the one authoritative store (see `rate-limiting-load-shedding.md`). Only per-principal policy overrides go through the cache.
- **Hand-rolled SWR with a lock.** Two callers observe "stale", both start a refresh, and a failed refresh drops the good stale value. Use the library's fail-safe and eager-refresh levers.
- **No jitter.** A batch of keys populated together expires together and stampedes the backing store at the same instant.
- **No backplane.** Nodes serve stale L1 until expiry after a write elsewhere.
- **Startup crash on store blip.** The connection factory aborts on first failure. Disable abort-on-fail.
- **Shared L2 with unscoped keys.** One user's response is served to another. Scope by tenant and user, or do not cache.
- **Format change in place.** Old entries fail to deserialize. Bump the prefix.
- **Caching an authorization decision for the token lifetime.** Group and role changes then take effect only at the next login. Derive volatile claims per request from a cache-backed lookup instead, with a short duration.
- **Warm-up cost mistaken for a hot path.** Optimize measured paths only; a memoized one-time transform is not worth allocation work.

## 5. Invariants to test

- Single-flight: 25 concurrent callers for one key run the loader exactly once.
- Fail-safe: a loader that throws after a successful load returns the stale value, and a later successful load replaces it.
- Soft timeout: a loader slower than the soft timeout returns stale immediately and the refreshed value is visible afterwards.
- Eviction: a write on node A makes node B's next read miss L1 (integration with two cache instances sharing a store).
- Counters and security decisions are not routed through the cache layer (an architecture or grep rule on the rate-limit and token-validation projects).

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "A bare distributed cache is enough" | No single-flight, no fail-safe, no cross-node eviction. You will rebuild all three badly. |
| "I will write a small SWR helper" | The race between refresh and expiry is the whole difficulty. |
| "Cache the counter, it is just a number" | That is an N-times limit bypass. |
| "Time-based expiry is simple" | Users see stale data after their own write. |
| "Cache the permission check for the session" | Revocation then lags by the cache lifetime. |

Red flags in a diff: a loader invoked in a loop of `if missing then load`; a cache key containing no tenant or user for a principal-specific value; a TTL constant with no jitter; a second connection created for the cache; a cache put around a rate limiter or token blacklist.

## 7. Checklist

- [ ] L1, L2, and a backplane are configured; keys carry a service prefix.
- [ ] Concurrent misses are coalesced (tested).
- [ ] Fail-safe window, soft and hard timeouts, jitter, and eager refresh are set deliberately.
- [ ] Store connection does not abort on failure; startup survives a blip.
- [ ] No counter, secret, or fresh-by-definition decision is cached.
- [ ] Principal-specific values are scoped by tenant or user.
- [ ] Serialization format changes bump the prefix.
