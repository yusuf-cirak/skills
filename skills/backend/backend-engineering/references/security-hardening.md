---
metadata:
  file: security-hardening.md
  sections:
    - {title: "1. When this applies", start: 17, end: 22}
    - {title: "2. Principles", start: 24, end: 32}
    - {title: "3. Design", start: 34, end: 112}
    - {title: "4. Traps", start: 114, end: 128}
    - {title: "5. Invariants to test", start: 130, end: 139}
    - {title: "6. Rationalizations / Red flags", start: 141, end: 151}
    - {title: "7. Checklist", start: 153, end: 167}
---
# Security Hardening

> **Golden path:** Deny by default, validate issuer, audience, lifetime and signature with tight skew, keep a revocation path, trust proxy headers only from known proxies, and mask logs by key name.

## 1. When this applies

- Building or reviewing the edge of a service: headers, CORS, proxies, compression, request parsing.
- Configuring authentication or authorization, issuing or validating tokens, handling revocation.
- Deciding what may be logged, echoed, or returned in an error.
- Adding a credential type (API key, internal service identity) or a new tier.

## 2. Principles

1. **Deny by default.** No anonymous route unless marked; no CORS origin unless listed; no forwarded header unless from a known proxy.
2. **Trust a value only from the party entitled to assert it.** A tier claim is not trusted because a token carries it; the authentication scheme that produced the identity decides.
3. **Validate everything a token claims**: issuer, audience, lifetime, signature, algorithm. Keep clock skew tight.
4. **Asymmetric signing is the default.** Whoever validates a token must not be able to mint one.
5. **Every revocation path has a named failure mode.** Decide fail-open or fail-closed and test it.
6. **Never leak the reason.** Validation failures return a generic problem body; details go to traces.
7. **Redact by key name, not by guessing at values.** Allow-list what you log.

## 3. Design

### Edge hardening `[shipped]`

- **Security headers on every response:** frame denial, no content-type sniffing, strict referrer policy, transport-security with subdomains, a content-security policy of self only with frame-ancestors none and upgrade-insecure-requests, and removal of the server banner.
- **CORS deny by default.** Only origins in configuration are allowed. An empty configuration allows nothing; never widen to "any origin" as a fallback, and never combine "any origin" with credentials.
- **Forwarded headers:** trust them only from explicitly configured proxies, for one hop. Outside development, when no proxies are configured, ignore the headers. Process them first in the pipeline, before anything reads the client address or scheme. If this is wrong the rate limiter either shares one bucket for all clients (self-DoS) or can be evaded with a forged header.
- **Compression:** response compression is off over TLS (compressing secret-bearing responses enables the BREACH attack); opt in per response where safe. Request decompression is on but bounded by the maximum request body size; that cap is the decompression-bomb defence.
- **JSON strictness:** maximum depth 32, unknown members rejected with 400, enums as strings, camel- or snake-case set once globally. Precompiled serializer metadata is a performance choice that must not change these semantics.
- **Pipeline order is part of the contract.** The authoritative list, including why each stage sits where it does and the rate-limiter-after-output-cache gap, is in `api-surface.md`. Security-relevant constraints only: forwarded headers first, security headers outermost, authentication before anything that reads the principal, tenant resolution after authentication and before authorization.

### Authentication `[shipped]` with gaps

```
validate(token):
   require signature, expiry
   issuer == expected; audience == expected; lifetime valid (skew 30 s)
   algorithm in ALLOWED            # pinned, never "none", never an HMAC checked with a public key
   key = lookup(kid)               # current + previous keys; rotate by kid
   keep claims raw (no remapping of "sub" to a framework type)
```

- **Modes:** authority (JWKS discovery) for production, a shared secret only for a single-process development or test setup, selected by configuration.
- **Recommended default: asymmetric (for example ES256) with an explicitly pinned algorithm list.** `[known gap]` The reference system's committed options default to the symmetric mode and do not pin algorithms; the guidance above is the intended direction, not shipped behavior.
- `[known gap]` A symmetric key's length (at least 32 bytes for HS256) is not validated at startup, only its presence. Validate length at startup.
- `[proposed]` Key rotation via a previous-keys list (validation-only keys kept for the access-token lifetime plus skew, new key published before it signs). This is uncommitted work in the reference system: every key is tagged with its `kid` and the token service stamps the `kid` header, but the validation library falls back to trying every key when no `kid` matches. Guidance: tag keys with `kid`, resolve by `kid`, and disable the try-every-key fallback so a rotation mistake fails loudly instead of validating against the wrong key.
- **Default and fallback policy is "authenticated user".** Endpoints opt out explicitly. As a consequence an unauthenticated request to an unknown route gets 401, not 404, so route existence is not leaked.
- **401 and 403 are problem bodies** with correlation and trace ids; failure detail is suppressed.
- **Scope authorization** reads both conventions: a space-delimited `scope` claim and repeated `scp` claims. Expose it as a route-level opt-in (`require scope "x"`).
- **Keep tokens small.** Stable identity in the token; volatile or growing authorization data (group membership) is loaded per request from a cached lookup so it is never stale for the token lifetime.
- **Tiers and trust.** An identity may claim a privileged tier only when produced by a trusted internal scheme. `[known gap]` In the reference system that scheme is referenced but not registered, so the internal tier is dormant.
- Tenant identity belongs to the token, not the request body. `[known gap]` The reference system currently accepts a client-supplied tenant header as the only working resolver; restrict it to trusted callers before production (see `multi-tenancy.md`).

