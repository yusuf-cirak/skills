---
name: csharp-testing
description: Sets the C# testing standard. Use when writing, editing, reviewing, or generating any C# test (`*.Tests`/`*.IntegrationTests` projects, `[Fact]`/`[Theory]`, fixtures, test doubles) or setting up a test project.
---

# C# Testing Standard

## Contents

- What we require
  - What to test and at which level
  - Structure & naming
  - Asserting on monads → `../csharp/references/monads.md`
  - Doubles, time and data
  - Real dependencies for integration tests
  - Architecture rules
  - Coverage / CI → `yusufcirak-skills:csharp-hardening`
  - LLM & security tests
  - Anti-patterns (forbidden)
- .NET tooling and patterns
  - Stack → `../csharp/references/setups/testing-stack.md`
  - Unit test shape
  - FakeTimeProvider → `yusufcirak-skills:csharp`
  - Bogus builders
  - Testcontainers fixture
  - API-level integration and the shared spine
  - Optimistic concurrency
  - Middleware & Activity/baggage
  - Auth integration tests
  - NetArchTest → `yusufcirak-skills:csharp-ddd`
- Related skills → `yusufcirak-skills:csharp`, `yusufcirak-skills:csharp-ddd`, `yusufcirak-skills:csharp-web-api`, `yusufcirak-skills:csharp-validation`, `yusufcirak-skills:csharp-hardening`, `yusufcirak-skills:csharp-observability`

## Files

