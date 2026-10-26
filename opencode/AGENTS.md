# C# / .NET Auto-Standards (dotnet, opencode)

When working in any C# / .NET / ASP.NET Core context (files: `.cs`, `.csproj`, `.sln`, `.slnx`, `.razor`, `.cshtml`, `Directory.Build.props`, `Directory.Packages.props`, `global.json`; or topics: C#, .NET, ASP.NET Core, EF Core, DDD in .NET, xUnit/NUnit/MSTest), invoke the **`csharp`** skill via the `skill` tool before the first edit.

`csharp` holds the core style and a signal table for the sibling skills (`ddd`, `web-api`, `validation`, `hardening`, `observability`, `testing`). Invoke every sibling whose signal appears in the work.

## Skill names in opencode

opencode invokes skills by their **bare folder name** through the `skill` tool, e.g. `skill({ name: "csharp" })`. The skill text refers to sub-skills as `dotnet:<short>` — that `dotnet:` prefix is the Claude Code namespace; **ignore it in opencode** and use the bare name:

| Skill text says | Use in opencode |
|---|---|
| `dotnet:csharp` | `csharp` |
| `dotnet:ddd` | `ddd` |
| `dotnet:web-api` | `web-api` |
| `dotnet:validation` | `validation` |
| `dotnet:hardening` | `hardening` |
| `dotnet:observability` | `observability` |
| `dotnet:testing` | `testing` |

Flow: `skill({ name: "csharp" })` first → then invoke each sibling its signal table matches.
