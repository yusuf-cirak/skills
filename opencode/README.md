# dotnet for opencode

The same C# / .NET standards that ship as the Claude Code plugin `dotnet` also run in
[opencode](https://opencode.ai). opencode reads `SKILL.md` files natively and has a built-in
`skill` tool, so the **same skill files** are reused — no duplication, single source of truth
under `../plugins/dotnet/skills/`.

The always-on router instruction (the opencode equivalent of the Claude Code `SessionStart` hook) is
injected by the `plugins/dotnet-router.js` plugin through the `session.hook("context")` hook of the
**opencode v2** plugin API (`Plugin.define` from `@opencode/plugin`). `AGENTS.md` is the fallback if
you prefer not to run a plugin.

> **v1 vs v2:** v2 only loads plugins that `export default Plugin.define({ id, setup })`; v1-style
> plugins (`export const X = async () => ({ hooks })`) fail to load with
> `Plugin must export a default definition with an id and an effect or setup function`.
> The v1 version of the router is kept in `legacy/dotnet-router.v1.js` (not synced by default);
> copy it to `~/.config/opencode/plugins/` by hand on opencode 1.x.

## Install

### 1. Sync skills, plugin and commands

```
node opencode/sync-skills.js          # copy into ~/.config/opencode/skills/
node opencode/sync-skills.js --link   # or symlink (true single-source; re-edits propagate)
```

This places `csharp/`, `ddd/`, `web-api/`, `validation/`, `hardening/`,
`observability/`, `testing/` under `~/.config/opencode/skills/`, preserving folder names so the
relative `../csharp/references/...` links keep resolving. It also copies `plugins/dotnet-router.js`
to `~/.config/opencode/plugins/` and `commands/wrap-session-lessons.md` to
`~/.config/opencode/commands/` (`/wrap-session-lessons`). `OPENCODE_CONFIG_DIR` overrides the target.

> **Name-collision note:** opencode keys skills by folder name, so generic names like
> `testing` share the global `~/.config/opencode/skills/` namespace. If you already have skills
> with those names, prefer the project-scoped dir `./.opencode/skills/` instead, or rename.

### 2. Enable auto-routing

The router plugin from step 1 is enough on opencode v2; restart opencode and it adds the banner to every request. Use **one** of the plugin or `AGENTS.md`, not both (double banner). Fallback without the plugin: copy the banner to your global opencode instructions:

```
cp opencode/AGENTS.md ~/.config/opencode/AGENTS.md
```

…or, if you already keep a global `~/.config/opencode/AGENTS.md` (opencode uses the first
matching global file — it does not merge), add this repo's `AGENTS.md` to the `instructions`
array in `opencode.json` instead:

```json
{
  "instructions": ["/abs/path/to/skills/opencode/AGENTS.md"]
}
```

## Usage

In a C# / .NET context, opencode invokes `csharp` first, then the siblings its signal table matches —
by **bare name** (the `dotnet:` prefix in the router text is the Claude Code namespace; ignore
it here):

```
skill({ name: "csharp" })  # always, for any .cs edit
skill({ name: "web-api" })  # + whatever else the activity matches
```

## Keeping in sync

The skills are edited once under `../plugins/dotnet/skills/`. After editing, re-run
`node opencode/sync-skills.js` (copy mode) — or use `--link` once so future edits propagate
without re-running.
