# Monadic error handling

## Contents

- Railway Oriented Programming
- Related

Shared rule referenced by `yusufcirak-skills:csharp` (functional idioms), `yusufcirak-skills:csharp-ddd` (factory validation returns), and `yusufcirak-skills:csharp-validation` (VO factories).

## Railway Oriented Programming

Model a call chain as a two-track railway: success stays on the happy track, a failure switches to the error track and every later step short-circuits (`Bind`/`Map`/`Match` instead of `if (error) return` or `try`-`catch`). `Result<T>` (and `Option<T>` for "value or nothing") make this representable instead of exceptions or null checks. When a change touches a chain of fallible steps (validation, lookup, mutation, persist) that still uses exceptions or nullable returns, suggest switching that chain to ROP at the point where it is already being touched. Never silently rewrite unrelated code.

- Prefer monadic error handling over exceptions, and monadic optionals over nullable references.
- Use the project's existing `Result`/`Option` type (default `YC.Monad`). If none exists, recommend one and ask before adding it. Library selection flow: `setups/monads.md`.
- Mix functional and object-oriented patterns where appropriate.
- Follow .NET / ASP.NET Core conventions.
- Prefer composition over inheritance.

## Related

- `yusufcirak-skills:csharp` (`../csharp/SKILL.md`) — C# House Style
- `yusufcirak-skills:csharp-ddd` (`../csharp-ddd/SKILL.md`) — .NET Domain-Driven Design & Architecture
- `yusufcirak-skills:csharp-validation` (`../csharp-validation/SKILL.md`) — ASP.NET Core Input Security & Serialization Limits
