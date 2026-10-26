---
metadata:
  file: api-surface.md
  sections:
    - {title: "1. When this applies", start: 19, end: 24}
    - {title: "2. Principles", start: 26, end: 32}
    - {title: "3. Design", start: 34, end: 103}
    - {title: "4. Traps", start: 105, end: 114}
    - {title: "5. Invariants to test", start: 116, end: 122}
    - {title: "6. Rationalizations / Red flags", start: 124, end: 133}
    - {title: "7. Checklist", start: 135, end: 142}
---
# API Surface

> **Golden path:** Declare cross-cutting policy on the route, version from day one, clamp pagination at the boundary, and keep one documented middleware order.

Extends the installed `api-and-interface-design` skill (Hyrum's Law, contract first, one error shape, additive change, idempotency-key contract). Read that first; this file does not repeat it. Error mapping details are in `error-model.md`.

## 1. When this applies

- Choosing a versioning, pagination or feature-flag approach.
- Declaring per-route policy (idempotency, rate limit, scope, log control, anonymous).
- Ordering middleware or pipeline stages, or adding a new stage that reads request state.
- Reviewing an endpoint group for exposure mistakes.

## 2. Principles

1. **The transport layer only translates:** bind input, send the use case, map the result. Business decisions and cross-cutting policy do not live in handlers.
2. **Cross-cutting policy is declared on the route, not hidden in middleware.** A reader of the route table can see which endpoints are idempotent, limited, scoped, quiet or anonymous.
3. **Middleware order is a dependency graph.** A stage that reads state must come after the stage that sets it, and a mistake produces silent wrong behavior, not an error.
4. **Bound every list.** Page size is clamped at the boundary; order before paging.
5. **Version early and visibly; flag minimally.**

## 3. Design

### Versioning `[shipped]`

Default version 1 is assumed when the client says nothing. A client selects a version by URL segment or an `X-Api-Version` header. Supported versions are reported in responses. Remove nothing in a live version; add optional fields (see the sibling skill).

### Feature flags `[shipped]`

Section-driven configuration with a standard feature-management library. Keep it minimal: flags gate rollout and are removed after rollout. There is nothing hard-won here beyond "delete the flag".

### Pagination contract `[shipped]`

```
request:  page < 1 -> 1
          size < 1 -> default (20); size > 200 -> 200; otherwise as given
          read from the query string via an ambient request accessor,
          so handlers and queries carry no page parameter
response: { items (streamed), page, page_size, total }   # one count query plus one page query
rule:     ORDER BY before skip/take, always
```

Clamping replaces validation: a hostile size is reduced to the maximum, an empty or non-positive size falls back to the default (not to 1), and a page below 1 becomes 1. Items are streamed rather than materialized into a list. Caching (`caching.md`) is a separate decision from paging: do not cache unscoped page results for principal-specific data.

**Keyset (cursor) pagination is the scalable alternative** and was built then reverted in the reference `[known gap]`: the ORM could not translate an order or filter reaching into a strongly-typed id wrapper inside a DTO projection; only anonymous-type projections translated. Lesson: apply the keyset filter and ordering on the entity before projecting, and project the id property itself, not its unwrapped value. Leftover comparison operators on the id type are residue of that attempt.

### Route-level opt-ins `[shipped]`

```
route.require_idempotency()      # replay stored response for a repeated key (caller-scoped)
route.require_api_rate_limit()   # health and docs untouched
route.require_scope("x")         # reads both "scope" and "scp" claims
route.require_authorization()
route.allow_anonymous()
route.log_without_body()
route.suppress_logging()         # health probes
```

Policies are composed from route metadata, so the pipeline itself stays generic and the route table documents behavior.

### Pipeline order and why `[shipped]`

This is the single home of the pipeline order; other references link here instead of repeating it.

```
1  forwarded headers      real client IP and scheme for everything below; trust only known proxies
2  security headers       applied to every response, including errors
3  request decompression, response compression (compression off over TLS: BREACH)
4  log sampling           must wrap the stages whose logs it buffers
5  exception handler      so errors from later stages become problem responses
6  correlation            id must exist before anything logs
7  routing                matched route template is needed by timeouts, limits, policies
8  request timeouts       per endpoint, after routing
9  CORS                   deny by default
10 authentication
11 user enrichment        user id and client IP into ambient context (needs principal)
12 tenant resolution      after authentication, before authorization
13 authorization
14 output cache           after authorization so cached bodies are not served across principals
15 HTTP logging           so it sees the matched endpoint's policy and the final response
16 rate limiting          registered by the host AFTER the shared defaults; needs the principal (after
                          authentication) and the matched route template (after routing)
```

`[known gap]` In the reference system the rate limiter is registered by the host after the shared defaults, so it sits after the output cache: a cache hit is served without being counted. Either move the limiter before the output cache (it only needs authentication and routing), or accept that cached responses are unmetered and say so. The reference's host comment says the limiter runs "after correlation so 429s carry the correlation id", which is satisfied by either position.

`[proposed]` Guard order-sensitive stages at startup (fail fast if a prerequisite stage was never registered) rather than relying on review. The reference system has no such check.

### Problem details extras `[shipped]`

One customizer stamps `instance`, `traceId` and `correlation_id` on every problem response, including framework-generated ones. Domain error codes surface as a `code` extension. Details of 5xx are hidden in production. If the response has already started, let the connection reset rather than corrupt the body.

## 4. Traps

- **Anonymous group on a tenant-scoped resource** (a demo convenience): tenant then comes from a client-controlled header, so any caller picks any tenant. Restrict before production `[known gap]`.
- **Rate limiter before authentication** sees an anonymous principal for everyone (generic hazard; the reference avoids it).
- **Rate limiter after the output cache** leaves cached hits uncounted: a hot cached route can be hammered without ever hitting a limit. Place the limiter ahead of any stage that can answer without reaching the endpoint.
- **A stage that reads request state registered too early** silently sees defaults; add a startup prerequisite check `[proposed]`.
- **Unordered paging** is non-deterministic; unbounded size is a denial-of-service lever.
- **Registry read before the container is built** (module endpoint mapping) must follow module registration.
- **Compression over TLS** exposes secrets to BREACH; leave response compression off over HTTPS.
- **Client-disconnect cancellations** should map to a 499-style outcome, not an error log.

## 5. Invariants to test

- Route-level: repeat idempotency key does not rerun the handler and sets a replay header; the 6th anonymous request is 429 with `Retry-After`.
- Unit: page size above 200 clamps to 200, size below 1 becomes the default (20), page below 1 becomes 1; scope policy accepts both claim names.
- Pipeline `[proposed]`: a test asserts the registered stage sequence; a startup check fails when authentication is missing for a stage that needs it. The reference system has only per-middleware unit tests, no sequence test.
- A request answered from the output cache still decrements the rate-limit budget (or the gap is documented).
- Every error response, framework-generated included, carries `traceId`.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "Put it in middleware, it applies to all" | Then nobody can see which routes are affected. Declare on the route. |
| "We will version when we need to" | Breaking changes then break consumers. Default v1 now. |
| "Paging is just skip and take" | Unordered or unclamped is a bug and an attack surface. |
| "Anonymous for the demo" | Demos become production. |

Red flags: list endpoint without a size cap; policy implemented as a global middleware with route exclusions; a new stage inserted without a prerequisite check; framework-default error body on some paths.

## 7. Checklist

- [ ] Default version assumed; versions reported.
- [ ] Page size clamped (below 1 -> default, above 200 -> 200), ordered, total from one count query.
- [ ] Policies declared as route opt-ins; health and docs excluded from limits and logging.
- [ ] Pipeline order matches the list above; the limiter is ahead of any stage that can short-circuit; order-sensitive stages guard their prerequisites.
- [ ] Every problem response carries instance, traceId, correlation id.
- [ ] No anonymous group over tenant-scoped data.
