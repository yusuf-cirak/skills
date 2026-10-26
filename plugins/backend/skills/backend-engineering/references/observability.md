---
metadata:
  file: observability.md
  sections:
    - {title: "1. When this applies", start: 19, end: 24}
    - {title: "2. Principles", start: 26, end: 35}
    - {title: "3. Design", start: 37, end: 114}
    - {title: "4. Traps", start: 116, end: 130}
    - {title: "5. Invariants to test", start: 132, end: 139}
    - {title: "6. Rationalizations / Red flags", start: 141, end: 151}
    - {title: "7. Checklist", start: 153, end: 164}
---
# Observability

> **Golden path:** One resource identity across traces, metrics and logs; correlation and causation ids carried in ambient context across every hop; masking applied in the log pipeline.

Language specifics (OpenTelemetry SDK wiring, processor APIs) live in language skills; the `dotnet:observability` skill exists for the .NET realization of everything below. This file owns the decisions and failure modes that hold in any language.

## 1. When this applies

- Wiring traces, metrics or logs into a service, or changing an exporter, sampler or log processor.
- Adding a message hop (queue, CDC, outbox) where identity and trace context must survive.
- Adding a new log field that might carry personal or secret data.
- Adding health endpoints, custom metrics, or a second logging backend.

## 2. Principles

1. **One identity, three signals.** Traces, metrics and logs share a single resource description (service name and version, environment, host, process id) and export over the same open protocol (OTLP) to whatever collector the deployment chooses. The backend is a deployment choice, never baked into code.
2. **Three ids, three jobs.** `trace_id` is per request and subject to sampling. `correlation_id` is a durable business-flow id that survives sampling and message hops. `causation_id` is the id of the message that directly caused this one. Do not collapse them.
3. **Context rides ambient propagation, not call-site threading.** Correlation and causation live in the language's ambient context (baggage on the active span, request-scoped context). Code that logs never passes ids by hand.
4. **Enrich and redact in the export pipeline, not at call sites.** A call site that must remember to mask or normalize will forget once.
5. **Mask by key name, never by inspecting values.** Value scanning is slow, leaky and wrong in both directions.
6. **Metric dimensions are low-cardinality; per-user detail belongs on traces and logs.**
7. **Instrument names identify the library, not the application.** Application identity lives only in the resource.
8. **Every alternate path has a parity test** (two logging backends, two producers): one test asserts the exported shape is the same.

## 3. Design

Terms below are SDK-neutral. Rough equivalents for readers outside the reference stack: "ambient context / baggage" is `context.Context` plus OTel baggage in Go and the active `tracing` span plus OTel baggage in Rust; a "log processor" is an OTel SDK log-record processor or a `tracing` subscriber layer; "boot the application in-process" is starting your router on an ephemeral port in the test binary.

### Resource and export `[shipped]`

```
resource = { service.name, service.version, deployment.environment, host.name, process.pid }
traces  -> OTLP/gRPC -> collector   sampler = ParentBased(TraceIdRatio(ratio))
metrics -> OTLP/gRPC -> collector
logs    -> OTLP/gRPC -> collector
endpoint overridable by the standard OTEL_EXPORTER_OTLP_ENDPOINT
ratio: 1.0 in development, configurable fraction elsewhere (reference default 0.2)
```

`ParentBased` honours the upstream sampling decision, so a distributed trace is kept or dropped coherently; only root spans roll the ratio. Run the process in UTC so timestamps line up across signals.

### The identity trio across hops `[shipped]`

```
HTTP in:
  inbound = header "X-Correlation-Id"
  correlation_id = parse_guid(inbound)          # ONLY a parsed GUID is accepted
                   ?? baggage("correlation_id")  # else upstream context
                   ?? new_time_ordered_uuid()    # else UUIDv7
  baggage.set("correlation_id", correlation_id)
  response headers: X-Correlation-Id, X-Trace-Id

command handler writing an outbox row:
  row.correlation_id = baggage("correlation_id")
  row.causation_id   = id of the message being handled (if any)
  row.trace_parent   = current_span.id           # W3C traceparent value

CDC / relay turns those columns into message headers:
  MessageId, CorrelationId, causationId, traceparent, eventType

consumer pipeline filter (the irreducible core):
  1. re-parent the consume span from header "traceparent"
  2. copy correlation_id and causation_id into baggage and span tags
```

A GUID-only rule is deliberate. It makes echoing the id in a response header injection-safe (a raw inbound value reflected into a header is a response-splitting vector), and it matches what the queue library can parse natively.

### Log pipeline `[shipped]`

Processors run in this order, on the export path:

```
1. baggage processor    copy a FIXED key list (correlation_id, causation_id, user_id,
                        client_ip, tenant_id) from ambient context onto the record
2. snake_case processor normalize attribute keys to snake_case
3. mask processor       replace values of sensitive KEYS with a constant
```

- Code keeps whatever template naming it likes (PascalCase is fine) because the export-time processor normalizes keys. If a team instead writes snake_case templates, the processor becomes a no-op for those keys; both are valid, mixing is not a problem.
- The snake_case routine is acronym-aware, memoized per key, and skips keys that start with a template-placeholder marker (the "original format" key) so the message template survives.
- The sensitive-key set is a frozen, case-insensitive set written in snake_case (password, token, authorization, api_key, cookie, card_number, iban, ssn, email, phone, ...). It must be snake_case because masking runs after normalization.
- HTTP request logging uses a header allow-list. The referrer header is excluded on purpose: it carries the previous page's query string (OAuth codes, signed URLs) which a current-request redactor cannot see. Raw query strings are never logged; a redaction interceptor logs a masked form. Bodies are capped (reference: 1 KB) and off in production.
- Per-endpoint opt-ins are declared on the route: `log-without-body`, `suppress-logging` (health probes use the latter).
- **Tail log sampling:** buffer Information-and-below per request; flush everything on a 5xx or unhandled exception, otherwise flush at a sample rate (reference 20%). Warning and above always stream. Disabled in development.

