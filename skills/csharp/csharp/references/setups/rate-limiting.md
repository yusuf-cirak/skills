# Setup: rate limiter registration and Redis backend

Load when adding `AddRateLimiter` to a service or moving it to a distributed store. The dimensions, partition rules and fail-open stance live in `yusufcirak-skills:csharp-hardening` (Tiered Rate Limiting).

## Built-in limiter (.NET 8+)

```csharp
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.OnRejected = async (ctx, ct) =>
    {
        ctx.HttpContext.Response.Headers.RetryAfter = "60";
        await ctx.HttpContext.Response.WriteAsJsonAsync(
            new ProblemDetails { Status = 429, Title = "Too many requests" },
            cancellationToken: ct);
    };

    // Burst guard: 20 req / 5s per (user, endpoint). Reject, do not queue.
    o.AddPolicy("burst", httpContext =>
    {
        var userKey = httpContext.User.FindFirst("sub")?.Value
                      ?? httpContext.Connection.RemoteIpAddress?.ToString()
                      ?? "anon";
        // Route TEMPLATE, not raw path: per-id paths must share one bucket.
        var route = (httpContext.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText
                    ?? httpContext.Request.Path.ToString();
        return RateLimitPartition.GetSlidingWindowLimiter(
            $"{userKey}|{route}",
            _ => new SlidingWindowRateLimiterOptions
            {
                PermitLimit = 20, Window = TimeSpan.FromSeconds(5), SegmentsPerWindow = 5, QueueLimit = 0,
            });
    });

    // Steady read quota per user per hour
    o.AddPolicy("quota-read", httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            httpContext.User.FindFirst("sub")?.Value ?? "anon",
            _ => new FixedWindowRateLimiterOptions { PermitLimit = 1_000, Window = TimeSpan.FromHours(1), QueueLimit = 0 }));

    // Concurrency cap per user
    o.AddPolicy("concurrency", httpContext =>
        RateLimitPartition.GetConcurrencyLimiter(
            httpContext.User.FindFirst("sub")?.Value ?? "anon",
            _ => new ConcurrencyLimiterOptions { PermitLimit = 10, QueueLimit = 0 }));
});

app.UseRateLimiter();

app.MapPost("/orders", Handler)
   .RequireRateLimiting("burst")
   .RequireRateLimiting("quota-write")
   .RequireRateLimiting("concurrency");
```

Soft-ban after a burst hit: on the second consecutive rejection within the window, write `lock:{userKey}:{path}` with a 60 s TTL into the shared store, and let a guard middleware short-circuit with 429 while the lock exists.

## Backend choice

- **In-memory** (the default): dev and single-instance only. Behind a load balancer the limit is multiplied by N.
- **Distributed (Redis)**: required for multi-instance prod. Use a community package such as `RedisRateLimiting`, or wrap `StackExchange.Redis` with an atomic Lua script (`INCR` + `EXPIRE`, or a sorted-set sliding window).

```csharp
services.AddRedisRateLimiting(o =>
{
    o.ConnectionMultiplexerFactory = sp => sp.GetRequiredService<IConnectionMultiplexer>();
});
```

- **Fail open.** With `AbortOnConnectFail = false` and a guard on `IConnectionMultiplexer.IsConnected`, degrade to a per-node in-memory limiter when Redis is down, and emit a `ratelimit.fallback` counter.
- **Local ban mirror plus pub/sub.** The hot path reads a per-node `IMemoryCache` mirror of active bans (0 Redis ops when not banned). Banning sets the local entry, `PUBLISH`es on a channel, and writes a TTL key to Redis for durability. An `IHostedService` subscribes and mirrors every broadcast. Pub/sub is best-effort, which is acceptable because bans are short and the limiter still enforces.
- **Two-tier limiter.** A per-node in-memory limiter whose cap equals the global permit limit fronts the Redis limiter (a `RateLimiter` subclass composing the library's Redis limiter). A local reject never touches Redis. Gate it behind `RateLimiting:LocalPreLimit` (default on, distributed mode only).
- **Test isolation.** The local ban mirror and windows survive a Redis `FLUSHDB`, so the first request in a later test can spuriously return 429. In the integration fixture set `LocalPreLimit=false` and have the reset helper also clear the ban mirror's `MemoryCache`. Cover the two-tier and hybrid-ban classes with unit tests.
- **Failed-auth lockout.** Store the fail counter in Redis with a 10 min TTL. On the 5th failure write `auth-lock:{user}:{ip}` with a 30 min TTL and reject downstream. Reset on successful login.
