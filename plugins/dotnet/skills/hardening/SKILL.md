---
name: hardening
description: Hardens ASP.NET Core services exposed to untrusted or multi-tenant traffic. Use when hardening a service, doing a security review, configuring middleware/`Program.cs`, or deploying. DTO-level input size/length limits belong to `validation`.
---

# Production Hardening (FAANG-level)

## Contents

- Tiered Rate Limiting & Burst Protection
- Idempotency
- AuthN / AuthZ
- Security Headers + CORS
- Forwarded Headers / Real Client IP
- Cryptography
- Secrets in configuration
- Error Handling → `dotnet:validation`
- Structured Logging & Audit → `dotnet:observability`
- EF Core Hardening
- File Upload → `dotnet:validation`
- SSRF Defense
- Resilience (outbound calls) → `../csharp/references/resilience.md`
- XML / Deserialization Safety
- Transport (compression & decompression)
- HTTP Caching
- Application Caching (hybrid L1/L2) → `../csharp/references/caching.md`
- Multi-Tenancy
- Background Jobs & Messaging → `dotnet:csharp`
- Dependency & Supply Chain
- Observability → `dotnet:observability`
- API Versioning & Lifecycle
- Cancellation & Timeouts → `dotnet:observability`
- CI / Test Security
- LLM / Prompt-Injection Hardening
- Related skills → `dotnet:observability`, `dotnet:validation`, `dotnet:web-api`, `dotnet:ddd`, `dotnet:csharp`, `dotnet:testing`

## Files

