---
metadata:
  file: untrusted-input-outbound.md
  sections:
    - {title: "1. When this applies", start: 19, end: 24}
    - {title: "2. Principles", start: 26, end: 32}
    - {title: "3. Design", start: 34, end: 80}
    - {title: "4. Traps", start: 82, end: 91}
    - {title: "5. Invariants to test", start: 93, end: 100}
    - {title: "6. Rationalizations / Red flags", start: 102, end: 111}
    - {title: "7. Checklist", start: 113, end: 120}
---
# Untrusted Input and Outbound Calls

> **Golden path:** Treat attacker-influenced data as data: parameterise queries, guard every caller-chosen outbound URL against internal ranges, validate uploads by content, and isolate untrusted text in prompts.

> Provenance: unlike the other references, this one is **not** distilled from the reference system's code. It is general backend-security practice, carried over from the owner's `yusufcirak-skills:csharp-hardening` skill and made language-agnostic. Treat each rule as a standard to apply, not as a proven pattern from the reference system. Headers, CORS, auth, PII logging and body limits live in `security-hardening.md`; this file covers what happens to data an attacker can influence and to calls the server makes on someone's behalf.

## 1. When this applies

- A user-supplied URL, hostname, file, XML/JSON/binary blob, or sort/filter fragment reaches a fetcher, parser, query or file system.
- The service accepts uploads, calls webhooks or arbitrary callback URLs, or renders user content to another system.
- Free text written by a caller, admin or document is sent to a language model.
- Raw SQL, dynamic query fragments or an HTTP cache layer is added.

## 2. Principles

1. **Anything an attacker can influence is data, never structure.** It must not become query syntax, a path, a host, a template, a type name, or a prompt instruction.
2. **Validate by allow-list at the point of use,** not by block-list at the door. Header and extension checks are client-controlled and prove nothing.
3. **Outbound calls are a privilege.** The server can reach networks the attacker cannot; every call whose target an attacker can pick needs a network-level guard.
4. **Parsers are attack surface.** Disable features you do not use (external entities, polymorphic types, DTDs).
5. **Safe-by-default wrappers beat reviewer vigilance.** One audited helper per sink (outbound client, upload store, prompt builder) that every caller must use.

## 3. Design

### SQL and query fragments
- Always parameterise. Never build SQL by concatenating or interpolating values into the string, even for "internal" inputs.
- Dynamic ORDER BY, column or table names are never parameters: map the caller's value through a fixed allow-list to a known identifier.
- Set a statement timeout and an idle-in-transaction timeout on the database side as well as a client command timeout, so a hostile or accidental heavy query cannot hold a connection.

### SSRF (server-side request forgery)
```
fetch(url):
  parsed = parse(url); require scheme in {https[, http if allowed]}; reject userinfo
  ip = resolve(parsed.host)               # resolve ONCE
  if ip in denied_ranges: reject
  connect to ip directly (pin), send original Host header / SNI
  follow redirects only to same origin, or re-run the whole check per hop
  enforce connect timeout (~5s) and total timeout (~30s); cap response size
```
- Denied ranges: loopback (127.0.0.0/8, ::1), private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local and **cloud metadata** (169.254.0.0/16), plus unspecified and multicast.
- Resolve once and connect to the resolved address; re-resolving between check and connect allows DNS rebinding.
- Compose the SSRF guard **inside** the resilience pipeline (retry, circuit breaker), so every retry attempt and every redirect hop is re-checked.
- Prefer an allow-list of destination hosts for webhooks whenever the product allows it.

### File upload
- Validate **content** (magic bytes), not extension or the client's `Content-Type`. Allow-list permitted types and reject the rest.
- Enforce a per-endpoint size limit and opt larger endpoints in explicitly; never disable the global body limit.
- Store outside any web-served directory under a **server-generated name**; never echo the client filename into paths or URLs (path traversal, header injection).
- Scan for malware and quarantine on a hit. Re-encode images server-side to strip metadata and bound decoded pixel counts (decompression bombs).
- Serve user files from a separate origin or with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.

### XML and deserialization
- XML: forbid DTDs and external entity resolution (XXE, billion laughs). Cap document size and depth.
- Never deserialize untrusted bytes with a format that can instantiate arbitrary types (native object serializers, polymorphic "type name" JSON/YAML modes, pickle-style formats). That is a remote-code-execution class.
- Use explicit contracts: a schema'd format decoded into known types, unknown fields rejected, depth and size capped.

