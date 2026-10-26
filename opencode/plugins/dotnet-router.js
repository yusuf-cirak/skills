// dotnet router plugin for opencode v2.
// opencode equivalent of the Claude Code SessionStart hook (plugins/dotnet/hooks/inject-router.js):
// appends the C# / .NET entry-point instruction to the system prompt of every model request, so
// the `csharp` skill is invoked for C# work without a block in the user's AGENTS.md.
// opencode v1 plugins use a different shape; the v1 version lives in ../legacy/.

import { Plugin } from "@opencode/plugin";

const MARKER = "# C# / .NET house style (dotnet)";

const banner = [
  MARKER,
  "",
  "For any C# / .NET / ASP.NET Core work (`.cs`, `.csproj`, `.sln`, `.slnx`, `.razor`, `.cshtml`, `Directory.Build.props`, `Directory.Packages.props`, `global.json`; or topics: C#, .NET, EF Core, DDD in .NET, xUnit/NUnit/MSTest), invoke the `csharp` skill with the `skill` tool before the first edit.",
  "",
  "`csharp` holds the core style and the signal table for the sibling skills (`ddd`, `web-api`, `validation`, `hardening`, `observability`, `testing`). Invoke every sibling whose signal appears in the work.",
  "",
  "Skill text names siblings as `dotnet:<name>` and tools by their Claude Code names. In opencode, use the bare skill name (`dotnet:ddd` -> `ddd`), the `skill` tool for `Skill`, and the `question` tool for `AskUserQuestion`.",
].join("\n");

export default Plugin.define({
  id: "dotnet-router",
  setup: async (ctx) => {
    await ctx.session.hook("context", (request) => {
      if (!request.system.some((part) => part.text.includes(MARKER))) {
        request.system.push({ type: "text", text: banner });
      }
    });
  },
});
