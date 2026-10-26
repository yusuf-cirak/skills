// dotnet router plugin for opencode.
// opencode equivalent of the Claude Code SessionStart hook (plugins/dotnet/hooks/inject-router.js):
// appends the C# / .NET entry-point instruction to the system prompt of every request, so the
// `csharp` skill is invoked for C# work without a block in the user's AGENTS.md.
// Uses the experimental `experimental.chat.system.transform` hook (@opencode-ai/plugin >= 1.4).

const banner = [
  "# C# / .NET house style (dotnet)",
  "",
  "For any C# / .NET / ASP.NET Core work (`.cs`, `.csproj`, `.sln`, `.slnx`, `.razor`, `.cshtml`, `Directory.Build.props`, `Directory.Packages.props`, `global.json`; or topics: C#, .NET, EF Core, DDD in .NET, xUnit/NUnit/MSTest), invoke the `csharp` skill with the `skill` tool before the first edit.",
  "",
  "`csharp` holds the core style and the signal table for the sibling skills (`ddd`, `web-api`, `validation`, `hardening`, `observability`, `testing`). Invoke every sibling whose signal appears in the work.",
  "",
  "Skill text names siblings as `dotnet:<name>` and tools by their Claude Code names. In opencode, use the bare skill name (`dotnet:ddd` -> `ddd`), the `skill` tool for `Skill`, and the `question` tool for `AskUserQuestion`.",
].join("\n");

export const DotnetRouter = async () => ({
  "experimental.chat.system.transform": async (_input, output) => {
    if (!output.system.some((s) => s.includes("# C# / .NET house style (dotnet)"))) {
      output.system.push(banner);
    }
  },
});
