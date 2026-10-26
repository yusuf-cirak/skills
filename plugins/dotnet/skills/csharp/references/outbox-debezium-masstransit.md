# Outbox → Debezium → Kafka → MassTransit — the concrete traps

Flow: command + outbox row in **one** `SaveChanges` → relay (Debezium CDC by default, or an in-app polling relay) →
Kafka topic → MassTransit Kafka-rider consumer → inbox dedup. The *why* of outbox is in `dotnet:ddd` and
`dotnet:hardening`; this file lists what silently breaks it.

## Producer side

- **One DbContext and one outbox table per module** (own schema). Register `IOutboxWriter` **keyed by its DbContext**
  and inject `[FromKeyedServices(nameof(XDbContext))]`. An unkeyed registration is a trap: with two producing modules
  the last wins, so one module's handler writes its row to another module's DbContext — never saved, Debezium never
  sees it, the inbox stays empty. Each module also needs its own `{schema}.outbox` entry in the connector's
  `table.include.list`.
- Outbox entity: `Property(x => x.Id).ValueGeneratedNever()` so the database never overrides the app-assigned message
  id; payload column `jsonb`. With snake_case naming the PK column is `id` (lowercase), and the connector must say `id`.

## Debezium Outbox Event Router

- **`jsonb` payload needs `transforms.outbox.table.expand.json.payload=true`.** Debezium captures `jsonb` as an escaped
  JSON *string*; without the flag the Kafka value is a double-encoded string literal, a raw-JSON consumer cannot bind
  it, faults the message, and the only symptom is an empty inbox. Set it in the production connector **and** the test
  fixture's connector, for every module.
- Map identity to headers, matching what the consumer reads: `id:header:MessageId`, `correlation_id:header:CorrelationId`,
  `causation_id:header:causationId`, `trace_parent:header:traceparent`, `event_type:header:eventType`.
- **Startup race:** with `publication.autocreate.mode=filtered` the publication is created when the connector task
  starts. If the connector registers before the app has migrated, the table does not exist and the task fails with
  *"No table filters found for filtered publication"* and **never recovers** — zero CDC, silent. Immediate fix:
  `POST /connectors/<name>/tasks/0/restart`, then verify `pg_publication_tables` and an active slot in
  `pg_replication_slots`. Durable fix: the app migrates first and the connector depends on `app: service_healthy`; the
  app's healthcheck must be **liveness**, not readiness (readiness probes Connect → app↔Debezium deadlock), and the app
  must never depend on Debezium. Integration fixtures migrate before registering the connector.
- Pin the Debezium Connect image (it has no `latest` tag).

## Consumer side (MassTransit 8.5.x, last OSS line; v9 is commercial — see `mediator.md`)

- Use the Kafka **rider** with `UseRawJsonDeserializer` (Debezium emits plain JSON, no MassTransit envelope).
- Identity is MassTransit-native: with raw JSON, `ConsumeContext.MessageId` / `CorrelationId` come from transport
  headers named **exactly** `MessageId` / `CorrelationId`. They must parse as GUIDs; a non-GUID silently yields `null`.
- MassTransit does **not** read W3C `traceparent` (only its proprietary `MT-Activity-Id`), so trace continuity needs a
  small consume filter that re-parents the span from `traceparent` and copies `correlation_id` / `causation_id`
  (MassTransit has no causation concept) into `Activity` baggage and tags.
- Set `AutoOffsetReset = Earliest`. Confluent's default is `Latest`, so a fresh or restarted consumer group silently
  skips events.
- Inbox dedup: unique `(message_id, consumer)` in the handler's transaction; treat SQLSTATE `23505` as a duplicate, not
  an error (see `dotnet:hardening` → Background Jobs & Messaging).

## Polling relay (when Debezium/Kafka Connect cannot run)

Select with one setting (`Outbox:Relay = Debezium | Polling`) and run **exactly one** — both would double-publish.
Split claim from publish so a broker round-trip never holds a DB connection:

1. **Claim** — `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING …` leases a batch in one
   auto-committed statement; `SKIP LOCKED` lets several relay instances run without contention.
2. **Publish** — produce to Kafka holding **no** DB connection.
3. **Complete** — a short second statement stamps `processed_on`. A failed publish keeps its lease and is retried
   once it expires, so a crashed relay self-heals.

Emit the **exact wire format Debezium would** (topic, key = aggregate id, raw JSON value, same headers) so consumers
cannot tell the relays apart, and prove it with a format-parity test.

## Windows tooling gotcha

Git Bash rewrites `docker exec … /opt/kafka/bin/…` paths (`C:/Program Files/Git/opt/…`) and the command fails
silently under `2>/dev/null`. Prefix with `MSYS_NO_PATHCONV=1`.