- `../csharp/references/setups/testing-stack.md` — Setup: test project and package stack
- `../csharp/references/monads.md` — Monadic error handling (Railway Oriented Programming)
- `yusufcirak-skills:csharp` (`../csharp/SKILL.md`) — C# House Style
- `yusufcirak-skills:csharp-hardening` (`../csharp-hardening/SKILL.md`) — Production Hardening (FAANG-level)
- `yusufcirak-skills:csharp-ddd` (`../csharp-ddd/SKILL.md`) — .NET Domain-Driven Design & Architecture
- `yusufcirak-skills:csharp-web-api` (`../csharp-web-api/SKILL.md`) — ASP.NET Core Web API
- `yusufcirak-skills:csharp-validation` (`../csharp-validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
- `yusufcirak-skills:csharp-observability` (`../csharp-observability/SKILL.md`) — Observability (OpenTelemetry-native, FAANG-level)

Every new feature or change to existing behavior ships with tests that prove the rules it holds, against real dependencies wherever a fake could hide the bug. The first half of this skill is what we require from tests, whatever the framework. The second half is the .NET tooling and the patterns we use. These rules are about structure and discipline, not about forcing a library swap: check the project's existing test packages first and keep them. Apply alongside `csharp` (records, monads, idioms). CI/SAST/DAST/mutation gates live in `csharp-hardening` → CI/Test Security; this skill governs how tests themselves are written.

## What we require

### What to test and at which level

- **Unit tests** cover domain behavior through factories and methods, because they hold the rules. Pure and fast.
- **Integration tests** cover everything a fake cannot prove: real database behavior, constraints, concurrency, HTTP envelopes (`ProblemDetails` shape, security headers, the `429` envelope), auth, messaging.
- **Architecture tests** enforce layer boundaries and fail the build on a violation.
- A bug fix starts with a test that fails for the bug.

### Structure & naming

- One test project per production project: `<Project>.UnitTests`, `<Project>.IntegrationTests`, plus one solution-wide `Architecture.Tests`.
- Mirror the namespace and folder structure of the system under test. One test class per SUT, named `<TypeUnderTest>Tests`.
- Test method: **`Method_State_Expectation`**, e.g. `Create_WhenValueExceedsMax_ReturnsFailure`.
- Arrange / Act / Assert with blank-line separation; no comments when the sections are obvious.
- One logical assertion per test (chained assertions on one subject are fine).

### Asserting on monads

Domain factories and handlers return `Result<T>` / `Option<T>` (see `../csharp/references/monads.md`). Assert on the monad, never via try/catch:

- Success: assert `IsSuccess` first, then the value. Asserting on `result.Value` without it hides the real failure behind a null reference.
- Failure: assert `IsFailure`, then the error.
- `Option<T>`: assert `HasValue` / `IsNone`, then the value.
- Exceptions are an expectation only for genuinely exceptional paths.

### Doubles, time and data

- Test doubles only for **outbound side-effect ports** (email sender, `HttpMessageHandler`, message bus). Pure domain services take real instances. Never mock the domain, or types you own that have no side effects: construct them.
- Time comes from an injected `TimeProvider` (`FakeTimeProvider` in tests), never `DateTime.Now` or a mocked clock.
- Test data is deterministic: seeded fakers, built through the production factory so invariants hold, wrapped in builders so call sites read intent.

### Real dependencies for integration tests

- Real infrastructure in containers. No in-memory or SQLite stand-in for database-bound behavior; they have no unique constraints or `xmin`, so they cannot test concurrency or constraint handling.
- One shared set of containers per test assembly, started once, never per class. State is reset between tests, not by recreating containers.
- Every test that touches I/O passes a `CancellationToken`.
- Assert the real HTTP behavior the hardening rules promise: `ProblemDetails` shape, security headers, `429` envelope (see `csharp-hardening`).
- Auth endpoints get the full matrix: no token returns 401 (`application/problem+json`), a valid token without the required scope returns 403, a correctly scoped token returns 200.

### Architecture rules

One `Architecture.Tests` project enforces the layering from `csharp-ddd`. Minimum rules: Domain depends on nothing outward; Application never references Infrastructure types directly; Contracts stay DTO and interface only; modules do not reference each other's internals (only `*.Contracts`).

### Coverage / CI

- Line and branch coverage collected in CI, gate default at least 80% on changed projects (tune per repo).
- Tests run on every PR; integration tests need Docker on the runner.
- Mutation testing on critical domain paths is owned by `csharp-hardening` → CI/Test Security.

### LLM & security tests

- **Test both corpora.** A guard that blocks every attack but also blocks legitimate input is broken: keep an adversarial set (including the original pentest and bug payloads) and a benign set with look-alikes ("system number", "IBAN") to catch false positives.
- **Prove the fix matters.** Run the same payloads against the pre-fix behavior (legacy prompt or format) as an informational baseline, so "blocked" is compared with "was exploitable".
- **An escape hatch must check its reason.** A test that tolerates a refusal may accept only that specific outcome (the refusal marker). A generic failure (bad key, timeout, 500) must fail the test, otherwise it passes vacuously.
- **Real-provider tests are opt-in**: `[Trait("Category","Integration")]`, skipped unless the environment provides credentials; keys live in memory only and are never printed or written. Assert invariants (field names, blocked or allowed, bounds), not exact model text.
- **Repeat after every prompt or policy change.** Model output is not deterministic even at temperature 0; run the corpus several times and tighten the policy text, not the assertion.
- **Fake the transport, not the logic.** Unit-test request construction with a fake `HttpMessageHandler`: system turn is the trusted policy, user turn is the wrapped state, temperature, seed, schema name and model are what you intend, tags injected by the state never escape their block, and cache hit, miss, outage and every failure path behave as specified.

### Anti-patterns (forbidden)

- EF in-memory or SQLite standing in for the real database in DB-bound tests.
- Mocking domain entities or value objects, or concrete types you own with no side effects.
- `Thread.Sleep` for async timing: await the real signal or poll with a bounded timeout.
- Shared mutable state between tests, order-dependent tests.
- Asserting on `result.Value` without first asserting `IsSuccess`.
- Non-deterministic data: unseeded `Bogus`, `DateTime.Now`, `Guid.NewGuid()` in assertions.
- Logic in tests (loops or conditionals deciding the assertion): prefer `[Theory]` data.

## .NET tooling and patterns

### Stack

Default for a new test project with no convention: xUnit + Shouldly + NSubstitute + Testcontainers + Respawn + Bogus + NetArchTest + coverlet. Propose it and confirm before adding packages. Table, alternatives and layout: `../csharp/references/setups/testing-stack.md`.

### Unit test shape

```csharp
public sealed class ShortTextFactoryTests
{
    [Fact]
    public void Create_WhenValueExceedsMax_ReturnsFailure()
    {
        var input = new string('x', InputLimits.ShortTextMaxLength + 1);

        var result = ShortTextFactory.Create(input);

        result.IsFailure.ShouldBeTrue();
        result.Error.ShouldContain("exceeds");
    }

    [Fact]
    public void Create_WhenValid_ReturnsSuccessWithValue()
    {
        var result = ShortTextFactory.Create("ok");

        result.IsSuccess.ShouldBeTrue();
        result.Value.GetValue().ShouldBe("ok");
    }
}
```

Exceptions on genuinely exceptional paths: `Should.Throw<T>(() => ...)`.

### FakeTimeProvider

`FakeTimeProvider` (`Microsoft.Extensions.TimeProvider.Testing`) advances deterministically and is what production `TimeProvider` (see `csharp`) expects. Use it instead of a mocked `IClock`.

```csharp
var time = new FakeTimeProvider(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
time.Advance(TimeSpan.FromDays(31));

var result = Subscription.Renew(time);

result.IsSuccess.ShouldBeTrue();
```

### Bogus builders

Wrap `Bogus.Faker<T>` in a builder or Object Mother, seed the faker, and build through the production factory.

```csharp
public sealed class CustomerBuilder
{
    private readonly Faker _faker = new(locale: "en") { Random = new Randomizer(localSeed: 1) };
    private string _name = "Acme";

    public CustomerBuilder WithName(string name) { _name = name; return this; }

    public Customer Build()
        => CustomerFactory.Create(
            id: _faker.Random.Guid(),
            name: _name).Value;

    public static Customer Any() => new CustomerBuilder().Build();
}
```

### Testcontainers fixture

Share one container across a collection and reset state per test with Respawn.

```csharp
public sealed class PostgresFixture : IAsyncLifetime
{
    public PostgreSqlContainer Container { get; } =
        new PostgreSqlBuilder().WithImage("postgres:16-alpine").Build();

    private Respawner _respawner = null!;
    public string ConnectionString => Container.GetConnectionString();

    public async Task InitializeAsync()
    {
        await Container.StartAsync();
        await MigrateAsync(ConnectionString);
        await using var conn = new NpgsqlConnection(ConnectionString);
        await conn.OpenAsync();
        _respawner = await Respawner.CreateAsync(conn,
            new RespawnerOptions { DbAdapter = DbAdapter.Postgres });
    }

    public async Task ResetAsync()
    {
        await using var conn = new NpgsqlConnection(ConnectionString);
        await conn.OpenAsync();
        await _respawner.ResetAsync(conn);
    }

    public Task DisposeAsync() => Container.DisposeAsync().AsTask();
}

[CollectionDefinition(nameof(PostgresCollection))]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>;

[Collection(nameof(PostgresCollection))]
public abstract class IntegrationTestBase(PostgresFixture fixture) : IAsyncLifetime
{
    protected PostgresFixture Fixture { get; } = fixture;
    public Task InitializeAsync() => Task.CompletedTask;
    public Task DisposeAsync() => Fixture.ResetAsync(); // clean slate after each test
}
```

### API-level integration and the shared spine

- API-level integration uses `WebApplicationFactory<TEntryPoint>`; inject container connection strings and config via `host.UseSetting("Section:Key", value)`.
- Kafka, Redis (and a Debezium Connect container when the outbox pipeline is under test) follow the same `IAsyncLifetime` fixture pattern as Postgres.
- Set `OTEL_SDK_DISABLED=true` in the factory so exporters do not dial a dead `localhost:4317` (connection-refused noise and a shutdown flush delay).
- **One shared spine per assembly**: start Postgres, Redis and Kafka once for the whole test assembly.

```csharp
[CollectionDefinition(Name)]
public sealed class IntegrationCollection : ICollectionFixture<SpineFixture> { public const string Name = "integration"; }
// Every integration test class carries [Collection(IntegrationCollection.Name)] and shares the one container set.
// Collection tests run SEQUENTIALLY, so a rate-limit-sensitive test can flush Redis first and stay isolated:
public async Task ResetRedisAsync() {
    await using var mux = await ConnectionMultiplexer.ConnectAsync($"{RedisConnectionString},allowAdmin=true");
    foreach (var ep in mux.GetEndPoints()) await mux.GetServer(ep).FlushDatabaseAsync();
}
```

### Optimistic concurrency

Needs a real database, because InMemory has no unique constraints and no `xmin`. Two scopes, two contexts, one row:

```csharp
var a = scopeA.ServiceProvider.GetRequiredService<AppDbContext>();
var b = scopeB.ServiceProvider.GetRequiredService<AppDbContext>();
var ra = await a.Set<Order>().SingleAsync(x => x.Id == id);
var rb = await b.Set<Order>().SingleAsync(x => x.Id == id);
ra.Rename("A"); await a.SaveChangesAsync();   // first writer wins, Postgres advances xmin
rb.Rename("B");
await Should.ThrowAsync<DbUpdateConcurrencyException>(() => b.SaveChangesAsync()); // stale xmin is rejected
```

### Middleware & Activity/baggage

Middleware that reads or sets `Activity.Current` (correlation id, baggage enrichment) is tested with a `DefaultHttpContext` and a live `ActivityListener`, no host needed.

```csharp
private static ActivityListener StartListening()
{
    var listener = new ActivityListener
    {
        ShouldListenTo = _ => true,
        Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData
    };
    ActivitySource.AddActivityListener(listener);
    return listener;
}

[Fact]
public async Task Stamps_user_id_on_baggage_when_authenticated()
{
    using var listener = StartListening();
    using var source = new ActivitySource("test");
    using var activity = source.StartActivity("req")!;

    var ctx = new DefaultHttpContext
    {
        User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "u-1")], "jwt"))
    };

    await new UserContextMiddleware(_ => Task.CompletedTask).InvokeAsync(ctx);

    activity.GetBaggageItem("user_id").ShouldBe("u-1");
}
```

### Auth integration tests

For JWT-protected endpoints, mint a token in-test that the booted app accepts. Configure the app for symmetric (HS256) in the factory (`UseSetting` the issuer, audience and signing key) and sign with the same key:

```csharp
public string MintToken(params string[] scopes)
{
    var descriptor = new SecurityTokenDescriptor
    {
        Issuer = JwtIssuer, Audience = JwtAudience, Expires = DateTime.UtcNow.AddMinutes(5),
        SigningCredentials = new SigningCredentials(
            new SymmetricSecurityKey(Encoding.UTF8.GetBytes(JwtSigningKey)), SecurityAlgorithms.HmacSha256),
        Claims = new Dictionary<string, object> { ["sub"] = "test-user" }
    };
    if (scopes.Length > 0) descriptor.Claims["scope"] = string.Join(' ', scopes);
    return new JsonWebTokenHandler().CreateToken(descriptor);
}
```

### NetArchTest

```csharp
[Fact]
public void Domain_ShouldNotDependOn_InfrastructureOrApplication()
{
    var result = Types.InAssembly(DomainAssembly.Reference)
        .Should()
        .NotHaveDependencyOnAny("<Solution>.*.Infrastructure", "<Solution>.*.Application")
        .GetResult();

    result.IsSuccessful.ShouldBeTrue(
        $"violations: {string.Join(", ", result.FailingTypeNames ?? [])}");
}
```

## Related skills

- `yusufcirak-skills:csharp` — records/monads/idioms the SUT and builders follow.
- `yusufcirak-skills:csharp-ddd` — the layer boundaries the architecture tests enforce.
- `yusufcirak-skills:csharp-web-api` — endpoints exercised by integration tests.
- `yusufcirak-skills:csharp-validation` — `InputLimits`/VO rules asserted in unit tests.
- `yusufcirak-skills:csharp-hardening` — CI gates, mutation testing, security-header/`429` assertions.
- `yusufcirak-skills:csharp-observability` — `ActivityListener` middleware tests; `OTEL_SDK_DISABLED` in integration tests.
