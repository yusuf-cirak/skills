# Setup: analyzers, generators and build props

Load when adding an analyzer or source generator package, editing `Directory.Build.props`, or chasing a slow build. The policy (analyzers are a gate, NuGet audit stays a warning) lives in `../build-and-analyzers.md`.

## Branch-aware style enforcement

`EnforceCodeStyleInBuild` re-runs the style analyzers on every build. Enforce it on feature branches and skip it on main, which only receives already-gated code:

```xml
<PropertyGroup>
  <GitHeadPath>$(MSBuildThisFileDirectory).git\HEAD</GitHeadPath>
  <GitHeadContent Condition="Exists('$(GitHeadPath)')">$([System.IO.File]::ReadAllText('$(GitHeadPath)').Trim())</GitHeadContent>
  <GitBranch Condition="$(GitHeadContent.StartsWith('ref: refs/heads/'))">$(GitHeadContent.Substring(16))</GitBranch>
  <EnforceCodeStyleInBuild Condition="'$(GitBranch)' != 'main'">true</EnforceCodeStyleInBuild>
</PropertyGroup>
```

- The branch is read straight from `.git/HEAD`, so no `git` process is spawned per project.
- Detached HEAD, a missing `.git` or an unknown branch all satisfy `!= main` and fail safe to enabled. Use the real default-branch name.

## Packaging generators and analyzers (`PrivateAssets`)

| Package kind | Reference | Why |
|---|---|---|
| Pure Roslyn analyzer (Meziantou, Roslynator) | `PrivateAssets="all"` | nothing at runtime |
| Generator with a runtime library (Vogen with `Vogen.SharedTypes`, EF Projectables) | `PrivateAssets="analyzers"` | `"all"` compiles, then throws `FileNotFoundException` at runtime |

- Vogen: `<PackageReference Include="Vogen" ExcludeAssets="contentFiles" PrivateAssets="analyzers" />`. `ExcludeAssets="contentFiles"` hides its redundant `Vogen.targets` node in the IDE (the real one ships in `buildTransitive/` and is unaffected).
- Reference a generator only in the projects that use its output. A generator re-runs in every project that references it, and scoping generators cut `CoreCompile` by about 88% in a 23-project solution.
- Prefer the plain package over its "drop-in generator" variant when only the runtime types are needed: `ZLinq`, not `ZLinq.DropInGenerator`, whose codegen re-ran in all 23 projects and was the largest generator cost.
- Ubiquitous libraries (`ZLinq`, the Result/Option library) can get a global `<Using Include="..." />` in `Directory.Build.props`. Keep that list tiny.

## Diagnosing a slow build

Do not guess. Capture a binlog with `dotnet build -bl`, then rank projects and targets by time and separate compiler, analyzer and generator cost. `dotnet:msbuild` and the `dotnet-msbuild` build-perf skills cover the investigation.
