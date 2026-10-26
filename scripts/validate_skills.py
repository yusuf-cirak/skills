#!/usr/bin/env python3
"""Check skills against Anthropic's skill best practices. Usage: python scripts/validate_skills.py"""
import re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent / "plugins" / "dotnet" / "skills"
errs = []

def read(p): return p.read_text(encoding="utf-8")

for skill in sorted(root.glob("*/SKILL.md")):
    s = read(skill); n = len(s.splitlines())
    m = re.match(r"---\nname: (.+)\ndescription: (.+)\n---\n", s)
    if not m: errs.append(f"{skill}: bad frontmatter"); continue
    name, desc = m.groups()
    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", name) or len(name) > 64: errs.append(f"{skill}: bad name")
    if name != skill.parent.name: errs.append(f"{skill}: name '{name}' != folder (opencode requires a match)")
    if len(desc) > 1024: errs.append(f"{skill}: description {len(desc)} > 1024")
    if re.search(r"\b(I|you|your)\b", desc): errs.append(f"{skill}: description not third person")
    if n > 500: errs.append(f"{skill}: {n} lines > 500")

for f in sorted(root.rglob("*.md")):
    s = read(f); head = "\n".join(s.splitlines()[:100])
    if "\\" in "".join(re.findall(r"\]\(([^)]*)\)", s)): errs.append(f"{f}: backslash path")
    # headings outside code fences
    fence = False; heads = []
    for i, l in enumerate(s.splitlines(), 1):
        if l.startswith("```"): fence = not fence
        if not fence and l.startswith("## "): heads.append((i, l[3:].strip()))
    if len(s.splitlines()) > 100 or f.name == "SKILL.md":
        if "## Contents" not in head: errs.append(f"{f}: no '## Contents' in first 100 lines")
        for i, h in heads:
            if i > 100 and h not in head: errs.append(f"{f}:{i}: heading '{h}' missing from first 100 lines")
    # path references must resolve
    for r in set(re.findall(r"`((?:\.\./)?(?:csharp/)?(?:references/)?[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*\.md)`", s)):
        if not any((base / r).exists() for base in (f.parent, root, root / "csharp", root / "csharp/references")):
            errs.append(f"{f}: broken reference {r}")

# reachability: every reference file must be listed in each SKILL.md that (transitively) links to it
refs = {p.name: read(p) for p in (root / "csharp/references").glob("*.md")}
for skill in sorted(root.glob("*/SKILL.md")):
    s = read(skill); seen = set(); stack = [r for r in refs if r in s]
    while stack:
        x = stack.pop()
        if x in seen: continue
        seen.add(x); stack += [r for r in refs if r != x and r in refs[x]]
    files = s.split("## Files", 1)[-1]
    for r in seen:
        if r not in files and not (skill.parent.name == "csharp" and r in s): errs.append(f"{skill}: nested reference {r} not in Files")

print("\n".join(errs) or "OK")
sys.exit(1 if errs else 0)
