#!/usr/bin/env python3
"""Check that every relative Markdown link in the repo resolves. Usage: python scripts/check_links.py"""
import re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
errs = []

for md in sorted(root.rglob("*.md")):
    if ".git" in md.parts or "node_modules" in md.parts:
        continue
    for target in LINK.findall(md.read_text(encoding="utf-8")):
        if re.match(r"[a-z]+:", target) or target.startswith("#"):
            continue  # http(s):, mailto: or in-page anchor
        if not (md.parent / target.split("#", 1)[0]).exists():
            errs.append(f"{md.relative_to(root)}: broken link {target}")

print("\n".join(errs) or "OK")
sys.exit(1 if errs else 0)
