# Build & analyzers — gates and policy

Solution-wide build policy lives in `Directory.Build.props` / `Directory.Packages.props`. Security-flavoured analyzer choices (NetAnalyzers, SecurityCodeScan) are in `yusufcirak-skills:csharp-hardening` → Dependency & Supply Chain; this file owns what fails the build. Props snippets, `PrivateAssets` rules, generator scoping and slow-build diagnosis: `setups/build-analyzers.md`.

## Analyzers are a gate, with documented exceptions

- `TreatWarningsAsErrors=true`, plus a pure-Roslyn analyzer such as **Meziantou.Analyzer** referenced from `Directory.Build.props`.
- Every rule is an error **except** the few demoted in `WarningsNotAsErrors`, each with a comment saying why and how many hits it has (e.g. `MA0004` ConfigureAwait, `MA0048` file-name-matches-type, `MA0051` method length, `MA0026` TODO). A rule is demoted only when a mechanical mass-rewrite is not worth it, never to silence a real finding.
- **Introducing a new analyzer:** fix every hit of the rules that stay errors in the same change; demote the rest explicitly. Do not land an analyzer that is red or silently ignored.
- **NuGet audit (`NU1901`–`NU1904`)** stays a visible warning but not an error: the advisory database changes independently of your code, so a freshly published advisory must not break a green build. CI still fails on High/Critical via `dotnet list package --vulnerable --include-transitive`. Fix a flagged transitive package by pinning a patched version centrally (a `PackageVersion` plus a comment naming the advisory) in `Directory.Packages.props`.
- Style analyzers (`EnforceCodeStyleInBuild`) run on feature branches and are skipped on main, which only receives already-gated code.
- Reference a generator only in the projects that use its output, and give generators with a runtime library `PrivateAssets="analyzers"`, never `"all"`.
