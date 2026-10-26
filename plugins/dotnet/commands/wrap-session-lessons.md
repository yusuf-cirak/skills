---
description: Extract durable, generalizable lessons from this session's changes that aren't already in the C# skills, list them for approval, then add them to the skills repo and push.
argument-hint: "[optional focus, e.g. 'ef queries' or 'concurrency']"
allowed-tools: Bash(git *), Bash(ls *), Bash(find *), Bash(cat *), Read, Grep, Glob, Edit, Write, AskUserQuestion
---

# Wrap session lessons → C# skills

Capture what THIS session actually taught (the *why* behind decisions), keep only what's new and durable, get approval, add it to the skills repo, and push. Optional focus: `$ARGUMENTS`.

## Steps

1. **Locate the skills repo (git-backed source, NOT the cache).**
   - `ls -d ~/.claude/plugins/marketplaces/*/plugins/dotnet/skills` — that dir tree is the source of truth.
   - The shared references live in `skills/csharp/references/`; the entry point and routing table is `skills/csharp/SKILL.md`; sibling skills are `skills/<name>/SKILL.md`.
   - `git -C <repo-root> remote -v` and `git -C <repo-root> log --oneline -5` to confirm the repo and its commit style. NEVER edit the `~/.claude/plugins/cache/**` copies as the source — only sync them after (see step 7).

2. **Gather this session's changes.** Review the diffs/edits made in the working project this session and recall the decisions behind them. Focus on reusable rules, not the mechanical edits or repo-specific names.

3. **Extract candidate lessons.** One crisp bullet each: **the rule + the reason**. Generalize away project specifics (table/type names, business terms). Drop anything that's a one-off fact about this codebase — those belong in memory, not skills.

4. **De-duplicate against the existing skills.** `grep -ri` the skills dir for each candidate; **drop any lesson already covered**. Keep only genuinely new rules. If `$ARGUMENTS` names a focus, bias toward it.

5. **Present & ask — write NOTHING yet.** Show the surviving lessons as a numbered list. Use **AskUserQuestion** to confirm which to add (all / a subset / edits). Stop here until the user answers.

6. **Add the approved bullets** to the best-fitting existing file, matching its tone/format:
   - EF Core / query shaping / data access → `skills/csharp/references/ef-core-data-access.md`
   - C# language idioms → `skills/csharp/SKILL.md`; LINQ → `references/linq.md`; perf → `references/performance.md`; async/concurrency → `references/async-concurrency.md`; options/DI/library surface → `references/composition.md`
   - endpoints/handlers/mediator → `web-api`; DTO/validation limits → `validation`; security/resilience/caching → `hardening`; telemetry → `observability`; domain modeling → `ddd`; tests → `testing`.
   - Prefer appending to an existing section; add a new section only if none fits. Keep the split — don't dump everything in one file.

7. **Commit, push, sync.**
   - Commit in the skills repo only (never the working project): conventional `docs(<skill>): …`, body summarizing the rules, end with the required `Co-Authored-By` trailer.
   - Push following the repo's existing convention (if history goes straight to the default branch, do that; otherwise branch + PR).
   - Copy each edited source file over its counterpart under `~/.claude/plugins/cache/*/dotnet/*/skills/...` so the change is live this session too.
   - Report the pushed commit range.

## Guardrails
- Only durable, generalizable lessons. No secrets, credentials, or internal project details.
- Each bullet goes to the skill it belongs to — respect the family split.
- Touch only the skills repo when committing; never push the working project.
