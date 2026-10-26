# yusufcirak-skills for opencode

The same skills that ship as the Claude Code plugin `yusufcirak-skills` also run in
[opencode](https://opencode.ai). opencode reads `SKILL.md` files natively and has a built-in
`skill` tool, so the **same skill files** are reused: no duplication, single source of truth
under `../skills/<bucket>/<skill>/`.

The always-on router instruction (the opencode equivalent of the Claude Code `SessionStart` hook,
`hooks/inject-router.js`) is injected by the `plugins/dotnet-router.js` plugin through the
`session.hook("context")` hook of the **opencode v2** plugin API (`Plugin.define` from
`@opencode/plugin`). Unlike the Claude Code hook it does not detect the project stack: the banner
names both the `csharp` and the `backend-engineering` entry points. `AGENTS.md` is the fallback if
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

This places every skill from `skills/csharp/` and `skills/backend/` flat under
`~/.config/opencode/skills/` (`csharp/`, `csharp-ddd/`, `csharp-web-api/`, `csharp-validation/`,
`csharp-hardening/`, `csharp-observability/`, `csharp-testing/`, `backend-engineering/`),
preserving folder names so the relative `../csharp/references/...` links keep resolving. It also
copies `plugins/dotnet-router.js` to `~/.config/opencode/plugins/` and
`commands/wrap-session-lessons.md` to `~/.config/opencode/commands/` (`/wrap-session-lessons`).
`OPENCODE_CONFIG_DIR` overrides the target.

> **Upgrading from the old `dotnet` plugin layout:** the skill folders were renamed (`ddd` is now
> `csharp-ddd`, and so on). Delete the old `ddd/`, `web-api/`, `validation/`, `hardening/`,
> `observability/`, `testing/` folders from `~/.config/opencode/skills/` by hand; the sync script
> only writes the new names.

### 2. Enable auto-routing

The router plugin from step 1 is enough on opencode v2; restart opencode and it adds the banner to every request. Use **one** of the plugin or `AGENTS.md`, not both (double banner). Fallback without the plugin: copy the banner to your global opencode instructions:

```
cp opencode/AGENTS.md ~/.config/opencode/AGENTS.md
```

Or, if you already keep a global `~/.config/opencode/AGENTS.md` (opencode uses the first
matching global file, it does not merge), add this repo's `AGENTS.md` to the `instructions`
array in `opencode.json` instead:

```json
{
  "instructions": ["/abs/path/to/skills/opencode/AGENTS.md"]
}
```

## Usage

In a C# / .NET context, opencode invokes `csharp` first, then the siblings its signal table matches,
by **bare name** (the `yusufcirak-skills:` prefix in the skill text is the Claude Code plugin
namespace; ignore it here):

```
skill({ name: "csharp" })          # always, for any .cs edit
skill({ name: "csharp-web-api" })  # + whatever else the activity matches
skill({ name: "backend-engineering" })  # backend design/review work in any language
```

## Keeping in sync

The skills are edited once under `../skills/`. After editing, re-run
`node opencode/sync-skills.js` (copy mode), or use `--link` once so future edits propagate
without re-running.