### Revocation and sessions `[shipped]`

- Access tokens are short-lived (15 minutes or less). A revocation list of token ids (`jti`) is consulted when the token is validated. The list **fails open** on store error; this is a deliberate, documented choice that pairs with short lifetimes. The full fail-open / fail-closed table lives in `resilience-lifecycle.md`.
- Requests marked sensitive re-verify the caller and the revocation list inside the use-case pipeline, independent of the middleware (infrastructure present in the reference system; no module request uses the marker yet).
- Refresh tokens are stored as hashes and rotate on every use: the presented token is revoked and records its replacement's hash. `[shipped]` Load-modify-save of token state must use explicit tracking in ORMs that default to no-tracking, or the revocation silently does not persist (`persistence-migrations.md`).
- `[known gap]` **Reuse detection.** Guidance (not reference behavior): presenting an already-rotated refresh token signals theft, so revoke the whole token family for that user and force re-login. The reference system stores the replacement hash but never reads it; a rotated or revoked token simply returns the generic invalid-credentials failure and no family is revoked.
- **Failed-login lockout** `[shipped]`: 5 failed attempts lock the account for 15 minutes; refresh also refuses a locked-out user. Lockout is per account, so pair it with the per-IP rate limit (`rate-limiting-load-shedding.md`) or a targeted lockout becomes a denial-of-service lever against a known username.

### Credentials and addresses

- **API keys elevate only when on an allow-list**, and are hashed before use as a key. Unknown keys are treated as anonymous by address.
- **Client address for audit.** Use the address the forwarded-headers middleware resolved. `[known gap]` The reference system has an audit helper (used by login and refresh) that reads the raw forwarded header unconditionally; it is spoofable and should use the resolved address like the rate limiter does.
- **Correlation id echo.** Accept an inbound correlation id only if it parses as a UUID, normalize it, and echo it back. Echoing an arbitrary inbound value into a response header is a header-injection vector.

### Logging and PII `[shipped]`

- Log fields are masked by **key name** from a frozen, case-insensitive set (password, token, authorization, api_key, cookie, card number, iban, ssn, email, phone, and so on). Never inspect values with regexes. Masking must run after key normalization to snake case, so the sensitive list is in snake case.
- Request headers are an **allow-list**. `Referer` is deliberately excluded because it carries the previous page's query string, which can contain OAuth codes and signed-URL parameters that a current-request redactor cannot see.
- The raw query string is never logged; a redaction step logs it with sensitive values masked.
- Request bodies are off in production and capped at 1 KB elsewhere. Sensitive routes opt out entirely (`log without body`, `suppress logging`).
- Tail log sampling keeps all warnings and errors and a fraction of informational logs. Note: a 4xx does not flush the buffer, so an authentication-failure storm is sampled, not recorded in full; alert from metrics, not logs.

### Secrets in configuration `[shipped]`

Encrypted values live in ordinary configuration and are decrypted on read:

```
config value "secret:<ciphertext>"  ->  decrypt(ciphertext)      # prefix marks what to decrypt
decrypting provider WRAPS all sources added before it
   (keeps their reload tokens, so a rotated secret or changed file re-decrypts and notifies option monitors)
key resolved LAZILY, on first secret: value, so a dev setup with no secrets needs no key
any secret: value that fails to decrypt -> throw at load (fail fast); ciphertext never reaches a consumer
```

Traps: decrypting eagerly once at startup loses hot reload of rotated secrets; passing through an undecryptable value "so the app still boots" ships ciphertext as a password; an empty key silently disabling decryption. Tests set the key before any host boots (a process-wide initializer in the test assembly), otherwise the first `secret:` value in test configuration throws. The key itself comes from the environment or a managed secret store, never from the same configuration it protects.

### Audit trail `[shipped]` stamps, `[known gap]` event log unused

