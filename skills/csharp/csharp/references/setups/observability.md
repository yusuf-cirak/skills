# Setup: OpenTelemetry registration

Load when wiring telemetry in `Program.cs` or a new service for the first time. The rules (low-cardinality tags, minimal log messages, key-based masking, RED + USE) live in `yusufcirak-skills:csharp-observability`.

One `AddOpenTelemetry()`, one shared `Resource`, one OTLP exporter per signal. Centralize source and meter names as constants.

```csharp
var resource = ResourceBuilder.CreateDefault()
    .AddService(serviceName, serviceVersion: version)
    .AddAttributes([
        new("deployment.environment", environment),
        new("host.name", Environment.MachineName),
        new("process.pid", Environment.ProcessId)
    ]);

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService(serviceName, serviceVersion: version))
    .WithTracing(t => t
        .SetSampler(new ParentBasedSampler(new TraceIdRatioBasedSampler(traceRatio)))
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddSource("Npgsql")
        .AddSource("MassTransit")
        .AddSource(MyModule.ActivitySourceName)
        .AddOtlpExporter())
    .WithMetrics(m => m /* AddAspNetCoreInstrumentation, AddRuntimeInstrumentation, AddProcessInstrumentation, AddMeter(...) */);

builder.Logging.AddOpenTelemetry(o =>
{
    o.IncludeScopes = true;            // carry scope state (RequestId/TraceId/...)
    o.IncludeFormattedMessage = true;  // render the message body, not just the template
    o.ParseStateValues = true;         // expose structured state as individual attributes
    o.SetResourceBuilder(resource);
    o.AddProcessor(new BaggageLogRecordProcessor());       // correlation_id/causation_id/user_id from baggage
    o.AddProcessor(new SnakeCaseLogRecordProcessor());     // normalize attribute keys to snake_case
    o.AddProcessor(new SensitiveDataLogRecordProcessor()); // mask sensitive attribute VALUES
    o.AddOtlpExporter();
});

// Structured stdout parity (do not run a Serilog console alongside):
builder.Logging.AddJsonConsole(o => o.JsonWriterOptions = new() { Indented = false });
```

- Sampling: `ratio = 1.0` in Development, a configurable fraction in prod (default `0.2`). `ParentBased` honours the upstream decision, so only root spans roll the ratio.
- Run the process in UTC (`TZ=UTC` plus `TimeZoneInfo.ClearCachedData()`) before any date API is touched.
- In tests set `OTEL_SDK_DISABLED=true` so the exporters do not dial a dead `localhost:4317`.
- Enforce source-generated logging by escalating analyzer CA1848 in `.editorconfig`:

```ini
dotnet_diagnostic.CA1848.severity = warning
```