### Custom metrics `[shipped]`

- Counters: `ratelimit.rejected`, `ratelimit.fallback`, `burst.banned`, `adaptive.rejected`. Observable gauges: `adaptive.limit`, `adaptive.load.{score,cpu,threadpool,latency,errors}` so operators see why a limit moved.
- Instrument names: `"<Library>.RateLimiting"`, `"<Library>.Messaging"`; never the app name.
- Gauge registration is idempotent (atomic once-flag) because the meter is static and tests boot several hosts in one process.

### Health `[shipped]`

Probe groups (startup, liveness, readiness, full), the starvation probe, per-check timeouts and the migrations-versus-readiness deadlock rule are defined once in `resilience-lifecycle.md`. Observability's part: probe routes use the `suppress-logging` opt-in so they do not drown the logs, and a failing check should emit a metric so an alert does not depend on scraping the probe endpoint.

### Selectable logging backend `[shipped]`

The log backend is switchable by configuration (OTel-native default, or a structured-logging library with an OTLP sink). Both share the same primitives: the snake_case routine, the sensitive-key set, the baggage key list. Traces and metrics never switch. A boot test per backend and an exported-shape test keep them identical. Record the alternative in an ADR.

### Hot-path logging

Fixed-message events use compile-time generated or pre-bound log calls (no per-call template parse, no boxing). Inline formatted calls are fine for cold paths. Allocate in a processor only when a key actually changes; read the fixed baggage keys directly instead of enumerating the baggage (enumeration allocates an iterator).

## 4. Traps

- **The queue library re-parents only from its own proprietary header**, not from W3C `traceparent`. Without your consumer filter, HTTP and consume are two unrelated traces and nothing errors.
- **The same library parses `CorrelationId` and `MessageId` headers natively but silently nulls them if they are not GUID-parseable.** That is why correlation ids are GUIDs end to end.
- **Echoing an unvalidated inbound id in a response header is header injection.** Parse first.
- **Masking runs after snake_casing.** A mixed-case sensitive list silently misses keys.
- **Processors execute on the export batch thread, not at log time.** Snapshot ambient values when the record is created or you read a dead context.
- **A processor cannot drop a record** in most SDKs (the exporter always runs after it). Sampling needs per-request buffering, decided at request end. Processors are for enrich and redact only.
- **Framework scope keys cannot be cleanly rewritten** from a processor; normalize the keys you control and leave the rest.
- **Do not register the same database span source twice** through two helpers (the driver's native source and the ORM helper); they collide.
- **Static meters plus several test hosts:** register observable gauges idempotently or the second host throws.
- **Probe-group deadlocks** (migrations versus readiness) are covered in `resilience-lifecycle.md`.
- **4xx does not flush the sampled-log buffer.** An auth-failure storm is only sampled; alert on metrics, not on buffered logs.
- **Metrics export on a flush interval (about 60 s).** When verifying locally, generate load and wait.
- **Telemetry in tests:** disable the SDK (`OTEL_SDK_DISABLED=true`) to avoid connection-refused noise and shutdown flush delay.

## 5. Invariants to test

- Export logs through an in-memory exporter and assert the exported shape: keys snake_case, template placeholder key intact, baggage stamped, sensitive values masked, query redacted.
- Correlation middleware: header accepted only if it parses as a GUID; an injection attempt is rejected; absent header yields a fresh time-ordered id.
- Each logging backend boots and logs without throwing; both export the same keys.
- Wire-contract test: the in-app relay builds byte-identical topic, key, value and headers to the CDC router.
- Consumer filter test: consume span parent equals the `traceparent` header; baggage holds both ids.
- Idempotent gauge registration: build two hosts in one process.

## 6. Rationalizations / Red flags

| Rationalization | Reality |
|---|---|
| "trace_id is enough, skip correlation_id" | Sampling drops traces; the business flow still needs an id that survives. |
| "Just echo the incoming correlation header" | Header injection. Parse it. |
| "We will mask in the log call" | One forgotten call leaks a token. Mask in the pipeline by key. |
| "Add user_id as a metric tag, it is useful" | Cardinality explosion. Put it on traces and logs. |
| "The queue library propagates trace already" | Only from its own header. Test it. |

Red flags in a diff: a log call that formats a secret into the message string; a metric tag fed by an unbounded value; a processor that reads ambient context lazily; a second registration of the same span source; a new queue consumer without the context filter.

## 7. Checklist

- [ ] One resource shared by traces, metrics, logs; OTLP endpoint overridable.
- [ ] Head sampling is ParentBased ratio.
- [ ] correlation_id GUID-only, UUIDv7 fallback, echoed with trace id.
- [ ] causation_id set from the causing message; outbox row carries all three ids.
- [ ] Consumer filter re-parents from `traceparent` and restores baggage.
- [ ] Processor order baggage, snake_case, mask; sensitive list in snake_case.
- [ ] Header allow-list, no raw query, bodies capped and off in production.
- [ ] Instrument names identify the library; gauges registered idempotently.
- [ ] Probes split per `resilience-lifecycle.md`; probe routes suppress request logging.
- [ ] Exported-shape tests and wire-parity test exist.
