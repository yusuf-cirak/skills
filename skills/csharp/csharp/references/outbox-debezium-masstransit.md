# Outbox → Debezium → Kafka → MassTransit — the concrete traps

Flow: command + outbox row in **one** `SaveChanges` → relay (Debezium CDC by default, or an in-app polling relay) → Kafka topic → MassTransit Kafka-rider consumer → inbox dedup. The *why* of outbox is in `yusufcirak-skills:csharp-ddd` and `yusufcirak-skills:csharp-hardening`; this file lists what silently breaks it. Connector config, startup order and the polling relay: `setups/outbox.md`.

## Producer side

- **One DbContext and one outbox table per module** (own schema). Register `IOutboxWriter` **keyed by its DbContext** and inject `[FromKeyedServices(nameof(XDbContext))]`. An unkeyed registration is a trap: with two producing modules the last wins, so one module's handler writes its row to another module's DbContext, never saved, Debezium never sees it, the inbox stays empty.
- Outbox entity: `Property(x => x.Id).ValueGeneratedNever()` so the database never overrides the app-assigned message id; payload column `jsonb`. With snake_case naming the PK column is `id` (lowercase), and the connector must say `id`.
- A `jsonb` payload needs the connector's JSON-expand flag, or the consumer sees a double-encoded string and the only symptom is an empty inbox (see `setups/outbox.md`).

## Consumer side (MassTransit 8.5.x, last OSS line; v9 is commercial, see `mediator.md`)

- Use the Kafka **rider** with `UseRawJsonDeserializer` (Debezium emits plain JSON, no MassTransit envelope).
- Identity is MassTransit-native: with raw JSON, `ConsumeContext.MessageId` / `CorrelationId` come from transport headers named **exactly** `MessageId` / `CorrelationId`. They must parse as GUIDs; a non-GUID silently yields `null`.
- MassTransit does **not** read W3C `traceparent` (only its proprietary `MT-Activity-Id`), so trace continuity needs a small consume filter that re-parents the span from `traceparent` and copies `correlation_id` / `causation_id` (MassTransit has no causation concept) into `Activity` baggage and tags.
- Set `AutoOffsetReset = Earliest`. Confluent's default is `Latest`, so a fresh or restarted consumer group silently skips events.
- Inbox dedup: unique `(message_id, consumer)` in the handler's transaction; treat SQLSTATE `23505` as a duplicate, not an error (see `yusufcirak-skills:csharp-hardening` → Background Jobs & Messaging).
- Run exactly one relay (Debezium or polling), never both: both would double-publish.
