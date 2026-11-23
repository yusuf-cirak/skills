# Setup: Result and Option library

Load when a project has no `Result<T>` / `Option<T>` type yet, or when choosing which one to use. The idea (railway-oriented error handling) lives in `../monads.md`.

## Library selection (check before writing)

1. Project references **`YC.Monad`** (check `.csproj`, `Directory.Packages.props`, `global.json`): use its `Result<T>` and `Option<T>`. This is the default.
2. Otherwise use what the codebase already has (`OneOf`, `LanguageExt`, `ErrorOr`, `CSharpFunctionalExtensions`, or a hand-rolled type). Match it, never add a competing library.
3. Nothing equivalent exists: recommend introducing one instead of defaulting to exceptions or nullable returns. Suggest `YC.Monad` first (source-gen friendly, no reflection), name the others as alternatives, and ask before adding the package. A hand-rolled `Result<T>` / `Option<T>` is a fine zero-dependency fallback.

Quick check: `grep -r "YC.Monad" *.csproj Directory.Packages.props` or inspect `using` directives in existing handlers.
