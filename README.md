# yusufcirak-skills

Personal coding standards for AI coding agents, shipped as one Claude Code plugin from this repo's own marketplace (`yusufcirak`). Two buckets: the C# / .NET house style behind the `csharp` entry point, and language-agnostic backend engineering rules behind `backend-engineering`.

## Install

```
/plugin marketplace add yusuf-cirak/skills
/plugin install yusufcirak-skills@yusufcirak
```

Skills are then invoked as `yusufcirak-skills:<name>`, for example `yusufcirak-skills:csharp`. The plugin also ships `/wrap-session-lessons`, which extracts reusable lessons from a session and files them into the right skill.

### Migrating from the old `dotnet` and `backend` plugins

The two plugins became one. Uninstall both, re-add the marketplace (its key is unchanged) and install the single plugin:

```
/plugin uninstall dotnet@yusufcirak
/plugin uninstall backend@yusufcirak
/plugin marketplace remove yusufcirak
/plugin marketplace add yusuf-cirak/skills
/plugin install yusufcirak-skills@yusufcirak
/reload-plugins
```

Skill names changed: `dotnet:csharp` is now `yusufcirak-skills:csharp`, every other `dotnet:<x>` is now `yusufcirak-skills:csharp-<x>` (`dotnet:ddd` is `yusufcirak-skills:csharp-ddd`), and `backend:backend-engineering` is now `yusufcirak-skills:backend-engineering`. If a `~/.claude/CLAUDE.md` block of yours names the old ids, update it. The same applies to anyone still registered on the older `yusuf-cirak/csharp-skills` repo.

## Skills

All skills are model-invoked: the agent reaches for them when the task fits, and you can also invoke them by name.

### C#

C# / .NET / ASP.NET Core house style. `csharp` is the entry point; it holds the core rules, the shared `references/`, and the signal table that routes to its siblings.

- **[csharp](./skills/csharp/csharp/SKILL.md)**: Core style (namespaces, immutable records with factories, discriminated unions, value objects, `Result<T>`, `TimeProvider`, typed HTTP clients) plus `references/` for LINQ, performance, async, composition, EF Core, caching, resilience, build and analyzers, outbox.
- **[csharp-ddd](./skills/csharp/csharp-ddd/SKILL.md)**: DDD tactical patterns, Modular Monolith and Vertical Slice layout, where new code lives.
- **[csharp-web-api](./skills/csharp/csharp-web-api/SKILL.md)**: Endpoint, handler and slice shape, mediator pipeline, FluentValidation basics, pagination, middleware order.
- **[csharp-validation](./skills/csharp/csharp-validation/SKILL.md)**: `InputLimits`, length-typed `Text` value objects, mandatory validator rules, JSON and Kestrel limits, output encoding.
- **[csharp-hardening](./skills/csharp/csharp-hardening/SKILL.md)**: Rate limiting, idempotency, authn/authz, security headers, crypto, EF hardening, SSRF, background jobs, supply chain, CI gates.
- **[csharp-observability](./skills/csharp/csharp-observability/SKILL.md)**: OpenTelemetry-native traces, metrics and logs over OTLP, correlation ids, health probes, SLOs.
- **[csharp-testing](./skills/csharp/csharp-testing/SKILL.md)**: Test layout and naming, AAA, asserting on monads, Testcontainers integration tests, architecture tests.

### Backend

- **[backend-engineering](./skills/backend/backend-engineering/SKILL.md)**: Language-agnostic rules and traps for production services, with 17 references (modular monolith, DDD tactical, CQRS pipeline, error model, outbox/inbox, idempotency and locking, multi-tenancy, rate limiting, caching, resilience, security hardening, untrusted input, observability, persistence and migrations, testing strategy, build/CI, API surface).

## SessionStart hook

`hooks/inject-router.js` runs once per session, reads the session `cwd`, and looks in that directory, up to three parent directories and one level of child directories for stack markers (`*.sln`, `*.slnx`, `*.csproj`, `Directory.Build.props`, `global.json`, `go.mod`, `Cargo.toml`, `package.json`, `pyproject.toml`, `requirements.txt`, `pom.xml`, `build.gradle*`). It then injects the matching entry-point instruction:

| Detected | Injected |
|---|---|
| C# / .NET | invoke `yusufcirak-skills:csharp` before the first edit, plus the backend rule below |
| Go, Rust, TypeScript/Node, Python, Java/Kotlin | invoke `yusufcirak-skills:backend-engineering` before the first edit on backend design or review work |
| nothing | nothing |

The scan skips `node_modules`, `.git`, `bin` and `obj`, never throws, and finishes well under a second. `node scripts/test-hook.mjs` exercises it against temp projects.

## opencode

The same skills run in [opencode](https://opencode.ai), which reads `SKILL.md` natively. See [opencode/README.md](./opencode/README.md) for the sync script, the router plugin and the `AGENTS.md` fallback.

## Layout

```
.claude-plugin/plugin.json        plugin "yusufcirak-skills": explicit skills array
.claude-plugin/marketplace.json   marketplace "yusufcirak", one plugin, source "./"
AGENTS.md                         repo invariants for agents
commands/                         /wrap-session-lessons
hooks/                            SessionStart -> inject-router.js (stack detection)
skills/csharp/<skill>/SKILL.md    csharp (entry, with references/) + csharp-* siblings
skills/backend/backend-engineering/SKILL.md + references/
opencode/                         opencode sync script, router plugin, AGENTS.md fallback
scripts/                          validate_skills.py, check_links.py, test-hook.mjs
```

## Editing workflow

Edit the canonical copies under `skills/`, run `python scripts/validate_skills.py`, `python scripts/check_links.py` and `node scripts/test-hook.mjs`, bump `version` in `.claude-plugin/plugin.json`, run `claude plugin validate . --strict`, commit. On installed machines, `/plugin marketplace update yusufcirak` pulls the new version. [AGENTS.md](./AGENTS.md) lists the invariants.
