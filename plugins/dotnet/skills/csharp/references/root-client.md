# Root client + typed sub-clients

## Contents

- Shape
- Rules
- Example
- Registration
- Related

Load when a library or service exposes several downstream APIs of one platform and callers should reach them with `platform.Api.Method()` (`dimo.Authentication.GetTokenAsync(...)`).

## Shape

One **root client** (a facade) represents the platform. Each downstream API is a **typed client** (`Outbound HTTP` in `SKILL.md`) exposed as a property of the root. The caller sees `dimo.Authentication`, never the DI container, the `HttpClient`, or when the sub-client is built.

## Rules

- The typed client is the sub-client. No extra `IXService` wrapper layer over it unless a second implementation or a module boundary needs one.
- Properties are named for the API (`Authentication`, `Devices`), without a `Service` or `Client` suffix: the root already says what it is.
- Sub-clients are created **lazily, once, thread-safely**: `Lazy<T>` (default `ExecutionAndPublication`) wrapping the typed-client factory. A property read never builds more than one instance.
- The root takes its sub-clients as `Func<T>` / `Lazy<T>` from the composition root. It never holds `IServiceProvider` and never calls `GetRequiredService` itself (service locator).
- One `HttpClient` per downstream API, owned by that typed client for its lifetime. It is shared across requests, so it stays free of per-request state.
- Per-request values (user token, tenant, correlation id) go on the `HttpRequestMessage`, never `DefaultRequestHeaders`. A sub-client with a mutable header is a race once two callers share it.
- The root owns what it creates: when it builds its own `ServiceProvider` (no host DI), it is `IAsyncDisposable` and disposes the provider. No finalizer.
- The root's lifetime is `Scoped` or `Transient`, never singleton.
- A DI consumer may still inject one typed client directly; the root is optional there.

## Example

```csharp
public sealed class AuthenticationClient(HttpClient http)
{
    public async Task<Result<Token>> GetTokenAsync(
        string code, CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "token")
        {
            Content = JsonContent.Create(new TokenRequest(code)),
        };

        using var response = await http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
            return Result.Failure<Token>($"auth returned {(int)response.StatusCode}");

        var token = await response.Content.ReadFromJsonAsync<Token>(cancellationToken);
        return token is null ? Result.Failure<Token>("auth returned an empty body") : Result.Success(token);
    }
}

public sealed class DimoClient(
    Lazy<AuthenticationClient> authentication,
    Lazy<DevicesClient> devices) : IAsyncDisposable
{
    public AuthenticationClient Authentication => authentication.Value;
    public DevicesClient Devices => devices.Value;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask; // owned provider disposed here when the root built it
}
```

Caller: `var result = await dimo.Authentication.GetTokenAsync(code, cancellationToken);`

## Registration

Typed clients are transient. The root takes its lifetime from the consumer (`Scoped` or `Transient`), and its `Lazy<T>` sub-clients live and die with it: when the root goes, the lazies and the clients inside go too. `Lazy<T>` only defers the build to first use. Never register the root as a singleton, since it would pin every typed client (and its handler) for the process lifetime.

```csharp
services.AddHttpClient<AuthenticationClient>(c => c.BaseAddress = new Uri(options.AuthUrl))
        .AddStandardResilienceHandler();
services.AddHttpClient<DevicesClient>(c => c.BaseAddress = new Uri(options.DevicesUrl))
        .AddStandardResilienceHandler();

services.AddScoped(sp => new DimoClient(
    new Lazy<AuthenticationClient>(sp.GetRequiredService<AuthenticationClient>),
    new Lazy<DevicesClient>(sp.GetRequiredService<DevicesClient>)));
```

## Related

- `SKILL.md` → Outbound HTTP (typed client, `Result<T>`, per-request headers)
- `references/resilience.md` — `AddStandardResilienceHandler`
- `references/composition.md` — `AddX` extensions, library surface
