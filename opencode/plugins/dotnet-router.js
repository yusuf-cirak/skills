// yusufcirak-skills router plugin for opencode v2.
// opencode equivalent of the Claude Code SessionStart hook (hooks/inject-router.js):
// appends the C# / .NET and backend entry-point instructions to the system prompt of every model
// request, so the `csharp` / `backend-engineering` skills are invoked without a block in the
// user's AGENTS.md. opencode has no per-session cwd hook here, so the banner is static.
// opencode v1 plugins use a different shape; the v1 version lives in ../legacy/.

import { Plugin } from "@opencode/plugin";

const MARKER = "# C# / .NET house style (yusufcirak-skills)";

const banner = [
  MARKER,
  "",
  "For any C# / .NET / ASP.NET Core work (`.cs`, `.csproj`, `.sln`, `.slnx`, `.razor`, `.cshtml`, `Directory.Build.props`, `Directory.Packages.props`, `global.json`; or topics: C#, .NET, EF Core, DDD in .NET, xUnit/NUnit/MSTest), invoke the `csharp` skill with the `skill` tool before the first edit.",
  "",
  "`csharp` holds the core style and the signal table for the sibling skills (`csharp-ddd`, `csharp-web-api`, `csharp-validation`, `csharp-hardening`, `csharp-observability`, `csharp-testing`). Invoke every sibling whose signal appears in the work.",
  "",
  "For backend service design or review work in any language (module boundaries, DDD aggregates, CQRS, error modeling, outbox/inbox, idempotency, locks, multi-tenancy, rate limiting, caching, resilience, security hardening, observability, migrations, testing strategy, CI), invoke the `backend-engineering` skill before the first edit and open every reference whose signal matches.",
  "",
  "Skill text names skills as `yusufcirak-skills:<name>` and tools by their Claude Code names. In opencode, use the bare skill name (`yusufcirak-skills:csharp-ddd` -> `csharp-ddd`), the `skill` tool for `Skill`, and the `question` tool for `AskUserQuestion`.",
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
