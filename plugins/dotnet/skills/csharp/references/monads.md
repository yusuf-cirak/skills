# Monadic error handling — library selection & usage

## Contents

- Railway Oriented Programming
- Related

Shared rule referenced by `dotnet:csharp` (functional idioms), `dotnet:ddd` (factory validation returns), and `dotnet:validation` (VO factories).

## Railway Oriented Programming

The pattern this section is actually about: model a call chain as a two-track railway — success stays
on the happy track, a failure switches to the error track and every subsequent step short-circuits
(`Bind`/`Map`/`Match` instead of `if (error) return`/`try`-`catch`). `Result<T>` (and `Option<T>` for
"value or nothing") are the types that make this representable instead of exceptions or null checks.
When a change touches a chain of fallible steps — validation → lookup → mutation → persist — and the
codebase is still doing it with exceptions or nullable-return + `if`-checks, **proactively suggest**
switching that chain to Railway Oriented Programming (ROP) with whichever `Result<T>` library applies
below, even if the project doesn't reference one yet. Don't silently rewrite unrelated code to ROP —
suggest it at the point where the chain is already being touched.

- Prefer monadic error handling over exceptions, and monadic optionals over nullable references.
- **Library selection (check before writing):**
  1. If the project references **`YC.Monad`** (check `.csproj`/`Directory.Packages.props`/`global.json`), use `Result<T>` and `Option<T>` from it. This is the default preference.
  2. Otherwise, use whatever the existing codebase already uses — e.g. `OneOf`, `LanguageExt`, `ErrorOr`, `CSharpFunctionalExtensions`, or a hand-rolled `Result`/`Option` type. Match the project's convention; do not introduce a competing library.
  3. If no equivalent exists in the codebase yet, **recommend introducing one** rather than defaulting to
     exceptions/nullable-return — this is where ROP actually earns its keep. Suggest `YC.Monad` first
     (source-gen friendly, no reflection), name `ErrorOr`/`CSharpFunctionalExtensions`/`LanguageExt` as
     alternatives, and **ask before adding the package**. A hand-rolled `Result<T>`/`Option<T>` (see the
     base pattern this skill set already documents) is a fine zero-dependency fallback if the user would
     rather not take on a library.
- Quick check command: `grep -r "YC.Monad" *.csproj Directory.Packages.props 2>/dev/null` or inspect `using` directives in existing handlers.
- Mix functional and object-oriented patterns where appropriate.
- Follow .NET / ASP.NET Core conventions.
- Prefer composition over inheritance.

## Related

- `dotnet:csharp` (`../csharp/SKILL.md`) — C# House Style
- `dotnet:ddd` (`../ddd/SKILL.md`) — .NET Domain-Driven Design & Architecture
- `dotnet:validation` (`../validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