- **Row stamps.** A save interceptor sets created-by/at and modified-by/at on auditable entities from the current user and an injected clock (testable time); with no authenticated user the actor is a literal `system`. It runs on the same save as everything else, so the stamp cannot be forgotten.
- **Audit events.** A port records security-relevant events (login, logout, role changes, data export, admin action). The reference implementation writes each event as a dedicated structured log record in its own category over the same telemetry pipeline, and is swappable for an append-only persistent store. `[known gap]` The port is registered but has no caller in any module yet; a port nobody calls is not an audit trail. Guidance: audit sink separate from application logs, append-only, ideally signed.

### Cryptography and supply chain (summary)

- **Password hashing.** Guidance: a memory-hard function (Argon2id preferred, bcrypt cost 12 or more). Reference behavior: the identity framework's default hasher (PBKDF2), unmodified. Treat Argon2id as the recommendation and PBKDF2 as what shipped.
- Random tokens from a cryptographic generator; constant-time comparison for secrets; secrets from a managed store, never from committed configuration (previous section). Dependency pinning and audit gates are in `build-ci-performance.md`.
- Cross-link: replayed requests and the idempotency key's caller scope are in `idempotency-locking-concurrency.md`; an unscoped key is a cross-user disclosure, which is a security property, not just a correctness one.

## 4. Traps

- **Forged tier claim** from an external issuer grants a privileged rate-limit tier. Gate on the scheme.
- **Algorithm confusion.** Without a pinned algorithm list, a token can be re-signed with the public key as an HMAC secret or marked `none`.
- **Trying every key** when `kid` is available widens the attack surface and hides rotation mistakes; disable the library's fallback.
- **Decrypt-once secrets or ciphertext pass-through** (see Secrets in configuration).
- **A refresh-token chain nobody reads** gives rotation without theft detection.
- **Symmetric default** means one compromised validating service forges tokens for all.
- **Accepting the client tenant header** means any caller picks any tenant.
- **Referer in the log allow-list** leaks OAuth codes.
- **Masking before normalization** misses keys because the sensitive set is in snake case.
- **Revocation list down and fail-closed** turns a cache outage into a login outage. Choose fail-open on purpose and keep access-token lifetimes short.
- **Compression over TLS** for secret-bearing responses (BREACH).
- **Unbounded decompression** is a bomb.
- **Auth-failure storms under tail sampling** are under-recorded.

## 5. Invariants to test

- A revoked `jti` returns 401 although signature and lifetime are valid; with the revocation store down the request is accepted (fail-open is asserted, not accidental).
- A previous signing key still validates; a token signed with an unlisted algorithm is rejected.
- Anonymous request to a protected and to an unknown route both return 401.
- Security header snapshot and the 401, 403, and 429 problem body shapes.
- Inbound correlation id that is not a UUID is replaced, not echoed.
- Exported log records: sensitive keys masked, query redacted, `Referer` absent.
- Forged tier claim without the trusted scheme stays at the authenticated tier.
- Forwarded-header spoof from an untrusted peer is ignored.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "HS256 is simpler and we only have one service" | You will have two. Every validator can then mint tokens. |
| "Skew of five minutes is the default" | Expired tokens live five minutes longer than promised. |
| "Our tenant comes from a header for now" | For now becomes production; it is a free pass to any tenant. |
| "Log the whole request, we will scrub later" | Scrubbing by value is unreliable and later never comes. |
| "CORS any origin, it is only dev" | It ships. Deny by default and list origins. |

Red flags: a security decision keyed on a claim without checking the scheme; a log field list that is a deny-list; a header echoed into a response; an `allow any` anywhere; a validation failure reason in a response body.

## 7. Checklist

- [ ] Headers, deny-by-default CORS, trusted-proxy forwarded headers configured.
- [ ] Compression off over TLS; request decompression bounded.
- [ ] JSON depth, unknown-member, and enum settings applied.
- [ ] Token validation covers issuer, audience, lifetime, signature, pinned algorithm; skew 30 s.
- [ ] Asymmetric default planned or documented as a gap; key length validated if symmetric.
- [ ] Default policy is authenticated; opt-outs explicit; 401/403 are problem bodies with no detail.
- [ ] Revocation list failure mode decided and tested; sensitive requests re-verify.
- [ ] Refresh tokens hashed and rotated; reuse detection (family revocation) implemented or recorded as a gap.
- [ ] Config secrets: prefix-marked, lazily keyed, fail fast on undecryptable values; test key set before hosts boot.
- [ ] Audit trail: row stamps on every auditable entity; the audit-event port has real callers.
- [ ] Tiers gated on scheme and claim; API keys allow-listed.
- [ ] Log masking by key, header allow-list, no `Referer`, no raw query, no bodies in production.
- [ ] Audit client address uses the resolved address, not the raw header.
