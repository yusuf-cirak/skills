// dotnet router plugin for opencode.
// opencode equivalent of the Claude Code SessionStart hook (hooks/inject-router.js):
// appends the C# / .NET entry-point instruction to the system prompt of every request, so the
// `csharp` skill is invoked for C# work without a block in the user's AGENTS.md.
// Uses the experimental `experimental.chat.system.transform` hook (@opencode-ai/plugin >= 1.4).

const banner = [
  "# C# / .NET house style (yusufcirak-skills)",
  "",
  "For any C# / .NET / ASP.NET Core work (`.cs`, `.csproj`, `.sln`, `.slnx`, `.razor`, `.cshtml`, `Directory.Build.props`, `Directory.Packages.props`, `global.json`; or topics: C#, .NET, EF Core, DDD in .NET, xUnit/NUnit/MSTest), invoke the `csharp` skill with the `skill` tool before the first edit.",
  "",
  "`csharp` holds the core style and the signal table for the sibling skills (`csharp-ddd`, `csharp-web-api`, `csharp-validation`, `csharp-hardening`, `csharp-observability`, `csharp-testing`). Invoke every sibling whose signal appears in the work.",
  "",
  "Skill text names skills as `yusufcirak-skills:<name>` and tools by their Claude Code names. In opencode, use the bare skill name (`yusufcirak-skills:csharp-ddd` -> `csharp-ddd`), the `skill` tool for `Skill`, and the `question` tool for `AskUserQuestion`.",
].join("\n");

export const DotnetRouter = async () => ({
  "experimental.chat.system.transform": async (_input, output) => {
    if (!output.system.some((s) => s.includes("# C# / .NET house style (yusufcirak-skills)"))) {
      output.system.push(banner);
    }
  },
});
