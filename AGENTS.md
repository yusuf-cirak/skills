Skills are organized into bucket folders under `skills/`:

- `csharp/`: C# / .NET / ASP.NET Core house style. `csharp` is the entry skill; every sibling is named `csharp-<topic>` (directory name and `name:` front matter must match, and the plugin ships them as `yusufcirak-skills:csharp-<topic>`).
- `backend/`: language-agnostic backend engineering rules.

Every skill under `skills/` is promoted: it must be listed in `.claude-plugin/plugin.json`'s `skills` array, linked from the top-level `README.md`, and linked from its bucket's `README.md`. The Claude Code plugin ships exactly that set. A skill in neither manifest nor README is a bug, not a draft.

Each bucket folder has a `README.md` that lists every skill in the bucket with a one-line description, with the skill name linked to its `SKILL.md`, grouped into **User-invoked** and **Model-invoked**. Every skill in this repo is model-invoked today, so the User-invoked group says so and stays empty until a skill sets `disable-model-invocation: true`.

`.claude-plugin/marketplace.json` is the repo's own marketplace (`yusufcirak`) and `plugin.json` is the single plugin (`yusufcirak-skills`, `source: "./"`). The install block in `README.md` is the one canonical install story (`/plugin marketplace add yusuf-cirak/skills`, `/plugin install yusufcirak-skills@yusufcirak`). Run `claude plugin validate . --strict` after touching either manifest, and bump `version` in `plugin.json` so installed machines pick the change up.

Cross-references between skills use two forms, and both must be kept in step when a skill is added or renamed:

- A Skill-tool invocation id: `yusufcirak-skills:<skill name>` (never the old `dotnet:` or `backend:` prefixes).
- A relative link to the file: `../csharp-ddd/SKILL.md`, `../csharp/references/<file>.md`. Links are relative so they resolve inside the plugin cache, under `~/.claude/skills`, and in opencode's flat `~/.config/opencode/skills/` layout. The shared C# references live only in `skills/csharp/csharp/references/`; sibling skills link to them and list every reference they (transitively) depend on under their `## Files` heading.

`python scripts/validate_skills.py` checks the C# bucket (front matter, name equals directory, length, `## Contents` index, reference reachability). `python scripts/check_links.py` checks every relative Markdown link in the repo. Run both before committing a skill change.

`skills/backend/backend-engineering/SKILL.md` and each of its references carry a generated `metadata.sections` index with `start` and `end` line numbers. Do not hand-edit those numbers, and do not change the line count of those files casually. After any edit that adds or removes lines, regenerate the index with the `add_section_index.py` helper (`python add_section_index.py skills/backend/backend-engineering`; it is idempotent).

The SessionStart hook (`hooks/hooks.json` plus `hooks/inject-router.js`) reads the session `cwd` from stdin, scans it, up to three parents and one level of children for stack markers, and prints the `hookSpecificOutput.additionalContext` JSON Claude Code expects: the C# banner plus the backend banner when a .NET marker is found, the backend banner alone for Go, Rust, TypeScript/Node, Python or Java/Kotlin, and nothing when no stack is detected. It must never throw and must stay well under a second. `node scripts/test-hook.mjs` is its self-test; run it after touching the hook. The opencode router (`opencode/plugins/dotnet-router.js`) is the static equivalent and names both entry points.

`commands/` holds the plugin-level slash commands. `opencode/` mirrors the skills into opencode via `sync-skills.js`, which reads every `skills/<bucket>/<skill>/` directory, so a new skill needs no change there.

No em-dashes anywhere in prose written for this repo (`SKILL.md` files, READMEs, this file, code comments). Where a sentence reaches for one, rewrite it with a comma, colon, period, parentheses, or a conjunction. Existing skill bodies imported from the old repos still contain some; remove them when you touch the sentence, never by a blind character substitution.
