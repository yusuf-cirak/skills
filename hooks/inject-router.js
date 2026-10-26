#!/usr/bin/env node
// yusufcirak-skills SessionStart hook.
// Detects the project stack from the session cwd and injects the matching entry-point
// instruction so the right skill is invoked WITHOUT a manual block in the user's CLAUDE.md:
//   C# / .NET detected            -> C# house-style banner + backend banner
//   other server stack detected   -> backend banner only
//   nothing detected              -> no output (a silent SessionStart hook adds no context)
// Claude Code reads the nested hookSpecificOutput.additionalContext shape; a top-level
// additionalContext is ignored. Never throws: any failure degrades to "nothing detected".

const fs = require("fs");
const path = require("path");

const CSHARP = "csharp";

// marker file name (exact, or a prefix when it ends with "*") -> stack
const MARKERS = [
  [".sln", CSHARP, "suffix"],
  [".slnx", CSHARP, "suffix"],
  [".csproj", CSHARP, "suffix"],
  ["Directory.Build.props", CSHARP],
  ["global.json", CSHARP],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["package.json", "typescript"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["pom.xml", "java"],
  ["build.gradle", "java", "prefix"],
];

const SKIP_DIRS = new Set(["node_modules", ".git", "bin", "obj"]);
const PARENT_LEVELS = 3;
const MAX_CHILD_DIRS = 200;

const csharpBanner = [
  "# C# / .NET house style (yusufcirak-skills)",
  "",
  "For any C# / .NET / ASP.NET Core work (`.cs`, `.csproj`, `.sln`, `.slnx`, `.razor`, `.cshtml`, `Directory.Build.props`, `Directory.Packages.props`, `global.json`; or topics: C#, .NET, EF Core, DDD in .NET, xUnit/NUnit/MSTest), invoke `yusufcirak-skills:csharp` with the Skill tool before the first edit.",
  "",
  "`yusufcirak-skills:csharp` holds the core style and the signal table for the sibling skills (`yusufcirak-skills:csharp-ddd`, `yusufcirak-skills:csharp-web-api`, `yusufcirak-skills:csharp-validation`, `yusufcirak-skills:csharp-hardening`, `yusufcirak-skills:csharp-observability`, `yusufcirak-skills:csharp-testing`). Invoke every sibling whose signal appears in the work.",
].join("\n");

const backendBanner = [
  "# Backend engineering house rules (yusufcirak-skills)",
  "",
  "For any backend service design or review work in any language (module boundaries / modular monolith, DDD aggregates, CQRS pipelines, error modeling, outbox/inbox, idempotency, locks, multi-tenancy, rate limiting, caching, resilience, security hardening, observability, migrations, testing strategy, CI), invoke `yusufcirak-skills:backend-engineering` with the Skill tool before the first edit.",
  "",
  "`yusufcirak-skills:backend-engineering` holds the cross-cutting rules and the signal table for its `references/`. Open every reference whose signal appears in the work, not just the closest one.",
].join("\n");

function stacksIn(dir, found) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    for (const [marker, stack, mode] of MARKERS) {
      const hit =
        mode === "suffix" ? name.endsWith(marker) : mode === "prefix" ? name.startsWith(marker) : name === marker;
      if (hit) found.add(stack);
    }
  }
}

function childDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name))
      .slice(0, MAX_CHILD_DIRS)
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function detect(cwd) {
  const found = new Set();
  const dirs = [cwd];
  let dir = cwd;
  for (let i = 0; i < PARENT_LEVELS; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dirs.push(parent);
    dir = parent;
  }
  dirs.push(...childDirs(cwd));
  for (const d of dirs) stacksIn(d, found);
  return found;
}

function readCwd() {
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    if (typeof input.cwd === "string" && input.cwd) return input.cwd;
  } catch {
    // no or malformed stdin: fall back to the process cwd
  }
  return process.cwd();
}

function main() {
  const stacks = detect(readCwd());
  if (stacks.size === 0) return;
  const banner = stacks.has(CSHARP) ? `${csharpBanner}\n\n${backendBanner}` : backendBanner;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: banner,
      },
    }),
  );
}

try {
  main();
} catch {
  // never fail the session start
}
process.exitCode = 0;
