# yusufcirak-skills auto-standards (opencode)

When working in any C# / .NET / ASP.NET Core context (files: `.cs`, `.csproj`, `.sln`, `.slnx`, `.razor`, `.cshtml`, `Directory.Build.props`, `Directory.Packages.props`, `global.json`; or topics: C#, .NET, ASP.NET Core, EF Core, DDD in .NET, xUnit/NUnit/MSTest), invoke the **`csharp`** skill via the `skill` tool before the first edit.

`csharp` holds the core style and a signal table for the sibling skills (`csharp-ddd`, `csharp-web-api`, `csharp-validation`, `csharp-hardening`, `csharp-observability`, `csharp-testing`). Invoke every sibling whose signal appears in the work.

For backend service design or review work in any language (module boundaries, DDD aggregates, CQRS, error modeling, outbox/inbox, idempotency, locks, multi-tenancy, rate limiting, caching, resilience, security hardening, observability, migrations, testing strategy, CI), invoke the **`backend-engineering`** skill before the first edit and open every reference whose signal matches.

## Skill names in opencode

opencode invokes skills by their **bare folder name** through the `skill` tool, e.g. `skill({ name: "csharp" })`. The skill text refers to skills as `yusufcirak-skills:<name>`; that `yusufcirak-skills:` prefix is the Claude Code plugin namespace. **Ignore it in opencode** and use the bare name:

| Skill text says | Use in opencode |
|---|---|
| `yusufcirak-skills:csharp` | `csharp` |
| `yusufcirak-skills:csharp-ddd` | `csharp-ddd` |
| `yusufcirak-skills:csharp-web-api` | `csharp-web-api` |
| `yusufcirak-skills:csharp-validation` | `csharp-validation` |
| `yusufcirak-skills:csharp-hardening` | `csharp-hardening` |
| `yusufcirak-skills:csharp-observability` | `csharp-observability` |
| `yusufcirak-skills:csharp-testing` | `csharp-testing` |
| `yusufcirak-skills:backend-engineering` | `backend-engineering` |

Flow: `skill({ name: "csharp" })` first, then invoke each sibling its signal table matches.