- `../csharp/references/resilience.md` — Resilience pipelines (single source of truth)
- `../csharp/references/caching.md` — Application caching — hybrid L1/L2 (shared reference)
- `../csharp/references/ef-core-data-access.md` — EF Core data access — performance & value-object persistence (single source of truth)
- `../csharp/references/value-object-base.md` — Value Object base type + converters (via nested link)
- `../csharp/references/build-and-analyzers.md` — Build & analyzers — gates, branch-aware style enforcement, generator packaging
- `../csharp/references/outbox-debezium-masstransit.md` — Outbox → Debezium → Kafka → MassTransit — the concrete traps
- `../csharp/references/mediator.md` — Mediator selection & licensing (via nested link)
- `dotnet:validation` (`../validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
- `dotnet:observability` (`../observability/SKILL.md`) — Observability (OpenTelemetry-native, FAANG-level)
- `dotnet:csharp` (`../csharp/SKILL.md`) — C# House Style
- `dotnet:web-api` (`../web-api/SKILL.md`) — ASP.NET Core Web API
- `dotnet:ddd` (`../ddd/SKILL.md`) — .NET Domain-Driven Design & Architecture
- `dotnet:testing` (`../testing/SKILL.md`) — C# Testing Standard

These rules apply to any service exposed to untrusted networks or multi-tenant traffic: tiered/distributed rate limiting & burst protection, idempotency keys & webhook HMAC, authn/authz (short-lived tokens, refresh rotation + reuse detection, resource-level checks, tenant-from-claim), security headers & CORS, cryptography, `ProblemDetails` error handling, structured logging & audit, EF Core hardening, secure file upload, SSRF defense, deserialization safety, HTTP/application caching, multi-tenancy isolation, background jobs/outbox, supply-chain security, and API versioning/lifecycle. They are non-negotiable defaults; deviations need a written justification on the PR. DTO/serialization input limits are owned by `validation`; this skill covers the network/runtime/ops hardening surface.

## Tiered Rate Limiting & Burst Protection

Rate limiting must be **multi-dimensional**, **distributed**, and **partitioned by principal + endpoint**. A single global bucket is not enough.

Dimensions:

- **Burst guard** — sliding window per `(userId, endpoint)`. Default: **20 req / 5s** with `QueueLimit = 0`. A burst beyond the window is rejected immediately, and an offending principal MUST be soft-banned on that endpoint for **60s** (write the lock key into the same store the limiter uses).
- **Steady quota** — fixed window per user per hour. Reads: 1 000/h, writes: 200/h. Tune per business need.
- **Concurrency cap** — max in-flight requests per user (default 10). Prevents a single principal monopolising worker threads / DB connections.
- **Tier multiplier** — anonymous gets 0.25×; authenticated 1×; internal/service 5×. The privileged (internal/service) tier MUST be asserted from a **trusted authentication scheme** (mTLS / internal API-key scheme), never from a value the caller can place in its own JWT — a forgeable tier claim is both a rate-limit bypass and a privilege escalation.
- **Failed-auth lockout** — 5 failures / 10 min on login or token endpoints → 30 min lock on `(username, ip)`. Mitigates credential stuffing.

Partition key precedence: authenticated user id (`sub`) → API key id (hashed) → `hash(client IP)`. **Never add the `User-Agent` (or any other caller-controlled header) to the anonymous key** — the caller can vary it per request and mint unlimited buckets. Behind a proxy use the forwarded-headers-resolved IP (see "Forwarded Headers"), never the raw `X-Forwarded-For`. Raw IP is coarse for NAT/CGNAT, which is why the anonymous tier gets the smallest multiplier rather than a finer key.

**Partition on the matched route *template*, never the raw path.** Keying on `Request.Path` means `/items/1`, `/items/2`, … each get their own bucket and the effective limit multiplies — a trivial bypass. Read the matched `RouteEndpoint.RoutePattern.RawText` (fall back to the raw path only when no endpoint matched).

Code (.NET 8+ built-in `RateLimiter`):

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

    // Burst guard: 20 req / 5s per (user, endpoint). Reject (not queue) on overflow.
    o.AddPolicy("burst", httpContext =>
    {
        var userKey = httpContext.User.FindFirst("sub")?.Value
                      ?? httpContext.Connection.RemoteIpAddress?.ToString()
                      ?? "anon";
        // Route TEMPLATE, not raw path — per-id paths must share one bucket.
        var route = (httpContext.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText
                    ?? httpContext.Request.Path.ToString();
        var partition = $"{userKey}|{route}";
        return RateLimitPartition.GetSlidingWindowLimiter(
            partition,
            _ => new SlidingWindowRateLimiterOptions
            {
                PermitLimit = 20,
                Window = TimeSpan.FromSeconds(5),
                SegmentsPerWindow = 5,
                QueueLimit = 0,
            });
    });

    // Steady read quota per user per hour
    o.AddPolicy("quota-read", httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            httpContext.User.FindFirst("sub")?.Value ?? "anon",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 1_000,
                Window = TimeSpan.FromHours(1),
                QueueLimit = 0,
            }));

    // Concurrency cap per user
    o.AddPolicy("concurrency", httpContext =>
        RateLimitPartition.GetConcurrencyLimiter(
            httpContext.User.FindFirst("sub")?.Value ?? "anon",
            _ => new ConcurrencyLimiterOptions { PermitLimit = 10, QueueLimit = 0 }));
});

app.UseRateLimiter();
```

Endpoint composition:

```csharp
app.MapPost("/orders", Handler)
   .RequireRateLimiting("burst")
   .RequireRateLimiting("quota-write")
   .RequireRateLimiting("concurrency");
```

Soft-ban after burst hit: implement a small middleware or `OnRejected` extension that, on the second consecutive rejection within the window, writes `lock:{userKey}:{path}` with TTL 60s into the shared store; a guard middleware short-circuits with 429 while the lock exists.

**Backend choice:**

- **In-memory** (`AddRateLimiter` default) — dev / single-instance only. Each process has its own counter; behind a load balancer the limit is multiplied by N.
- **Distributed (Redis)** — required for any multi-instance prod deployment. Use a community package such as `RedisRateLimiting`, or wrap `StackExchange.Redis` with a Lua script (`INCR` + `EXPIRE`) for atomicity.
- **Fail open, not closed.** When Redis is unreachable (`AbortOnConnectFail = false`; guard on `IConnectionMultiplexer.IsConnected`), degrade to a per-node in-memory limiter rather than 429-ing every request — a rate-limiter outage must not become a self-inflicted DoS. Emit a `ratelimit.fallback` counter so the degraded (per-node, multiplied-by-N) state is observable and alertable.
- **Budget the Redis round-trips.** The naive distributed setup costs **2 Redis round-trips per request** — a ban lookup (`PTTL`) plus the limiter's Lua script. Remove both with two patterns; Redis stays authoritative and fail-open is preserved:
  - **Local ban mirror + pub/sub.** The hot path reads only a per-node `IMemoryCache` mirror of active bans, so the common case (not banned) costs **0** Redis ops. Banning sets the local entry, `PUBLISH`es on a channel, and writes a TTL key to Redis for durability (never read on the hot path). An `IHostedService` subscribes and mirrors every broadcast into its node's cache. Pub/sub is best-effort — a dropped message or a late-joining node can miss a ban until it is re-armed; acceptable because bans are short and the limiter itself still enforces.
  - **Two-tier limiter.** A per-node in-memory limiter whose cap **equals the global permit limit** fronts the Redis limiter (a `RateLimiter` subclass composing the library's Redis limiter). A local reject returns without touching Redis — a flood shield. Cap == global means it never false-rejects: one node alone exceeding the global limit means the fleet is over it too. Gate it behind `RateLimiting:LocalPreLimit` (default on, distributed mode only).
  - **Test isolation:** the local ban mirror and local windows survive a Redis `FLUSHDB`, so state leaks across tests that share one host and the first request spuriously returns 429. In the integration fixture set `LocalPreLimit=false` and have the reset helper also clear the ban mirror's `MemoryCache`; cover the two-tier and hybrid-ban classes with unit tests instead.

```csharp
// Distributed example (RedisRateLimiting package)
services.AddRedisRateLimiting(o =>
{
    o.ConnectionMultiplexerFactory = sp => sp.GetRequiredService<IConnectionMultiplexer>();
});

// Hand-rolled sliding window using Redis sorted sets (Lua)
// KEYS[1]=partition  ARGV[1]=nowMs  ARGV[2]=windowMs  ARGV[3]=permitLimit  ARGV[4]=requestId
// redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1] - ARGV[2])
// local count = redis.call('ZCARD', KEYS[1])
// if count >= tonumber(ARGV[3]) then return 0 end
// redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
// redis.call('PEXPIRE', KEYS[1], ARGV[2])
// return 1
```

Failed-auth lockout — store fail counter in Redis with TTL 10 min; on the 5th fail, write `auth-lock:{user}:{ip}` with TTL 30 min and reject downstream. Reset on successful login.

## Idempotency

Idempotency is a **per-endpoint opt-in `IEndpointFilter`** (`.RequireIdempotency()` on the route or group), not a global middleware scanning every request — only the endpoints that can double-create or double-charge pay the cost. On an opted-in unsafe method (`POST`/`PUT`/`PATCH`/`DELETE`) a missing or over-long (> 200 chars) `Idempotency-Key` → 400; safe methods pass through.

- **Cache key is scoped by caller**: `idempotency:{sub or client IP}:{method}:{path}:{key}`. The key is client-chosen, so an unscoped key would let a caller replay a victim's stored response (cross-user disclosure).
- Only a **2xx** response **≤ 1 MB** is stored — errors must stay retryable. Stored for **24 h** in `IDistributedCache` as a binary blob `[status i32][contentTypeLen i32][contentType][body]` (no JSON/base64 wrapping on the write path).
- A hit replays status + content-type + body and sets `Idempotency-Replayed: true`.
- No `IDistributedCache` registered → log a warning and run the handler (degrade, do not fail the request).
- De-dupes **sequential** retries only. Two truly concurrent requests with the same key both run.

```csharp
public static TBuilder RequireIdempotency<TBuilder>(this TBuilder b) where TBuilder : IEndpointConventionBuilder =>
    b.AddEndpointFilter<TBuilder, IdempotencyEndpointFilter>();

// inside the filter
var scope = http.User.FindFirstValue("sub") ?? http.Connection.RemoteIpAddress?.ToString() ?? "anonymous";
var cacheKey = $"idempotency:{scope}:{http.Request.Method}:{http.Request.Path}:{key}";
if (await cache.GetAsync(cacheKey, http.RequestAborted) is { } cached) return new ReplayedResult(cached);
// run next(context) with Response.Body swapped for a MemoryStream, copy to the real body, then
// if (StatusCode is >= 200 and < 300 && buffer.Length <= 1 MB) cache.SetAsync(cacheKey, Encode(...), 24h)
```

Upgrades not implemented here: store a **body hash** with the entry and answer a same-key/different-body replay with **409**; an **atomic reservation** (`SET NX` on the key before running the handler) so concurrent duplicates are serialized, or route such commands through `ILockRequest` (`web-api` → Pipeline behaviors).

Inbound webhooks: require HMAC signature + `X-Timestamp` (reject if `|now - ts| > 5 min`) + nonce store (24 h replay window).

## AuthN / AuthZ

- Access token TTL ≤ 15 min. Refresh token TTL ≤ 30 days with **rotation on every use**.
- **Refresh-token reuse detection**: if an already-rotated refresh token is presented, revoke the entire token family and force re-login. This is the canonical defence against stolen refresh tokens.
- `[Authorize]` registered **globally** as fallback policy; `[AllowAnonymous]` is opt-in:
  ```csharp
  builder.Services.AddAuthorizationBuilder()
      .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());
  ```
- Resource-level authorization in the handler via `IAuthorizationService.AuthorizeAsync(user, resource, policy)`. Endpoint-level `[Authorize(Policy=...)]` alone is insufficient for instance-scoped permission (e.g. "can edit *this* order").
- **Tenant id MUST come from a token claim**, never from route/query/body. Expose via `ICurrentTenant` populated from `HttpContext.User`.
- `mTLS` for service-to-service traffic inside the cluster.

JWT bearer validation — hardened defaults (config-driven: **asymmetric is the preferred production default**; OIDC `Authority`+JWKS is the prod path; a symmetric HMAC secret only for a single-process dev/test setup). Honest status of the reference repo: TicketMaster's `JwtOptions.Mode` has only `Symmetric` (its default) and `Authority`; there is no configured-asymmetric-key mode yet, and `kid`-based rotation via `CurrentKeyId` + `PreviousKeys` is **uncommitted** work-in-progress in `JwtOptions`/`JwtAuthenticationExtensions`/`JwtTokenService`.

```csharp
o.MapInboundClaims = false; // keep "sub" as "sub" — rate-limiter, audit and log enrichment read it raw
o.TokenValidationParameters = new()
{
    ValidateIssuer = true, ValidateAudience = true, ValidateLifetime = true,
    ValidateIssuerSigningKey = true, RequireSignedTokens = true, RequireExpirationTime = true,
    ClockSkew = TimeSpan.FromSeconds(30), // the 5-minute default keeps expired tokens alive far too long
    NameClaimType = "sub", RoleClaimType = "role",
};
```

- **Sign asymmetrically — ES256 (RS256 where a consumer needs it).** The issuer holds the private key; every API validates with the public key only (JWKS, or a configured JWK/PEM). With HS256 every validating service holds the secret that can *mint* tokens, so one compromised service forges tokens for all of them. Symmetric signing is acceptable only when issuer and validator are the same process in dev/test. Prefer making asymmetric the options default; where a codebase still defaults to symmetric (TicketMaster today), treat that as a known gap, not a pattern to copy. The private key comes from the secret store (Key Vault etc.), never `appsettings` or the repo; an issuing service publishes its public keys at `/.well-known/jwks.json`.
- **Pin the algorithm.** Set `ValidAlgorithms = ["ES256"]` so a token cannot downgrade to `none` or to an HMAC verified with the public key as the secret (algorithm confusion).
- **Rotate keys with `kid`.** Sign with the current key and stamp its `kid`; keep retired *public* keys validation-only (`kid` → key) for at least the access-token TTL plus clock skew, then drop them. Publish a new key in the JWKS **before** signing with it. Resolve the validation key by `kid`, not by trying every key:
  ```csharp
  o.TokenValidationParameters.ValidAlgorithms = ["ES256"];
  o.TokenValidationParameters.IssuerSigningKeyResolver = (_, _, kid, _) => keyStore.ForKid(kid); // current + previous public keys
  ```
- **Revocation check on every request**: `JwtBearerEvents.OnTokenValidated` reads `jti` and calls `ITokenBlacklist.IsRevokedAsync(jti)` (`RedisTokenBlacklist`: `revoked:{jti}` with TTL = remaining token lifetime); on a hit `context.Fail("token_revoked")`. The blacklist **fails open** on a Redis error (logs a warning, treats as not revoked) — deliberate: availability over strict revocation, matching the rest of the Redis-dependent path. `ISensitiveRequest` commands re-run this check at handler time (`web-api` → Pipeline behaviors).
- **Secure by default**: register the authenticated fallback policy (above). It also applies to **unmatched routes**, so an anonymous request to an unknown path returns **401, not 404** (route existence is not leaked). Mark health/docs endpoints `AllowAnonymous`.
- **Scope authorization**: read OAuth scopes from both conventions — a space-delimited `scope` claim **and** repeated `scp` claims. Expose a `.RequireScope("orders:write")` endpoint helper (a policy + `IAuthorizationHandler`) following the same convention as `.RequireIdempotency()`. Roles use the native `.RequireAuthorization(p => p.RequireRole(...))`.
- **401/403 as problem+json**: wire `JwtBearerEvents.OnChallenge` (401) and `OnForbidden` (403) to write RFC 9457 `ProblemDetails` via `IProblemDetailsService` (consistent with the global handler — same `traceId`/`correlation_id` stamping), set `WWW-Authenticate` on challenge, and **never leak token-validation specifics** to the caller (`OnAuthenticationFailed` stays silent in prod; detail lives in the trace/logs).
- **Keep the token small; load volatile/high-cardinality claims per-request instead of baking them in.** A token re-issued only every 15 min goes stale the moment a user's group/role membership changes mid-session, and group lists that grow over time bloat every request's `Authorization` header. Implement `IClaimsTransformation` to append those claims *after* authentication, on every request, from a fast cache-backed lookup — the JWT carries only the stable identity (`sub`, core roles); derived/volatile authorization data is always current, never stale for the token's lifetime:
  ```csharp
  public sealed class GroupClaimsTransformation(IGroupLookupService groups) : IClaimsTransformation
  {
      public async Task<ClaimsPrincipal> TransformAsync(ClaimsPrincipal principal)
      {
          if (principal.Identity is not { IsAuthenticated: true }) return principal;
          var userGroupIds = principal.Claims.Where(c => c.Type == ClaimTypes.GroupSid).Select(c => c.Value);
          var resolved = await groups.GetGroupsAsync(userGroupIds); // cache-backed — see `caching.md`
          var identity = new ClaimsIdentity(resolved.Select(g => new Claim("group", g.Id.ToString())));
          principal.AddIdentity(identity);
          return principal;
      }
  }
  builder.Services.AddTransient<IClaimsTransformation, GroupClaimsTransformation>();
  ```
  Register it after `AddAuthentication()`; it runs on every authenticated request (not just login), so keep the lookup cheap (cache-backed, not a cold DB hit every time).

## Security Headers + CORS

```csharp
app.Use(async (ctx, next) =>
{
    var h = ctx.Response.Headers;
    h["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
    h["Content-Security-Policy"]   = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
    h["X-Content-Type-Options"]    = "nosniff";
    h["X-Frame-Options"]           = "DENY";
    h["Referrer-Policy"]           = "no-referrer";
    h["Permissions-Policy"]        = "geolocation=(), camera=(), microphone=()";
    h["Cross-Origin-Opener-Policy"] = "same-origin";
    h["Cross-Origin-Resource-Policy"] = "same-origin";
    h.Remove("Server");
    await next();
});
```

CORS: explicit `WithOrigins(...)` list. `AllowAnyOrigin()` combined with `AllowCredentials()` is **forbidden** (browsers reject it, and it is a clear sign of misconfiguration). **Deny by default**: when no origins are configured the policy allows **nothing** — never widen to `AllowAnyOrigin` as an empty-config fallback.

## Forwarded Headers / Real Client IP

Behind a load balancer / ingress, `RemoteIpAddress` is the proxy, not the client — which silently breaks rate-limit partitioning, `client_ip` audit/logs, and any IP allowlist. `UseForwardedHeaders()` must run **first** in the pipeline (before anything reads the IP or scheme).

- **Anti-spoofing**: trust `X-Forwarded-For`/`-Proto` **only** from explicitly configured proxies — set `KnownProxies` / `KnownIPNetworks` (renamed from `KnownNetworks` in .NET 10) to your edge ranges. Outside Development, if none are configured, the forwarded headers are **ignored** rather than blindly trusted (an attacker must not be able to forge their own client IP). In Development keep the framework default (loopback trusted) so local tooling works.

```csharp
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    o.ForwardLimit = 1; // one trusted hop (the edge)
    if (!builder.Environment.IsDevelopment())
    {
        o.KnownIPNetworks.Clear(); o.KnownProxies.Clear();
        foreach (var p in configuredProxies) o.KnownProxies.Add(IPAddress.Parse(p));
    }
});
app.UseForwardedHeaders(); // FIRST
```

## Cryptography

- Password hashing: **Argon2id** (preferred) or **bcrypt cost ≥ 12**. PBKDF2 only when FIPS-required (≥ 600 000 iterations SHA-256).
- General hashing: SHA-256 or SHA-3. `MD5` / `SHA1` / `DES` / `RC4` are **forbidden** outside legacy interop.
- Random tokens/nonces: `RandomNumberGenerator.GetBytes(32)`. `System.Random` is **forbidden** for any security-sensitive value.
- Secret comparison (HMAC, tokens): `CryptographicOperations.FixedTimeEquals`. Never `==` or `SequenceEqual`.
- Secrets from a managed store (Azure Key Vault / AWS Secrets Manager / HashiCorp Vault). Plain secrets in `appsettings.*.json` committed to source control are **forbidden**.

## Secrets in configuration

When a value must live in config anyway (connection strings, dev signing keys), store it **encrypted** and decrypt at the configuration layer, so no consumer ever sees ciphertext and no code path reads a plain secret file:

- Values prefixed `secret:` are decrypted by a **wrapping `IConfigurationProvider`**: `AddSecretConfiguration()` is called after every other source, builds the sources added so far into an inner root, and replaces them with one provider that reads through the inner and decrypts on the way out. It subscribes to the inner reload token, so a changed appsettings file / refreshed Key Vault source / rotated secret is re-decrypted and `IOptionsMonitor` consumers get a change notification.
- Crypto is **AES-256-GCM** (nonce 12 | tag 16 | ciphertext, base64); the AES key is derived with HKDF-SHA256 from out-of-band key material (`CONFIG_SECRET_KEY` env var) **plus** a fixed app salt, so a leaked env var alone cannot decrypt.
- The key is resolved **lazily** (`Lazy<IEncryptionProvider>`), only when a `secret:` value is actually decrypted — dev setups with no secrets need no key.
- **Fail fast** on a value that will not decrypt: throw `InvalidOperationException` naming the key. Never pass ciphertext (or a half-processed value) through to a consumer.
- Tests set the key material once in a `[ModuleInitializer]` (`Environment.SetEnvironmentVariable("CONFIG_SECRET_KEY", …)`) so every fixture decrypts the same way.

## Error Handling

- All errors emit `ProblemDetails` (**RFC 9457**, the current problem-details RFC superseding 7807). `application/problem+json`.
- Implement a global `IExceptionHandler` + `AddProblemDetails`, and use **`CustomizeProblemDetails` to stamp `traceId` + `correlation_id` (+ `instance` = path) on EVERY problem response** — handler-produced and framework-produced (404, 400 model-binding, 415) alike — so all error payloads look identical and are traceable.
- Production: response carries title, status, traceId, correlation_id. Stack trace and inner exception detail go to logs only, never to the wire.
- Map known cases: a failed `Result` carrying `ValidationError` → 400 `ValidationProblemDetails` (field→errors) via the single Result → HTTP mapper, not an exception (see `validation` §3b); any other `Error` → `Problem` with the error's status; **client abort** (cancellation when the client disconnected) → **499**, not 500; `BadHttpRequestException` → its own status.
- `traceId = Activity.Current?.TraceId.ToString()`. Never let DB / framework messages leak.

## Structured Logging & Audit

- **Logging mechanics live in `observability`** (OTel-native `ILogger`→OTLP, key/mask/baggage processors, JSON console, tail sampling). Prefer OTel-native; Serilog only when that isn't possible. Every line carries `trace_id`, `correlation_id`, `user_id`, `route`. This section owns the **redaction policy** that pipeline must enforce.
- **Never log**: passwords, tokens, `Authorization` / `Cookie` headers, full request/response bodies, full PII. Header logging is an **allow-list** (only known-safe headers); bodies off in Production.
- **Query strings leak secrets** — `HttpLoggingFields.RequestQuery` logs the raw query, which can carry OAuth `code`/`access_token`, signed-URL `sig`/`signature`, and `api_key`. Never enable it wholesale: log the query through an `IHttpLoggingInterceptor` that **redacts sensitive parameter values** (keep names + safe values for debugging, mask the rest to `***`).
- **Audit log** in a separate, append-only sink (and ideally signed): auth events (login, logout, failure), role/permission changes, data export, money movement, admin actions.

## EF Core Hardening

- **No `FromSqlRaw` with string concatenation.** Use `FromSqlInterpolated` (parameterised) or no raw SQL.
- Command timeout: read paths 10 s, write paths 30 s. Configure in `DbContext` options.
- Soft-delete + tenant via global query filter. `.IgnoreQueryFilters()` requires a written justification + audit entry.
- The `DbContext` defaults to no-tracking + split query (`../csharp/references/ef-core-data-access.md` → DbContext defaults); write paths opt in with `.AsTracking()`; `AsNoTrackingWithIdentityResolution` where dedupe matters.
- Connection pool sized; mirror with DB-side `statement_timeout` and `idle_in_transaction_session_timeout`.

## File Upload

- Validate **magic bytes**, not extension or `Content-Type` header (both client-controlled).
- AV scan (ClamAV / Defender) on the upload pipeline; quarantine on positive.
- Store outside the webroot; generate server-side filename; never echo client filename in URLs.
- Re-encode images server-side to strip EXIF and defuse decompression bombs (e.g. ImageSharp with pixel-count cap).
- Allowlist of `Content-Type`; reject everything else.
- Per-upload size limit via `[RequestSizeLimit]` (see `validation` section 6).

## SSRF Defense

- Outbound `HttpClient` registered with a `DelegatingHandler` that resolves the host and rejects if the IP falls in `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (cloud metadata), `::1`, `fc00::/7`.
- DNS rebinding protection: resolve once, pin the IP for the duration of the call.
- Outbound connect + total timeout mandatory. Default 5 s connect / 30 s total.
- `AllowAutoRedirect = false` or constrain redirects to the same origin.

## Resilience (outbound calls)

Every outbound call uses a typed `IHttpClientFactory` client (`dotnet:csharp` → Outbound HTTP: never a per-call or `static` `HttpClient`) that carries a **Polly v8 resilience pipeline** — don't hand-roll retry/timeout.
Default to `AddStandardResilienceHandler()` (retry + total/per-try timeout + circuit-breaker + hedging);
custom pipelines order strategies outer→inner. **Retry only idempotent calls**; jitter is mandatory; the
SSRF handler composes **inside** the pipeline. Pipelines emit OTel automatically. Full rules + ordering +
chaos-testing (`AddChaosFault`/Simmy): `../csharp/references/resilience.md`.

## XML / Deserialization Safety

- `XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null }`.
- `BinaryFormatter`, `SoapFormatter`, `NetDataContractSerializer`, `LosFormatter` are **forbidden** (RCE class). Use `System.Text.Json` or `MessagePack` with explicit contracts.
- If Newtonsoft.Json must be used: `TypeNameHandling = None`. Never `Auto` / `All` / `Objects`.

## Transport (compression & decompression)

- **Request decompression**: `AddRequestDecompression()` + `UseRequestDecompression()` (early, before the body is read) so clients may send `Content-Encoding: br/gzip/deflate`. The decompressed stream stays bounded by Kestrel `MaxRequestBodySize` — that cap is the decompression-bomb defence.
- **Response compression**: Brotli + gzip, but `EnableForHttps = false` — compressing secret-bearing responses over TLS enables the **BREACH** attack. Opt in per response where safe.
- **Output cache** (`AddOutputCache`) for cacheable GETs; never cache authenticated/user-varying responses (see HTTP Caching).

## HTTP Caching

- Authenticated responses default to `Cache-Control: no-store`.
- `Vary: Authorization` on any response that varies per user.
- Use `ETag` for conditional GET on read-heavy public endpoints.

## Application Caching (hybrid L1/L2)

Don't hand-roll a cache layer or run a bare `IDistributedCache`. Default to a **hybrid L1 (in-process) +
L2 (Redis)** cache with stampede protection, fail-safe stale-serving, and cross-node invalidation. Full
rules + library pick (FusionCache): `../csharp/references/caching.md`.

## Multi-Tenancy

- Tenant id flow: token claim → `ICurrentTenant` → EF global query filter → repository / handler.
- Cross-tenant query handlers (admin tooling) require an explicit `[CrossTenant]` marker **plus** an audit-log entry on every call.
- Defence in depth: row-level security at the DB (Postgres RLS / SQL Server security predicates) in addition to the query filter — never rely on the app layer alone.

## Background Jobs & Messaging

- Handlers MUST be idempotent. Concrete dedup: persist a `(message_id, consumer)` **unique** row in the *same transaction* as the handler's state change, and treat a unique-violation on insert (`SQLSTATE 23505` — provider-agnostic, read `DbException.SqlState`) as an idempotent no-op (a concurrent/redelivered duplicate), **not** an error to retry into a poison loop.
- **The dedup key should be deterministic, not random, when the message is derived from stable content** (reprocessing the same source record, reacting to the same upstream event). A `Guid.NewGuid()` per publish defeats dedup entirely — two publishes for the same logical event get two different ids and both pass the unique-row check. Hash the stable identifying content into a deterministic id instead (a fast non-cryptographic hash — e.g. FNV-1a over the content — folded into a `Guid`) and set it as the message/`MessageId` the dedup check keys on, so re-publishing the same logical event (a retry, a redelivery, a second producer instance) always lands on the same key. Reserve `Guid.CreateVersion7()` (see `csharp`) for ids that must be *unique per occurrence* — the two are solving opposite problems.
- Retry: exponential backoff with jitter, bounded attempts (default 5). Poison messages → DLQ; alert on DLQ depth.
- Cross-aggregate writes use the **Outbox pattern** — never dual-write to DB + broker. The concrete Debezium / MassTransit / polling-relay traps: `../csharp/references/outbox-debezium-masstransit.md`.
- **Distributed lock** (single-flight job, one-migrator-at-a-time): use a library (e.g. Medallion `DistributedLock.Redis`), never a hand-rolled Lua lock. Take it non-blocking — `TryAcquireAsync(TimeSpan.Zero)` returns `null` when held, so the caller skips instead of queueing; the handle auto-renews its TTL while held and releases on dispose, so the TTL only bounds crash recovery. A lock on a single Redis database is not safe across a Redis failover — treat it as an *efficiency* guard and keep the guarded work idempotent (fencing token or unique constraint) for correctness.
- This section owns **distributed/broker** reliability. For a purely **in-process** producer/consumer queue (no broker), use the `System.Threading.Channels` + `BackgroundService` primitive in `csharp` → Background work & channels.

## Dependency & Supply Chain

- Central package versions in `Directory.Packages.props`. Analyzer gating, `WarningsNotAsErrors` policy and generator `PrivateAssets`: `../csharp/references/build-and-analyzers.md`.
- CI: `dotnet list package --vulnerable --include-transitive` — **fail the build** on any CVE.
- Generate CycloneDX SBOM in the release pipeline.
- Pre-commit secret scanning (`gitleaks` / `trufflehog`).
- Roslyn analyzers: `Microsoft.CodeAnalysis.NetAnalyzers`, `SecurityCodeScan.VS2019` (or equivalent), `Roslynator`. In `Directory.Build.props`:
  ```xml
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  <AnalysisLevel>latest</AnalysisLevel>
  <AnalysisMode>All</AnalysisMode>
  ```

## Observability

Owned by the **`observability`** skill — OpenTelemetry-native traces/metrics/logs over OTLP, `correlation_id`/baggage, health probes, and SLO/burn-rate alerting all live there. From a hardening standpoint just enforce: telemetry exists and is wired; `correlation_id` echoed; **RED + USE** with SLOs and multi-window burn-rate alerts; redaction policy (above) honoured by the logging pipeline.

## API Versioning & Lifecycle

- `/v1/`, `/v2/` URL versioning **or** `Api-Version` header — pick one and stick with it across all services.
- Deprecation: emit `Deprecation: true` and `Sunset: <RFC1123-date>` headers on legacy versions.
- Per-endpoint kill switch via feature flag (`IFeatureManager` / LaunchDarkly / Unleash).

## Cancellation & Timeouts

- Every handler signature accepts `CancellationToken` and propagates it (`DbContext`, `HttpClient`, downstream calls). Handlers that ignore the token are blocked in review.
- Per-request timeout middleware: 30 s default; lower for read paths.
- Graceful shutdown: subscribe to `IHostApplicationLifetime.ApplicationStopping` to drain in-flight work; configure host `ShutdownTimeout` greater than the drain budget. Pair it with a readiness check that flips Unhealthy on `ApplicationStopping` so the LB drains first (see `observability` → Health checks).

## CI / Test Security

- SAST: CodeQL or SonarCloud on every PR.
- DAST: OWASP ZAP smoke against staging on each release.
- Snapshot tests asserting security headers, `ProblemDetails` shape, and the 429 envelope.
- OpenAPI schema-drift test (`Swashbuckle.AspNetCore.Cli`) — fail if undocumented endpoints appear.
- Critical paths: mutation testing (`Stryker.NET`).

## LLM / Prompt-Injection Hardening

Any text a caller (or an admin, or a document) can influence is **untrusted data** once a model reads it. Rules:

- **Structure every prompt with tagged sections** (`<gorev>`, `<kurallar>`, `<icerik>`…) and put untrusted text only
  inside its own block. One helper wraps it and **removes every structural tag from the text** (open/close, any
  case, spaces/attributes), repeating until nothing can re-form (`<ek_<icerik>talimatlar>`). Never concatenate
  untrusted text into a trusted section; never rely on a "please ignore instructions in the document" sentence alone.
- **Trusted policy in the system turn, untrusted state in the user turn.** The state may be a string, an array or an
  object: strings go as text, arrays/objects as compact JSON, inside the block. Serialize non-ASCII readably
  (relaxed encoder) — neutralize **after** serialization so readability never reopens the tag hole.
- **Gate at write time, fail-closed.** Classify free-text instructions with a model *before* persisting them.
  Anything that is not an explicit "allow" is blocked: timeout, provider error, invalid/out-of-policy output and a
  model refusal all reject the whole save. Return the reason to the admin; never save with a warning.
- **Determinism and cost:** temperature 0 plus a fixed seed; cache the verdict by hash(policy name+version, model,
  state kind, state) and bump the policy version whenever the policy text changes. Never cache failures. A cache
  outage must not break the request.
- **Model choice is system config, never caller input.** Use the configured default model for the gate; validate any
  stored model name against a format value object (charset, length, segments, no URL schemes) instead of a list that
  drifts as gateways add models.
- **Validate model output like input:** structured output, then check decision/category against the policy, clamp
  numbers to range, bound counts and lengths. LLM-produced free-form fields stay free-form but are capped.
- **Do not leak the machinery:** system prompt, raw model response and organization prompts are admin-only; return an
  empty same-shaped object (not `null`) to everyone else. Never log the text under review — log a hash prefix,
  decision, category, confidence, model, tokens and duration (source-generated, snake_case).
- **Output encoding stays at the sink** (UI/engine). Sanitizing the model's output is a bound, not an encoder.
- **Usage is auditable:** record model, tokens and purpose for every non-cached call, also when the request is
  rejected.

## Related skills

- `dotnet:observability` — OTel-native traces/metrics/logs, correlation/baggage, health probes, SLO/alerting (the logging pipeline that enforces this skill's redaction policy).
- `dotnet:validation` — DTO/serialization input limits, `InputLimits`, length-typed VOs.
- `dotnet:web-api` — endpoint/handler shape these policies attach to.
- `dotnet:ddd` — outbox/domain-event and module boundaries.
- `dotnet:csharp` — base idioms (records, monads, performance).
- `dotnet:testing` — how tests are written; the CI/Test Security gates here (coverage, Stryker, header/`429` snapshots) are exercised by that standard.
