---
name: csharp-hardening
description: Hardens ASP.NET Core services exposed to untrusted or multi-tenant traffic. Use when hardening a service, doing a security review, configuring middleware/`Program.cs`, or deploying. DTO-level input size/length limits belong to `csharp-validation`.
---

# Production Hardening (FAANG-level)

## Contents

- What we require
  - Tiered Rate Limiting & Burst Protection → `../csharp/references/setups/rate-limiting.md`
  - Idempotency
  - AuthN / AuthZ
  - Security Headers + CORS
  - Forwarded Headers / Real Client IP
  - Cryptography & Secrets
  - Error Handling → `yusufcirak-skills:csharp-validation`
  - Structured Logging & Audit → `yusufcirak-skills:csharp-observability`
  - Data access & Multi-Tenancy
  - File Upload → `yusufcirak-skills:csharp-validation`
  - SSRF Defense
  - XML / Deserialization Safety
  - Resilience (outbound calls) → `../csharp/references/resilience.md`
  - Transport, HTTP Caching & Application Caching → `../csharp/references/caching.md`
  - Background Jobs & Messaging → `yusufcirak-skills:csharp`
  - Cancellation, Timeouts & Shutdown → `yusufcirak-skills:csharp-observability`
  - API Versioning & Lifecycle
  - Dependency & Supply Chain
  - Observability → `yusufcirak-skills:csharp-observability`
  - CI / Test Security
  - LLM / Prompt-Injection Hardening
- .NET implementation
  - Idempotency filter
  - JWT bearer validation
  - Security headers and fallback policy
  - Forwarded headers
  - Secrets in configuration
  - ProblemDetails wiring
  - HTTP logging redaction
  - EF Core settings → `../csharp/references/ef-core-data-access.md`
  - SSRF handler
  - Transport middleware
  - Locks and dedup
  - Analyzers
- Related skills → `yusufcirak-skills:csharp-observability`, `yusufcirak-skills:csharp-validation`, `yusufcirak-skills:csharp-web-api`, `yusufcirak-skills:csharp-ddd`, `yusufcirak-skills:csharp`, `yusufcirak-skills:csharp-testing`

## Files

