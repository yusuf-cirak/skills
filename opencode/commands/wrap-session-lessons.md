---
description: Extract durable, generalizable lessons from this session's changes that aren't already in the C# skills, list them for approval, then add them to the skills repo and push.
---

# Wrap session lessons -> C# skills

Capture what THIS session actually taught (the *why* behind decisions), keep only what's new and durable, get approval, add it to the skills repo, and push. Optional focus: `$ARGUMENTS`.

## Steps

1. **Locate the skills repo (git-backed source, NOT the synced copy).**
   - Resolve where `~/.config/opencode/skills/csharp` points (a junction/symlink from `node opencode/sync-skills.js --link`). The repo root is three levels above the `csharp` folder (`<repo>/plugins/dotnet/skills/csharp`).
   - If it is a plain copy (no link), ask the user for the repo path. Never edit `~/.config/opencode/skills/**` as the source.
   - `git -C <repo-root> remote -v` and `git -C <repo-root> log --oneline -5` to confirm the repo and its commit style.
   - Shared references live in `skills/csharp/references/`; the entry point and routing table is `skills/csharp/SKILL.md`; sibling skills are `skills/<name>/SKILL.md`.

2. **Gather this session's changes.** Review the diffs/edits made in the working project this session and recall the decisions behind them. Focus on reusable rules, not the mechanical edits or repo-specific names.

3. **Extract candidate lessons.** One crisp bullet each: **the rule + the reason**. Generalize away project specifics (table/type names, business terms). Drop one-off facts about this codebase.

4. **De-duplicate against the existing skills.** Grep the skills dir for each candidate and drop any lesson already covered. If `$ARGUMENTS` names a focus, bias toward it.

5. **Present & ask: write NOTHING yet.** Show the surviving lessons as a numbered list. Ask which to add (all / a subset / edits) with the `question` tool, and stop until the user answers.

6. **Add the approved bullets** to the best-fitting existing file, matching its tone/format:
   - EF Core / query shaping / data access -> `skills/csharp/references/ef-core-data-access.md`
   - C# idioms -> `skills/csharp/SKILL.md`; LINQ -> `references/linq.md`; perf -> `references/performance.md`; async -> `references/async-concurrency.md`; options/DI/library surface -> `references/composition.md`; root client + sub-clients -> `references/root-client.md`
   - endpoints/handlers/mediator -> `web-api`; DTO/validation limits -> `validation`; security/resilience/caching -> `hardening`; telemetry -> `observability`; domain modeling -> `ddd`; tests -> `testing`.
   - Prefer appending to an existing section; add a new section only if none fits.

7. **Validate, commit, push.**
   - Run `python scripts/validate_skills.py` in the repo; fix anything it reports.
   - Commit in the skills repo only (never the working project): conventional `docs(<skill>): ...`, body summarizing the rules.
   - Push following the repo's existing convention (history goes straight to the default branch).
   - If the skills were copied (not linked), re-run `node opencode/sync-skills.js`.
   - Report the pushed commit range.

## Guardrails
- Only durable, generalizable lessons. No secrets, credentials, or internal project details.
- Each bullet goes to the skill it belongs to.
- Touch only the skills repo when committing; never push the working project.
