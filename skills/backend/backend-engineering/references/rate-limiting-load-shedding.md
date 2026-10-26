---
metadata:
  file: rate-limiting-load-shedding.md
  sections:
    - {title: "1. When this applies", start: 17, end: 22}
    - {title: "2. Principles", start: 24, end: 31}
    - {title: "3. Design", start: 33, end: 111}
    - {title: "4. Traps", start: 113, end: 125}
    - {title: "5. Invariants to test", start: 127, end: 133}
    - {title: "6. Rationalizations / Red flags", start: 135, end: 145}
    - {title: "7. Checklist", start: 147, end: 157}
---
# Rate Limiting and Load Shedding

> **Golden path:** Key limits on the authenticated principal or server-observed IP plus the matched route template, count in one authoritative store, shield it with an equal-cap local limiter, and fail open with a metric.

## 1. When this applies

- Any public or multi-tenant endpoint that an unauthenticated or semi-trusted caller can reach.
- Adding a limit, a ban, a tier, or an overload guard to a service that runs as more than one instance.
- Debugging "the limit does not hold", "everyone gets 429 behind the load balancer", or "tests randomly return 429".
- Deciding what happens to requests when the limiter's backing store is down.

## 2. Principles

1. **Key on what the attacker cannot vary.** The partition is `principal | matched route template`. The principal comes from an authenticated claim, an allow-listed credential, or the server-observed address. Never from the raw path, the user agent, or any header the caller can mint freely.
2. **One authoritative store counts; everything else is a shield.** Counters live in a single store with an atomic operation. Local structures may only reject earlier, never admit more.
3. **Degrade to bounded, not to off and not to down.** If the store is unreachable, fall back to a per-node limiter and emit a metric. A limiter outage must not become a self-inflicted outage.
4. **Never cache a counter.** A per-node copy of a counter lets each of N nodes admit the full limit, an N-times bypass. Cache policy overrides, never counts.
5. **Separate abuse control from overload control.** Per-principal limits protect fairness. Adaptive admission protects the process. They are different layers with different signals.
6. **Limits are an opt-in declared at the route**, so health probes and documentation endpoints are untouched and the policy is visible next to the handler.

## 3. Design

### Partition key and principal `[shipped]`

```
key = "{app}:ratelimit:{policy}:{principal}|{route_template}"

principal(request):
  if request.user.sub exists                      -> "user:" + sub,            tier = tier_of(request)
  if request.api_key in configured_allow_list     -> "key:"  + hash(api_key),  tier = authenticated
  else                                            -> "anon:" + hash(request.remote_address)   # server-observed only

route_template = matched route pattern text (e.g. "/items/{id}"), empty when nothing matched
```

- An API key that is not on the allow-list does **not** elevate. It falls through to the IP bucket. Otherwise an attacker rotates random keys and mints unlimited fresh high-tier buckets.
- Hash the IP and the key. This bounds key cardinality and keeps raw identifiers out of the store.
- Tiers scale the permit limit: anonymous 0.25, authenticated 1, internal 5. Anonymous gets the smallest multiplier rather than a finer key, because a raw IP is coarse under NAT.
- The internal tier requires **both** a trusted authentication scheme (for example mTLS or an internal issuer) **and** the namespaced tier claim. A claim alone can be forged by any external identity provider, so it would be a bypass and a privilege escalation. `[known gap]` in the reference system: the "Internal" scheme is referenced but never registered, so the internal tier is dormant.

### Counters, fail-open, and the two-tier shield `[shipped]`

```
acquire(key):
  if local_prelimit_enabled:
     if not local_limiter(cap = GLOBAL_LIMIT).try_acquire(key): return REJECT     # zero remote calls
  if store.is_connected():
     return store.atomic_check_and_increment(key, limit, window)                  # single atomic script
  metric("ratelimit.fallback")
  return per_node_limiter.try_acquire(key)                                        # degraded, N-times looser
```

- The local limiter's cap equals the global limit, so it can never reject something the store would admit: if one node alone exceeds the global limit, the fleet is over it too.
- The toggle (`local_prelimit`) exists for tests and for single-node modes. Default on in distributed mode.
- The fallback is intentionally looser than the real limit. The metric makes the degraded state alertable. The full fail-open/fail-closed list lives in `resilience-lifecycle.md`.
- Policy overrides (per-principal limits) are read through the shared cache, never the counters; see `caching.md`.

### Burst soft-ban `[shipped]`

A window breach arms a fixed ban (at least 10 seconds in the reference system) that outlives the sliding window, so a client cannot hammer at the window edge.

```
is_banned(key):  return local_mirror.contains(key)                 # 0 remote operations when not banned
ban(key, ttl):   local_mirror.set(key, ttl)
                 store.set_with_ttl(ban_key, ttl)                  # durability only, never read on the hot path
                 pubsub.publish(channel, encode(key, ttl))
on_message:      every node writes the key into its own mirror
```

Pub/sub is best-effort. A dropped message or a node that joined late can miss a ban until it is re-armed. This is acceptable because bans are short and the limiter itself still enforces.

### Adaptive admission (overload shedding) `[shipped]`

- A controller does AIMD (additive increase, multiplicative decrease) on one in-process concurrency limit.
- Input is a composite load score smoothed with an EWMA: CPU, worker-pool backlog, latency against a baseline, and recent 5xx rate. Expose the score components as gauges (`adaptive.limit`, `adaptive.load.{score,cpu,threadpool,latency,errors}`) so an operator can see **why** the limit moved.
- Over the limit returns 503 with `Retry-After: 1`.
- **Enforcement is always in-process.** A distributed in-flight counter leaks on every crash. Distributed mode only changes the **signal**: each node writes its load score into one shared hash as `"{score};{unix_ms}"`, and the fleet uses the maximum of non-stale entries. An entry is stale when older than `max(3 x control_interval, 5 s)`; stale entries are ignored and best-effort deleted, and the whole hash has a short TTL as a backstop. If the store is unreachable the node uses its local score (fail-open).

