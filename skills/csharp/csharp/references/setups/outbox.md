# Setup: Debezium connector and polling relay

Load when standing up the outbox relay (Debezium Connect config, container startup order, or the polling fallback). The producer and consumer traps live in `../outbox-debezium-masstransit.md`.

## Debezium Outbox Event Router

- **`jsonb` payload needs `transforms.outbox.table.expand.json.payload=true`.** Debezium captures `jsonb` as an escaped JSON string. Without the flag the Kafka value is a double-encoded string literal, a raw-JSON consumer cannot bind it, faults the message, and the only symptom is an empty inbox. Set it in the production connector and in the test fixture's connector, for every module.
- Map identity to headers, matching what the consumer reads: `id:header:MessageId`, `correlation_id:header:CorrelationId`, `causation_id:header:causationId`, `trace_parent:header:traceparent`, `event_type:header:eventType`.
- Each producing module needs its own `{schema}.outbox` entry in the connector's `table.include.list`.
- Pin the Debezium Connect image (it has no `latest` tag).

## Startup race

With `publication.autocreate.mode=filtered` the publication is created when the connector task starts. If the connector registers before the app has migrated, the table does not exist, the task fails with "No table filters found for filtered publication" and never recovers: zero CDC, silent.

- Immediate fix: `POST /connectors/<name>/tasks/0/restart`, then verify `pg_publication_tables` and an active slot in `pg_replication_slots`.
- Durable fix: the app migrates first and the connector depends on `app: service_healthy`. The app's healthcheck must be liveness, not readiness (readiness probes Connect, which deadlocks app and Debezium), and the app must never depend on Debezium. Integration fixtures migrate before registering the connector.

## Polling relay (when Debezium or Kafka Connect cannot run)

Select with one setting (`Outbox:Relay = Debezium | Polling`) and run exactly one, since both would double-publish. Split claim from publish so a broker round-trip never holds a DB connection:

1. **Claim**: `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n) RETURNING ...` leases a batch in one auto-committed statement. `SKIP LOCKED` lets several relay instances run without contention.
2. **Publish**: produce to Kafka holding no DB connection.
3. **Complete**: a short second statement stamps `processed_on`. A failed publish keeps its lease and is retried once it expires, so a crashed relay self-heals.

Emit the exact wire format Debezium would (topic, key = aggregate id, raw JSON value, same headers) so consumers cannot tell the relays apart, and prove it with a format-parity test.

## Windows tooling gotcha

Git Bash rewrites `docker exec ... /opt/kafka/bin/...` paths (`C:/Program Files/Git/opt/...`) and the command fails silently under `2>/dev/null`. Prefix with `MSYS_NO_PATHCONV=1`.
