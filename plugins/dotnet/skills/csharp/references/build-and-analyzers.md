# Build & analyzers — gates, branch-aware style enforcement, generator packaging

Solution-wide build policy lives in `Directory.Build.props` / `Directory.Packages.props`. Security-flavoured analyzer
choices (NetAnalyzers, SecurityCodeScan) are in `dotnet:hardening` → Dependency & Supply Chain; this file owns the
*mechanics*: what fails the build, when style is enforced, and how generators are referenced.

## Analyzers are a gate, with documented exceptions

- `TreatWarningsAsErrors=true`, plus a pure-Roslyn analyzer such as **Meziantou.Analyzer** referenced from
  `Directory.Build.props` with `PrivateAssets="all"` (no runtime library, so nothing leaks to consumers).
- Every rule is an error **except** the few demoted in `WarningsNotAsErrors`, each with a comment saying why and how
  many hits it has (e.g. `MA0004` ConfigureAwait, `MA0048` file-name-matches-type, `MA0051` method length, `MA0026`
  TODO). A rule is demoted only when a mechanical mass-rewrite is not worth it — never to silence a real finding.
- **Introducing a new analyzer:** fix every hit of the rules that stay errors in the same change; demote the rest
  explicitly. Do not land an analyzer that is red or silently ignored.
- **NuGet audit (`NU1901`–`NU1904`)** stays a visible warning but not an error: the advisory database changes
  independently of your code, so a freshly published advisory must not break a green build. CI still fails on
  High/Critical via `dotnet list package --vulnerable --include-transitive`. Fix a flagged transitive package by
  pinning a patched version centrally (a `PackageVersion` plus a comment naming the advisory) in
  `Directory.Packages.props`.

## Branch-aware style enforcement

`EnforceCodeStyleInBuild` re-runs the style analyzers on every build. Enforce it where it catches mistakes (feature
branches, tight inner loop) and skip it on the main branch, which only receives already-gated code:

```xml
<PropertyGroup>
  <GitHeadPath>$(MSBuildThisFileDirectory).git\HEAD</GitHeadPath>
  <GitHeadContent Condition="Exists('$(GitHeadPath)')">$([System.IO.File]::ReadAllText('$(GitHeadPath)').Trim())</GitHeadContent>
  <GitBranch Condition="$(GitHeadContent.StartsWith('ref: refs/heads/'))">$(GitHeadContent.Substring(16))</GitBranch>
  <EnforceCodeStyleInBuild Condition="'$(GitBranch)' != 'main'">true</EnforceCodeStyleInBuild>
</PropertyGroup>
```

- The branch is read straight from `.git/HEAD` — no `git` process spawn per project.
- Detached HEAD, a missing `.git` (source-only checkout) or an unknown branch all satisfy `!= main` and **fail safe to
  enabled**. Use your real default-branch name.

## Packaging generators and analyzers (`PrivateAssets`)

| Package kind | Reference | Why |
|---|---|---|
| Pure Roslyn analyzer (Meziantou, Roslynator) | `PrivateAssets="all"` | nothing at runtime |
| Generator **with a runtime library** (Vogen → `Vogen.SharedTypes`, EF Projectables) | `PrivateAssets="analyzers"` | `"all"` compiles, then throws `FileNotFoundException` at runtime |

- The exact Vogen reference is `<PackageReference Include="Vogen" ExcludeAssets="contentFiles" PrivateAssets="analyzers" />`
  (same pair in `strongly-typed-ids-and-value-objects.md`). `ExcludeAssets="contentFiles"` hides its redundant
  `Vogen.targets` node in the IDE (the real one ships in `buildTransitive/` and is unaffected).
- **Reference a generator only in the projects that use its output.** A generator re-runs in every project that
  references it; scoping generators to their own projects cut `CoreCompile` by ~88% in a 23-project solution.
- **Prefer the plain package over its "drop-in generator" variant** when you only need the runtime types: `ZLinq`,
  not `ZLinq.DropInGenerator`, whose codegen (shadowing `System.Linq`) re-ran in all 23 projects and was the single
  largest source-generator cost.
- Ubiquitous libraries (`ZLinq`, the Result/Option library) can get a global `<Using Include="…" />` in
  `Directory.Build.props`; keep that list tiny.

## Diagnosing a slow build

Do not guess (ZLinq? central package management?) — capture a binlog: `dotnet build -bl`, then rank projects and
targets by time and separate compiler, analyzer and generator cost. `dotnet:msbuild` and the `dotnet-msbuild`
build-perf skills cover the investigation.