### Response contract `[shipped]`

```
on breach (limiter rejects):
    arm ban(ban_duration)
    retry_after = max(ban_duration, limiter_retry_hint ?? policy_window ?? 1s)   # "??" is a fallback chain, not a max
already banned (ban filter, even after the window reset):
    retry_after = remaining ban time
429: problem body { status, title, traceId } + Retry-After = ceil_to_whole_seconds(retry_after)
503: problem body + Retry-After: 1        # overload, not abuse
```

Count rejections (`ratelimit.rejected`, `burst.banned`, `adaptive.rejected`) so dashboards separate abuse from overload.

### Failed-authentication lockout `[shipped]`

The login path counts failed attempts per account and locks it after 5 failures for 15 minutes; a success resets the counter, and a locked account is refused before the password is checked. This is the identity store's built-in lockout, keyed on the account alone.

### Other dimensions from the house hardening guidance `[proposed]`

Steady quota (fixed hourly window, reads and writes tuned separately), a per-principal concurrency cap, and a lockout keyed on `(username, address)` instead of the account alone (so an attacker cannot lock a victim out from one address while the victim keeps working from another). They compose with the burst guard on the same route.

## 4. Traps

- **Raw path as key.** `/items/1`, `/items/2` each get a bucket, so the effective limit multiplies. Key on the matched route template.
- **User agent in the key.** The caller varies it per request and mints unlimited anonymous buckets.
- **Any API key elevates.** Rotate random keys to evade. Only allow-listed keys elevate (found and fixed in the reference system).
- **Forged tier claim.** An external identity provider can put `tier=internal` in its own tokens. Gate on the authentication scheme, not the claim.
- **Caching counters in L1/L2.** Each node admits the full limit. Only per-principal overrides go through the cache.
- **Stale fleet load entry.** A crashed node's last high score stayed in the shared hash and held the fleet maximum high forever. Fix: store `"{score};{unix_ms}"` per node, ignore entries older than `max(3 x control_interval, 5 s)`, prune them, and keep a whole-hash TTL as a backstop. Tolerate a bare score from an older node during a rolling deploy (treat as fresh).
- **Limiter placed after the output cache.** Cache hits never reach the limiter, so cached responses are uncounted. In the reference system the limiter is registered after the output cache and request logging; decide that deliberately. Pipeline order has one home: `api-surface.md`.
- **Forwarded headers not configured.** Without a trusted-proxy list in production, either the proxy address is used for everyone (all clients share one bucket: self-DoS) or the spoofable header is trusted (the limit is evadable). See `security-hardening.md`.
- **Test isolation.** The local ban mirror and local windows survive a flush of the store. The first request of the next test returns 429. Fix: the integration fixture disables the local pre-limit and its reset helper also clears the in-process memory cache. Cover the local tiers with unit tests instead.
- **Config drift** `[known gap]`: in the reference system the `Enabled` option is never read, and the documented default for `Mode` is Distributed while the code default is Local. Treat option docs as untrusted until a test pins them.
- **Store client aborts on connect failure.** A store blip then crashes startup. Connect with abort-on-fail disabled and gate the limiter on the live connection state.

## 5. Invariants to test

- Integration, real store: five anonymous permits then the sixth returns 429 with `Retry-After` and a problem body; a ban persists after its window ends.
- Unit: an unregistered API key lands in the IP bucket; a forged tier claim stays authenticated tier; the key uses the route template, not the path; two different user agents share one bucket.
- Unit: when the local cap is exceeded the store is never called; when the store is disconnected the fallback runs and the fallback metric increments.
- Unit: a stale load entry is ignored by the fleet maximum.
- Test fixture: pre-limit disabled and memory cache cleared in the reset helper, asserted by a second test that would otherwise inherit a ban.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "A per-node in-memory limiter is enough" | Behind a load balancer the limit multiplies by N. Fine for dev only. |
| "Cache the counter, the store is slow" | That is an N-times bypass. Shield with a local limiter whose cap equals the global cap instead. |
| "Include the user agent, it gives finer buckets" | The caller controls it. Finer for them, not for you. |
| "Fail closed when the store is down, it is safer" | The limiter becomes the outage. Fail open to a bounded local limiter with a metric. |
| "Trust the tier claim, our IdP is internal" | Any future second issuer inherits the bypass. Gate on the scheme. |

Red flags in a diff: the request path used as a key; a header value other than an allow-listed credential in a key; a counter read through a cache; a limiter with no fallback metric; a distributed in-flight counter; a rate-limit test with no reset of in-process state.

## 7. Checklist

- [ ] Key is `principal | route template`; principal precedence is claim, allow-listed key, hashed observed address.
- [ ] Counters are atomic in one store; none pass through a cache.
- [ ] Store outage falls back to a per-node limiter and emits a metric; both paths tested.
- [ ] Local pre-limit cap equals the global cap and is toggleable.
- [ ] Ban survives the window and the not-banned hot path costs zero remote calls.
- [ ] 429 and 503 carry `Retry-After` and a problem body with the trace id.
- [ ] Trusted proxies are configured, or forwarded headers are ignored.
- [ ] Opt-in is per route; health and docs routes are exempt.
- [ ] Integration fixture resets store and in-process state.