### HTTP caching of responses
- Authenticated or per-user responses default to `Cache-Control: no-store`.
- Any response that varies per user or per header carries the matching `Vary`; shared caches must never serve it across users.
- Use `ETag` / conditional GET only on public read-heavy resources.

### Prompts for language models
- **Untrusted text lives in its own delimited block** inside the user turn; trusted policy lives in the system turn. A helper wraps untrusted text and strips every delimiter token from it, repeating until none can re-form, then wraps. Never concatenate untrusted text into a trusted section; a "ignore instructions in the document" sentence alone is not a defense.
- **Gate writes, fail closed.** Classify free-text instructions before persisting them; anything other than an explicit "allow" (timeout, provider error, malformed or refused output) rejects the save.
- **Validate model output like input:** structured output, check against policy, clamp numbers, bound lengths and counts. Output encoding still happens at the sink (UI, query, shell); sanitising model output is a bound, not an encoder.
- The model choice is system configuration, not caller input. Validate any stored model name by format.
- Do not leak the machinery (system prompt, raw model response) to non-admins, and never log the text under review; log a hash prefix, decision, model, tokens and duration.
- Record usage (model, tokens, purpose) for every non-cached call, including rejected requests.
- Determinism and cost: temperature 0 and a fixed seed where supported; cache verdicts keyed by hash(policy version, model, input); never cache failures; a cache outage must not break the request.

## 4. Traps

- **Block-list for private IPs** applied to the hostname string, not to the resolved IP: `localhost`, decimal/octal/hex IP forms, IPv6-mapped IPv4 and a DNS name pointing at 127.0.0.1 all pass.
- **Redirect following** turns an allowed public URL into an internal fetch. Disable redirects or re-validate each hop.
- **Check-then-connect** with two DNS lookups (rebinding).
- **Trusting the upload's extension or MIME type.** A `.png` that is HTML served from your origin is stored XSS.
- **Interpolated "parameterised" queries.** Many libraries have a safe interpolation helper and an unsafe concatenation one that look identical in review.
- **Polymorphic deserialization left on** "just for one endpoint".
- **Caching an authenticated response** at a CDN because the cache key ignored `Authorization`.
- **One-pass tag stripping** for prompts: nested fragments re-form the delimiter after the first pass.

## 5. Invariants to test

- Table-driven SSRF test: loopback, RFC1918, link-local/metadata, IPv6 loopback, decimal-encoded IPs, a hostname that resolves to a private IP, and a redirect to an internal host are all rejected; a public host passes.
- Upload test: wrong magic bytes with a right extension is rejected; oversized body is rejected with the endpoint-specific limit; client filename never appears in the stored path.
- SQL: a lint or architecture rule that flags string-built queries; a test that a hostile sort parameter is mapped to the default, not passed through.
- Deserialization test: a payload with an unexpected type discriminator or extra field is rejected.
- Response header snapshot: authenticated route returns `no-store` and correct `Vary`.
- Prompt-builder test: input containing the delimiter, nested delimiters and mixed case never produces a closing delimiter in the output.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "The URL comes from our own admin" | Admin accounts get phished and webhooks get misconfigured; SSRF protection is cheap and constant. |
| "We validate the extension" | The extension is attacker-chosen. |
| "It's an internal endpoint, plain concatenation is fine" | Internal inputs are somebody's external inputs one refactor later. |
| "The model is only summarising" | Output flows to tools, UIs or stored state; treat it as untrusted input to the next stage. |

Red flags in a diff: an outbound HTTP client constructed ad hoc outside the shared factory; a path built from a request field; `exec`/shell with request data; a deserializer configured with type-name handling; SQL assembled with `+` or format strings; a prompt built by string concatenation with caller text.

## 7. Checklist

- [ ] Every outbound call whose target a user can influence goes through the shared guarded client.
- [ ] Uploads: content-validated, size-limited, stored under server-generated names outside the served tree.
- [ ] No string-built SQL; identifiers come from allow-lists; DB-side timeouts set.
- [ ] Parsers hardened (no DTDs, no polymorphic types), size and depth capped.
- [ ] Authenticated responses are `no-store` or correctly `Vary`-keyed.
- [ ] Untrusted text sent to a model is isolated, neutralised, gated and its output validated.
