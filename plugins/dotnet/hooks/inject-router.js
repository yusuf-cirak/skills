#!/usr/bin/env node
// dotnet SessionStart hook.
// Injects the C# / .NET entry point into every session so `dotnet:csharp` is invoked
// for C# work WITHOUT a manual block in the user's global CLAUDE.md.
// Claude Code reads the nested hookSpecificOutput.additionalContext shape; a top-level
// additionalContext is ignored.

const banner = [
  "# C# / .NET house style (dotnet)",
  "",
  "For any C# / .NET / ASP.NET Core work (`.cs`, `.csproj`, `.sln`, `.slnx`, `.razor`, `.cshtml`, `Directory.Build.props`, `Directory.Packages.props`, `global.json`; or topics: C#, .NET, EF Core, DDD in .NET, xUnit/NUnit/MSTest), invoke `dotnet:csharp` with the Skill tool before the first edit.",
  "",
  "`dotnet:csharp` holds the core style and the signal table for the sibling skills (`dotnet:ddd`, `dotnet:web-api`, `dotnet:validation`, `dotnet:hardening`, `dotnet:observability`, `dotnet:testing`). Invoke every sibling whose signal appears in the work.",
].join("\n");

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: banner,
    },
  }),
);
