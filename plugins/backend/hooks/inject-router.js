#!/usr/bin/env node
// backend SessionStart hook.
// Injects the backend engineering entry point into every session so `backend:backend-engineering`
// is invoked for backend service work WITHOUT a manual block in the user's global CLAUDE.md.
// Claude Code reads the nested hookSpecificOutput.additionalContext shape; a top-level
// additionalContext is ignored.

const banner = [
  "# Backend engineering house rules (backend)",
  "",
  "For any backend service design or review work in any language (module boundaries / modular monolith, DDD aggregates, CQRS pipelines, error modeling, outbox/inbox, idempotency, locks, multi-tenancy, rate limiting, caching, resilience, security hardening, observability, migrations, testing strategy, CI), invoke `backend:backend-engineering` with the Skill tool before the first edit.",
  "",
  "`backend:backend-engineering` holds the cross-cutting rules and the signal table for its `references/`. Open every reference whose signal appears in the work, not just the closest one.",
].join("\n");

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: banner,
    },
  }),
);