- `../csharp/references/resilience.md` — Resilience pipelines (single source of truth)
- `../csharp/references/setups/rate-limiting.md` — Setup: rate limiter registration and Redis backend
- `../csharp/references/caching.md` — Application caching — hybrid L1/L2 (shared reference)
- `../csharp/references/ef-core-data-access.md` — EF Core data access — performance & value-object persistence (single source of truth)
- `../csharp/references/value-object-base.md` — Value Object base type + converters (via nested link)
- `../csharp/references/strongly-typed-ids-and-value-objects.md` — Strongly-typed IDs & value objects (Vogen) (via nested link)
- `../csharp/references/build-and-analyzers.md` — Build & analyzers — gates and policy
- `../csharp/references/outbox-debezium-masstransit.md` — Outbox → Debezium → Kafka → MassTransit — the concrete traps
- `../csharp/references/mediator.md` — Mediator selection & licensing (via nested link)
- `yusufcirak-skills:csharp-validation` (`../csharp-validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
- `yusufcirak-skills:csharp-observability` (`../csharp-observability/SKILL.md`) — Observability (OpenTelemetry-native, FAANG-level)
- `yusufcirak-skills:csharp` (`../csharp/SKILL.md`) — C# House Style
- `yusufcirak-skills:csharp-web-api` (`../csharp-web-api/SKILL.md`) — ASP.NET Core Web API
- `yusufcirak-skills:csharp-ddd` (`../csharp-ddd/SKILL.md`) — .NET Domain-Driven Design & Architecture
- `yusufcirak-skills:csharp-testing` (`../csharp-testing/SKILL.md`) — C# Testing Standard

Deny by default, and bound everything an untrusted caller, tenant or dependency can influence: requests, identities, outbound calls, retries, caches and logs. These rules apply to any service exposed to untrusted networks or multi-tenant traffic. They are non-negotiable defaults; deviations need a written justification on the PR. The first half of this skill is what we require, whatever the framework. The second half is the ASP.NET Core code and configuration that enforces it. DTO and serialization input limits are owned by `csharp-validation`; this skill covers the network, runtime and ops surface.

## What we require

### Tiered Rate Limiting & Burst Protection

Rate limiting is **multi-dimensional**, **distributed** and **partitioned by principal plus endpoint**. A single global bucket is not enough.

- **Burst guard**: sliding window per `(userId, endpoint)`, default **20 req / 5 s**, no queueing. A burst beyond the window is rejected immediately and the offending principal is soft-banned on that endpoint for **60 s** (write the lock key into the same store the limiter uses).
- **Steady quota**: fixed window per user per hour. Reads 1 000/h, writes 200/h; tune per business need.
- **Concurrency cap**: max in-flight requests per user (default 10), so one principal cannot monopolise worker threads or DB connections.
- **Tier multiplier**: anonymous 0.25x, authenticated 1x, internal/service 5x. The privileged tier is asserted from a **trusted authentication scheme** (mTLS or an internal API-key scheme), never from a value the caller can place in its own JWT: a forgeable tier claim is both a rate-limit bypass and a privilege escalation.
- **Failed-auth lockout**: 5 failures in 10 min on login or token endpoints locks `(username, ip)` for 30 min (credential stuffing).
- **Partition key precedence:** authenticated user id (`sub`), then hashed API key id, then `hash(client IP)`. Never add `User-Agent` or any other caller-controlled header to the anonymous key: the caller can vary it per request and mint unlimited buckets. Behind a proxy use the forwarded-headers-resolved IP, never the raw `X-Forwarded-For`.
- **Partition on the matched route template, never the raw path.** Keying on `/items/1`, `/items/2`, ... multiplies the effective limit, a trivial bypass.
- **Backend:** in-memory is dev and single-instance only (behind a load balancer the limit is multiplied by N). Multi-instance prod needs a distributed store (Redis).
- **Fail open, not closed.** When Redis is unreachable, degrade to a per-node in-memory limiter rather than 429-ing every request, so a limiter outage never becomes a self-inflicted DoS. Emit a `ratelimit.fallback` counter so the degraded state is alertable.
- Budget the Redis round-trips: keep the ban lookup (`PTTL`) off the hot path with a local mirror, and front the Redis limiter with an equal-cap local limiter (a local reject never touches Redis).

Registration code, Redis backend, ban mirror and two-tier limiter: `../csharp/references/setups/rate-limiting.md`.

### Idempotency

- Idempotency is a **per-endpoint opt-in** (`.RequireIdempotency()` on the route or group), not a global middleware scanning every request. Only endpoints that can double-create or double-charge pay the cost.
- On an opted-in unsafe method (`POST`/`PUT`/`PATCH`/`DELETE`) a missing or over-long (more than 200 chars) `Idempotency-Key` returns 400. Safe methods pass through.
- **The cache key is scoped by caller** (`sub` or client IP, method, path, key). The key is client-chosen, so an unscoped key would let a caller replay a victim's stored response.
- Only a **2xx** response of at most **1 MB** is stored, so errors stay retryable. Stored for **24 h**. A hit replays status, content type and body and sets `Idempotency-Replayed: true`.
- No distributed cache registered: log a warning and run the handler (degrade, do not fail the request).
- This de-dupes **sequential** retries only; two truly concurrent requests with the same key both run. Upgrades not implemented here: store a body hash and answer a same-key/different-body replay with **409**, and an atomic reservation (`SET NX` before running the handler), or route such commands through `ILockRequest` (`csharp-web-api` → Pipeline behaviors).
- Inbound webhooks require an HMAC signature, `X-Timestamp` (reject if `|now - ts| > 5 min`) and a nonce store (24 h replay window).

### AuthN / AuthZ

- Access token TTL at most 15 min. Refresh token TTL at most 30 days with **rotation on every use**.
- **Refresh-token reuse detection:** presenting an already-rotated refresh token revokes the whole token family and forces re-login, the canonical defence against stolen refresh tokens.
- **Secure by default:** `[Authorize]` is the global fallback policy and `[AllowAnonymous]` is opt-in. It also covers unmatched routes, so an anonymous request to an unknown path returns **401, not 404** (route existence is not leaked). Health and docs endpoints are marked `AllowAnonymous`.
- **Resource-level authorization in the handler** (`IAuthorizationService.AuthorizeAsync(user, resource, policy)`). Endpoint-level `[Authorize(Policy=...)]` alone is insufficient for instance-scoped permission ("can edit *this* order").
- **Tenant id comes from a token claim**, never from route, query or body, exposed via `ICurrentTenant`.
- `mTLS` for service-to-service traffic inside the cluster.
- **Sign asymmetrically: ES256 (RS256 where a consumer needs it).** The issuer holds the private key and every API validates with the public key only (JWKS or a configured JWK/PEM). With HS256 every validating service holds the secret that can mint tokens, so one compromised service forges tokens for all. Symmetric signing is acceptable only when issuer and validator are the same process in dev/test. The private key comes from the secret store, never `appsettings` or the repo; an issuing service publishes its public keys at `/.well-known/jwks.json`.
- **Pin the algorithm** (`ES256`) so a token cannot downgrade to `none`, or to an HMAC verified with the public key as the secret (algorithm confusion).
- **Rotate keys with `kid`:** sign with the current key and stamp its `kid`. Keep retired public keys validation-only for at least the access-token TTL plus clock skew, then drop them. Publish a new key in the JWKS before signing with it. Resolve the validation key by `kid`, never by trying every key.
- **Validate everything:** issuer, audience, lifetime, signature, required signed tokens and expiration, with a tight clock skew (30 s; the 5-minute default keeps expired tokens alive far too long).
- **Revocation check on every request** by `jti`. The blacklist **fails open** on a Redis error (log a warning, treat as not revoked): deliberate, availability over strict revocation. `ISensitiveRequest` commands re-run the check at handler time (`csharp-web-api` → Pipeline behaviors).
- **Scope authorization:** read OAuth scopes from both conventions (a space-delimited `scope` claim and repeated `scp` claims) and expose a `.RequireScope("orders:write")` helper in the same style as `.RequireIdempotency()`. Roles use the native `RequireRole`.
- **401/403 are problem+json** (RFC 9457) from the same writer as the global handler (same `traceId` / `correlation_id` stamping), with `WWW-Authenticate` on challenge. Never leak token-validation specifics to the caller; detail lives in traces and logs.
- **Keep the token small; load volatile or high-cardinality claims per request.** A token re-issued every 15 min goes stale the moment group or role membership changes, and growing group lists bloat every `Authorization` header. The JWT carries only the stable identity (`sub`, core roles); derived authorization data is appended after authentication from a fast cache-backed lookup, so it is never stale for the token's lifetime.

### Security Headers + CORS

- Every response carries: `Strict-Transport-Security` (2 years, includeSubDomains, preload), a restrictive `Content-Security-Policy` (`default-src 'none'; frame-ancestors 'none'; base-uri 'none'` for APIs), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a `Permissions-Policy` that disables geolocation, camera and microphone, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` of `same-origin`. The `Server` header is removed.
- CORS uses an explicit `WithOrigins(...)` list. `AllowAnyOrigin()` combined with `AllowCredentials()` is **forbidden** (browsers reject it and it signals misconfiguration). **Deny by default:** with no origins configured the policy allows nothing; never widen to `AllowAnyOrigin` as an empty-config fallback.

### Forwarded Headers / Real Client IP

Behind a load balancer or ingress, `RemoteIpAddress` is the proxy, not the client, which silently breaks rate-limit partitioning, `client_ip` in audit and logs, and any IP allowlist. Forwarded-header handling runs **first** in the pipeline, before anything reads the IP or scheme.

- **Anti-spoofing:** trust `X-Forwarded-For` and `-Proto` only from explicitly configured proxies (`KnownProxies` / `KnownIPNetworks`, renamed from `KnownNetworks` in .NET 10). Outside Development, if none are configured the headers are **ignored** rather than blindly trusted, because an attacker must not be able to forge their own client IP. In Development keep the framework default (loopback trusted) so local tooling works.

### Cryptography & Secrets

- Password hashing: **Argon2id** (preferred) or **bcrypt cost 12 or higher**. PBKDF2 only when FIPS-required (600 000 iterations or more, SHA-256).
- General hashing: SHA-256 or SHA-3. `MD5`, `SHA1`, `DES` and `RC4` are **forbidden** outside legacy interop.
- Random tokens and nonces: `RandomNumberGenerator.GetBytes(32)`. `System.Random` is **forbidden** for any security-sensitive value.
- Secret comparison (HMAC, tokens): `CryptographicOperations.FixedTimeEquals`, never `==` or `SequenceEqual`.
- Secrets come from a managed store (Azure Key Vault, AWS Secrets Manager, HashiCorp Vault). Plain secrets in committed `appsettings.*.json` are **forbidden**.
- When a value must live in config anyway (connection strings, dev signing keys), store it **encrypted** and decrypt at the configuration layer, so no consumer ever sees ciphertext and no code path reads a plain secret file. Fail fast on a value that will not decrypt, naming the key; never pass ciphertext or a half-processed value to a consumer. Mechanics: see Secrets in configuration below.

### Error Handling

- All errors are RFC 9457 `application/problem+json` (the current problem-details RFC, superseding 7807), handler-produced and framework-produced (404, 400 model binding, 415) alike, so every error payload looks identical and is traceable.
- Every problem response carries `traceId`, `correlation_id` and `instance` (the path). In production the body is title, status, traceId and correlation_id; stack traces and inner exception detail go to logs only. Never let DB or framework messages leak.
- Map known cases: a failed `Result` carrying `ValidationError` becomes a 400 `ValidationProblemDetails` (field to errors) through the single Result-to-HTTP mapper, not an exception (see `csharp-validation` → Validators run in the pipeline). Any other `Error` becomes a `Problem` with its own status. **Client abort** (cancellation after the client disconnected) is **499**, not 500. `BadHttpRequestException` keeps its own status.

### Structured Logging & Audit

- Logging mechanics live in `csharp-observability`. This section owns the **redaction policy** that pipeline must enforce. Every line carries `trace_id`, `correlation_id`, `user_id`, `route`.
- **Never log** passwords, tokens, `Authorization` / `Cookie` headers, full request/response bodies or full PII. Header logging is an **allow-list** of known-safe headers; bodies are off in Production.
- **Query strings leak secrets** (OAuth `code` / `access_token`, signed-URL `sig`, `api_key`). Never log the raw query wholesale: redact sensitive parameter values (keep names and safe values, mask the rest to `***`).
- **Audit log** in a separate, append-only sink (ideally signed): auth events (login, logout, failure), role and permission changes, data export, money movement, admin actions.

### Data access & Multi-Tenancy

- **No raw SQL built by string concatenation.** Use parameterised queries or no raw SQL.
- Command timeouts: read paths 10 s, write paths 30 s. Connection pool sized, mirrored by DB-side `statement_timeout` and `idle_in_transaction_session_timeout`.
- Tenant id flow: token claim, then `ICurrentTenant`, then the query filter, then repository or handler. Soft-delete and tenant are global query filters; bypassing a filter requires a written justification plus an audit entry.
- Cross-tenant handlers (admin tooling) require an explicit `[CrossTenant]` marker plus an audit-log entry on every call.
- Defence in depth: row-level security at the database (Postgres RLS, SQL Server security predicates) in addition to the query filter. Never rely on the app layer alone.

### File Upload

- Validate **magic bytes**, not extension or `Content-Type` (both client-controlled), and allowlist content types; reject everything else.
- AV scan (ClamAV, Defender) in the upload pipeline; quarantine on a positive.
- Store outside the webroot with a server-generated filename; never echo the client filename in URLs.
- Re-encode images server-side to strip EXIF and defuse decompression bombs (pixel-count cap).
- Per-upload size limit via `[RequestSizeLimit]` (see `csharp-validation` → Serialization and request-size limits).

### SSRF Defense

- Outbound calls go through a handler that resolves the host and rejects private and special ranges: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (cloud metadata), `::1`, `fc00::/7`.
- DNS rebinding protection: resolve once and pin the IP for the duration of the call.
- Connect and total timeouts are mandatory (default 5 s connect, 30 s total).
- No automatic redirects, or constrain them to the same origin.

### XML / Deserialization Safety

- XML: `XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null }`.
- `BinaryFormatter`, `SoapFormatter`, `NetDataContractSerializer` and `LosFormatter` are **forbidden** (RCE class). Use `System.Text.Json` or `MessagePack` with explicit contracts.
- If Newtonsoft.Json must be used: `TypeNameHandling = None`, never `Auto`, `All` or `Objects`.

### Resilience (outbound calls)

Every outbound call uses a typed `IHttpClientFactory` client (`yusufcirak-skills:csharp` → Outbound HTTP: never a per-call or `static` `HttpClient`) that carries a Polly v8 resilience pipeline. Do not hand-roll retry or timeout. Default to `AddStandardResilienceHandler()`; custom pipelines order strategies outer to inner. Retry only idempotent calls, jitter is mandatory, and the SSRF handler composes **inside** the pipeline. Full rules, ordering and chaos testing: `../csharp/references/resilience.md`.

### Transport, HTTP Caching & Application Caching

- **Request decompression** runs early, before the body is read, and the decompressed stream stays bounded by the server's max body size: that cap is the decompression-bomb defence.
- **Response compression** uses Brotli and gzip but is off over HTTPS by default: compressing secret-bearing responses over TLS enables the **BREACH** attack. Opt in per response where safe.
- **HTTP caching:** authenticated responses default to `Cache-Control: no-store`; `Vary: Authorization` on anything that varies per user; `ETag` for conditional GET on read-heavy public endpoints. Never output-cache authenticated or user-varying responses.
- **Application caching:** do not hand-roll a cache or run a bare `IDistributedCache`. Default to a hybrid L1 (in-process) plus L2 (Redis) cache with stampede protection, fail-safe stale-serving and cross-node invalidation. Rules and library pick: `../csharp/references/caching.md`.

### Background Jobs & Messaging

- **Handlers are idempotent.** Persist a `(message_id, consumer)` unique row in the same transaction as the handler's state change and treat a unique-violation on insert (`SQLSTATE 23505`, provider-agnostic via `DbException.SqlState`) as an idempotent no-op, not an error to retry into a poison loop.
- **The dedup key is deterministic when the message derives from stable content** (reprocessing the same source record, reacting to the same upstream event). A random id per publish defeats dedup: two publishes of the same logical event get different ids and both pass the unique-row check. Hash the stable identifying content into a deterministic id and use it as the `MessageId` the dedup keys on. Reserve `Guid.CreateVersion7()` (see `csharp`) for ids that must be unique per occurrence. The two solve opposite problems.
- Retry with exponential backoff and jitter, bounded attempts (default 5). Poison messages go to a DLQ; alert on DLQ depth.
- Cross-aggregate writes use the **Outbox pattern**, never a dual write to DB and broker. Concrete Debezium, MassTransit and polling-relay traps: `../csharp/references/outbox-debezium-masstransit.md`.
- **Distributed lock** (single-flight job, one-migrator-at-a-time): use a library, never a hand-rolled Lua lock. Take it non-blocking, so the caller skips instead of queueing. The handle auto-renews its TTL while held and releases on dispose, so the TTL only bounds crash recovery. A lock on a single Redis database is not safe across a failover: treat it as an efficiency guard and keep the guarded work idempotent (fencing token or unique constraint) for correctness.
- This section owns distributed and broker reliability. For a purely in-process producer/consumer queue use the `Channels` + `BackgroundService` primitive in `csharp` → Background work & channels.

### Cancellation, Timeouts & Shutdown

- Every handler signature accepts `CancellationToken` and propagates it (`DbContext`, `HttpClient`, downstream calls). Handlers that ignore the token are blocked in review.
- Per-request timeout: 30 s default, lower for read paths.
- Graceful shutdown drains in-flight work, with the host `ShutdownTimeout` greater than the drain budget, paired with a readiness check that flips Unhealthy at shutdown so the load balancer drains first (see `csharp-observability` → Health & probes).

### API Versioning & Lifecycle

- `/v1/`, `/v2/` URL versioning **or** an `Api-Version` header: pick one and keep it across all services.
- Deprecation: emit `Deprecation: true` and `Sunset: <RFC1123-date>` headers on legacy versions.
- A per-endpoint kill switch via feature flag (`IFeatureManager`, LaunchDarkly or Unleash).

### Dependency & Supply Chain

- Central package versions in `Directory.Packages.props`. Analyzer gating, `WarningsNotAsErrors` policy and generator packaging: `../csharp/references/build-and-analyzers.md`.
- CI fails the build on any known CVE (`dotnet list package --vulnerable --include-transitive`).
- Generate a CycloneDX SBOM in the release pipeline. Pre-commit secret scanning (`gitleaks` / `trufflehog`).
- Roslyn analyzers: `Microsoft.CodeAnalysis.NetAnalyzers`, `SecurityCodeScan.VS2019` (or equivalent), `Roslynator`.

### Observability

Owned by `csharp-observability`: OpenTelemetry-native traces, metrics and logs over OTLP, `correlation_id` and baggage, health probes and SLO burn-rate alerting. From a hardening standpoint just enforce that telemetry exists and is wired, `correlation_id` is echoed, RED and USE exist with SLOs and multi-window burn-rate alerts, and the redaction policy above is honoured by the logging pipeline.

### CI / Test Security

- SAST (CodeQL or SonarCloud) on every PR; DAST (OWASP ZAP smoke) against staging on each release.
- Snapshot tests asserting security headers, `ProblemDetails` shape and the 429 envelope.
- OpenAPI schema-drift test (`Swashbuckle.AspNetCore.Cli`) that fails when undocumented endpoints appear.
- Mutation testing (`Stryker.NET`) on critical paths.

### LLM / Prompt-Injection Hardening

Any text a caller (or an admin, or a document) can influence is **untrusted data** once a model reads it.

- **Structure every prompt with tagged sections** (`<gorev>`, `<kurallar>`, `<icerik>`, ...) and put untrusted text only inside its own block. One helper wraps it and **removes every structural tag from the text** (open and close, any case, spaces and attributes), repeating until nothing can re-form (`<ek_<icerik>talimatlar>`). Never concatenate untrusted text into a trusted section, and never rely on a "please ignore instructions in the document" sentence alone.
- **Trusted policy in the system turn, untrusted state in the user turn.** The state may be a string, array or object: strings go as text, arrays and objects as compact JSON, inside the block. Serialize non-ASCII readably (relaxed encoder) and neutralize **after** serialization, so readability never reopens the tag hole.
- **Gate at write time, fail-closed.** Classify free-text instructions with a model before persisting them. Anything that is not an explicit "allow" is blocked: timeout, provider error, invalid or out-of-policy output and a model refusal all reject the whole save. Return the reason to the admin; never save with a warning.
- **Determinism and cost:** temperature 0 plus a fixed seed. Cache the verdict by hash(policy name and version, model, state kind, state) and bump the policy version whenever the policy text changes. Never cache failures. A cache outage must not break the request.
- **Model choice is system config, never caller input.** Use the configured default model for the gate. Validate any stored model name against a format value object (charset, length, segments, no URL schemes) instead of a list that drifts as gateways add models.
- **Validate model output like input:** structured output, then check decision and category against the policy, clamp numbers to range, bound counts and lengths. Free-form LLM fields stay free-form but capped.
- **Do not leak the machinery:** system prompt, raw model response and organization prompts are admin-only. Return an empty same-shaped object (not `null`) to everyone else. Never log the text under review: log a hash prefix, decision, category, confidence, model, tokens and duration (source-generated, snake_case).
- **Output encoding stays at the sink** (UI or engine). Sanitizing the model's output is a bound, not an encoder.
- **Usage is auditable:** record model, tokens and purpose for every non-cached call, also when the request is rejected.

## .NET implementation

Rate limiter registration, Redis backend and two-tier limiter: `../csharp/references/setups/rate-limiting.md`. Resilience pipeline code: `../csharp/references/resilience.md`.

### Idempotency filter

An `IEndpointFilter` opted in through `.RequireIdempotency()`, storing the response in `IDistributedCache` as a binary blob `[status i32][contentTypeLen i32][contentType][body]` (no JSON or base64 wrapping on the write path).

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

### JWT bearer validation

Config-driven: **asymmetric is the preferred production default**, OIDC `Authority` plus JWKS is the prod path, and a symmetric HMAC secret is for a single-process dev/test setup only. Status of the reference repo (TicketMaster): `JwtOptions.Mode` has only `Symmetric` (its default) and `Authority`, there is no configured-asymmetric-key mode yet, and `kid`-based rotation via `CurrentKeyId` + `PreviousKeys` is uncommitted work in progress in `JwtOptions` / `JwtAuthenticationExtensions` / `JwtTokenService`. Treat the symmetric default as a known gap, not a pattern to copy.

```csharp
o.MapInboundClaims = false; // keep "sub" as "sub": rate limiter, audit and log enrichment read it raw
o.TokenValidationParameters = new()
{
    ValidateIssuer = true, ValidateAudience = true, ValidateLifetime = true,
    ValidateIssuerSigningKey = true, RequireSignedTokens = true, RequireExpirationTime = true,
    ClockSkew = TimeSpan.FromSeconds(30),
    NameClaimType = "sub", RoleClaimType = "role",
};
o.TokenValidationParameters.ValidAlgorithms = ["ES256"];
o.TokenValidationParameters.IssuerSigningKeyResolver = (_, _, kid, _) => keyStore.ForKid(kid); // current + previous public keys
```

- **Revocation:** `JwtBearerEvents.OnTokenValidated` reads `jti` and calls `ITokenBlacklist.IsRevokedAsync(jti)` (`RedisTokenBlacklist`: `revoked:{jti}` with TTL equal to the remaining token lifetime); on a hit `context.Fail("token_revoked")`. It fails open on a Redis error.
- **Scopes:** a `.RequireScope(...)` helper is a policy plus an `IAuthorizationHandler`. Roles use `.RequireAuthorization(p => p.RequireRole(...))`.
- **Problem responses:** wire `JwtBearerEvents.OnChallenge` (401) and `OnForbidden` (403) to write `ProblemDetails` through `IProblemDetailsService`; set `WWW-Authenticate` on challenge; `OnAuthenticationFailed` stays silent in prod.
- **Per-request claims:** an `IClaimsTransformation` registered after `AddAuthentication()` runs on every authenticated request (not just login), so keep its lookup cache-backed, never a cold DB hit.

```csharp
public sealed class GroupClaimsTransformation(IGroupLookupService groups) : IClaimsTransformation
{
    public async Task<ClaimsPrincipal> TransformAsync(ClaimsPrincipal principal)
    {
        if (principal.Identity is not { IsAuthenticated: true }) return principal;
        var userGroupIds = principal.Claims.Where(c => c.Type == ClaimTypes.GroupSid).Select(c => c.Value);
        var resolved = await groups.GetGroupsAsync(userGroupIds); // cache-backed, see caching.md
        var identity = new ClaimsIdentity(resolved.Select(g => new Claim("group", g.Id.ToString())));
        principal.AddIdentity(identity);
        return principal;
    }
}
builder.Services.AddTransient<IClaimsTransformation, GroupClaimsTransformation>();
```

### Security headers and fallback policy

```csharp
builder.Services.AddAuthorizationBuilder()
    .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());

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

### Forwarded headers

`UseForwardedHeaders()` must run first in the pipeline.

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

### Secrets in configuration

- Values prefixed `secret:` are decrypted by a **wrapping `IConfigurationProvider`**. `AddSecretConfiguration()` is called after every other source, builds the sources added so far into an inner root and replaces them with one provider that reads through the inner and decrypts on the way out. It subscribes to the inner reload token, so a changed appsettings file, refreshed Key Vault source or rotated secret is re-decrypted and `IOptionsMonitor` consumers get a change notification.
- Crypto is **AES-256-GCM** (nonce 12 | tag 16 | ciphertext, base64). The AES key is derived with HKDF-SHA256 from out-of-band key material (`CONFIG_SECRET_KEY` env var) plus a fixed app salt, so a leaked env var alone cannot decrypt.
- The key is resolved lazily (`Lazy<IEncryptionProvider>`), only when a `secret:` value is actually decrypted, so dev setups with no secrets need no key.
- A value that will not decrypt throws `InvalidOperationException` naming the key.
- Tests set the key material once in a `[ModuleInitializer]` (`Environment.SetEnvironmentVariable("CONFIG_SECRET_KEY", ...)`) so every fixture decrypts the same way.

### ProblemDetails wiring

A global `IExceptionHandler` plus `AddProblemDetails`, with `CustomizeProblemDetails` stamping `traceId` (`Activity.Current?.TraceId.ToString()`), `correlation_id` and `instance` on every problem response, handler-produced and framework-produced alike.

### HTTP logging redaction

`HttpLoggingFields.RequestQuery` logs the raw query. Never enable it wholesale: log the query through an `IHttpLoggingInterceptor` that redacts sensitive parameter values.

### EF Core settings

- `FromSqlInterpolated` (parameterised), never `FromSqlRaw` with concatenation.
- Command timeouts configured in the `DbContext` options (read 10 s, write 30 s).
- The `DbContext` defaults to no-tracking plus split query (`../csharp/references/ef-core-data-access.md` → DbContext defaults). Write paths opt in with `.AsTracking()`, and `AsNoTrackingWithIdentityResolution` fits where dedupe matters.
- `.IgnoreQueryFilters()` needs a written justification plus an audit entry.

### SSRF handler

Register the outbound `HttpClient` with a `DelegatingHandler` that resolves the host and rejects blocked ranges, and set `AllowAutoRedirect = false` on the primary handler (or constrain redirects to the same origin).

### Transport middleware

- `AddRequestDecompression()` plus `UseRequestDecompression()` early, before the body is read, so clients may send `Content-Encoding: br/gzip/deflate`. The decompressed stream stays bounded by Kestrel `MaxRequestBodySize`.
- Response compression with `EnableForHttps = false`.
- `AddOutputCache` for cacheable GETs only.

### Locks and dedup

- Distributed lock: a library such as Medallion `DistributedLock.Redis`, taken non-blocking with `TryAcquireAsync(TimeSpan.Zero)` (returns `null` when held).
- Dedup: read `DbException.SqlState` for `23505`.
- Deterministic message ids: a fast non-cryptographic hash (for example FNV-1a over the content) folded into a `Guid`.

### Analyzers

In `Directory.Build.props`:

```xml
<TreatWarningsAsErrors>true</TreatWarningsAsErrors>
<AnalysisLevel>latest</AnalysisLevel>
<AnalysisMode>All</AnalysisMode>
```

## Related skills

- `yusufcirak-skills:csharp-observability` — OTel-native traces/metrics/logs, correlation/baggage, health probes, SLO/alerting (the logging pipeline that enforces this skill's redaction policy).
- `yusufcirak-skills:csharp-validation` — DTO/serialization input limits, `InputLimits`, length-typed VOs.
- `yusufcirak-skills:csharp-web-api` — endpoint/handler shape these policies attach to.
- `yusufcirak-skills:csharp-ddd` — outbox/domain-event and module boundaries.
- `yusufcirak-skills:csharp` — base idioms (records, monads, performance).
- `yusufcirak-skills:csharp-testing` — how tests are written; the CI/Test Security gates here (coverage, Stryker, header/`429` snapshots) are exercised by that standard.
