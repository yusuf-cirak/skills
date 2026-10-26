"""Idempotently add front matter (metadata.sections with start/end lines) and Golden path lines
to the backend-engineering skill. Run: python add_section_index.py <skill_dir>"""
import re
import sys
from pathlib import Path

GOLDEN = {
    "architecture-modular-monolith": "One deployable; modules own their data and talk only through a published contracts package and events; enforce the dependency direction with an executable rule.",
    "ddd-tactical": "Build aggregates only through factories that return success-or-error, give every aggregate its own id type, keep cross-cutting ports out of the domain layer, and raise events inside the aggregate.",
    "cqrs-use-case-pipeline": "One request, one handler; cross-cutting checks are pipeline steps opted into by marker; declare the step order in one place and test it.",
    "error-model": "Expected failures are values with code, message and status, mapped to the wire format in exactly one place; exceptions are for bugs and invariant violations.",
    "outbox-inbox-messaging": "Write the event row in the same transaction as the state change, run exactly one relay, deliver at-least-once, and make every consumer idempotent with a unique (message id, consumer) marker.",
    "idempotency-locking-concurrency": "Scope idempotency keys by caller and tenant, claim them atomically, use a renewing non-blocking lock only for genuinely-once work, and detect lost updates with a database-maintained version.",
    "persistence-migrations": "Derive names by convention, make writes explicit about tracking, migrate with expand/contract, clamp page size at the boundary, and prefer keyset paging at scale.",
    "multi-tenancy": "Apply the tenant predicate automatically on reads, enforce it fail-closed on every write path, resolve the tenant from a trusted source, and keep the bypass explicit and greppable.",
    "rate-limiting-load-shedding": "Key limits on the authenticated principal or server-observed IP plus the matched route template, count in one authoritative store, shield it with an equal-cap local limiter, and fail open with a metric.",
    "caching": "Use a two-level cache with single-flight, stale-while-revalidate and cross-node invalidation from a library; never cache counters or freshness-critical decisions.",
    "resilience-lifecycle": "Bound every client-controlled resource and every outbound call, split probes into startup/liveness/readiness, flip readiness at SIGTERM, and keep a written fail-open/closed list.",
    "security-hardening": "Deny by default, validate issuer, audience, lifetime and signature with tight skew, keep a revocation path, trust proxy headers only from known proxies, and mask logs by key name.",
    "untrusted-input-outbound": "Treat attacker-influenced data as data: parameterise queries, guard every caller-chosen outbound URL against internal ranges, validate uploads by content, and isolate untrusted text in prompts.",
    "observability": "One resource identity across traces, metrics and logs; correlation and causation ids carried in ambient context across every hop; masking applied in the log pipeline.",
    "testing-strategy": "Unit tests for logic, executable architecture rules for dependency direction, and a few integration tests against real infrastructure for what fakes cannot prove.",
    "build-ci-performance": "Warnings fail the build with an explicit exception list, versions are pinned in one place, and performance work starts with a measurement and removes round trips before allocations.",
    "api-surface": "Declare cross-cutting policy on the route, version from day one, clamp pagination at the boundary, and keep one documented middleware order.",
}

SKILL_NAME = "backend-engineering"
SKILL_DESC = (
    "Language-agnostic backend engineering rules and traps for production services. "
    "Use when designing or reviewing a backend service, modular monolith, or API in any language "
    "(Go, Rust, TypeScript, C#, ...): module boundaries, DDD aggregates and value objects, CQRS pipelines, "
    "error modeling, transactional outbox/inbox, idempotency, distributed locks, multi-tenancy, rate limiting, "
    "caching, resilience, security hardening, observability, migrations, testing strategy, build/CI hygiene. "
    "Don't use for language idioms (use the language skill), HTTP contract design details "
    "(use api-and-interface-design), or strategic clean/hexagonal/DDD layout (use architecture-patterns)."
)

FM_RE = re.compile(r"\A---\n.*?\n---\n", re.S)
FENCE_RE = re.compile(r"^\s*(```|~~~)")


def q(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def sections(body_lines):
    """Return [(title, start0, end0)] 0-based inclusive for '## ' headings outside code fences."""
    heads, in_fence = [], False
    for i, line in enumerate(body_lines):
        if FENCE_RE.match(line):
            in_fence = not in_fence
        elif not in_fence and line.startswith("## "):
            heads.append((line[3:].strip(), i))
    out = []
    last_nonblank = max(i for i, l in enumerate(body_lines) if l.strip())
    for k, (title, start) in enumerate(heads):
        nxt = heads[k + 1][1] - 1 if k + 1 < len(heads) else last_nonblank
        while nxt > start and not body_lines[nxt].strip():
            nxt -= 1
        out.append((title, start, nxt))
    return out


def build(header_lines, body_text):
    body_lines = body_text.split("\n")
    secs = sections(body_lines)
    fm_len = len(header_lines) + len(secs) + 3  # header + 'sections:' + entries + closing '---' + opening '---' handled below
    # frontmatter = '---' + header + '  sections:' + entries + '---'
    fm_len = 1 + len(header_lines) + 1 + len(secs) + 1
    entries = [
        f"    - {{title: {q(t)}, start: {s + 1 + fm_len}, end: {e + 1 + fm_len}}}" for t, s, e in secs
    ]
    fm = ["---", *header_lines, "  sections:", *entries, "---"]
    assert len(fm) == fm_len
    return "\n".join(fm) + "\n" + body_text


def process(path: Path, header_lines, golden=None):
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    text = FM_RE.sub("", text, count=1)
    lines = text.split("\n")
    lines = [l for l in lines if not l.startswith("> **Golden path:**")]
    if golden:
        h1 = next(i for i, l in enumerate(lines) if l.startswith("# "))
        j = h1 + 1
        while j < len(lines) and lines[j].strip() == "":
            j += 1
        lines[h1 + 1:j] = ["", f"> **Golden path:** {golden}", ""]
    body = "\n".join(lines).rstrip("\n") + "\n"
    path.write_text(build(header_lines, body), encoding="utf-8", newline="\n")


def main(root: Path):
    skill_header = [
        f"name: {SKILL_NAME}",
        "description: >-",
        *["  " + l for l in __import__("textwrap").wrap(SKILL_DESC, 78)],
        "metadata:",
        '  version: "1.1.0"',
        "  category: Backend Engineering",
    ]
    # SKILL.md: 'metadata:' must own 'sections' too, so strip trailing 'metadata:' handling:
    process(root / "SKILL.md", skill_header)
    for p in sorted((root / "references").glob("*.md")):
        process(p, ["metadata:", f"  file: {p.name}"], GOLDEN[p.stem])
    print("ok")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
