#!/usr/bin/env node
// Self-test for hooks/inject-router.js: builds temp project dirs per stack, runs the hook with a
// SessionStart stdin payload, and asserts which banners come out.
//   node scripts/test-hook.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hook = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "inject-router.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "yc-hook-"));

const CSHARP = "# C# / .NET house style (yusufcirak-skills)";
const BACKEND = "# Backend engineering house rules (yusufcirak-skills)";

function run(cwd, stdin = JSON.stringify({ hook_event_name: "SessionStart", cwd })) {
  const started = performance.now();
  const r = spawnSync(process.execPath, [hook], { input: stdin, encoding: "utf8" });
  const ms = performance.now() - started;
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.ok(ms < 1000, `hook took ${ms.toFixed(0)}ms`);
  return r.stdout;
}

function banners(out) {
  if (!out.trim()) return [];
  const json = JSON.parse(out);
  assert.equal(json.hookSpecificOutput.hookEventName, "SessionStart");
  const ctx = json.hookSpecificOutput.additionalContext;
  return [CSHARP, BACKEND].filter((b) => ctx.includes(b));
}

function project(name, files, sub = "") {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, sub), { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), "");
  return path.join(dir, sub);
}

const cases = [
  ["csharp sln in cwd", project("cs", ["App.sln"]), [CSHARP, BACKEND]],
  ["csharp csproj in child dir", project("cs-child", ["src/Api.csproj"].map((f) => (fs.mkdirSync(path.join(root, "cs-child", "src"), { recursive: true }), f))), [CSHARP, BACKEND]],
  ["csharp marker 2 parents up", project("cs-parent", ["Directory.Build.props"], "src/Module"), [CSHARP, BACKEND]],
  ["go", project("go", ["go.mod"]), [BACKEND]],
  ["rust", project("rust", ["Cargo.toml"]), [BACKEND]],
  ["typescript", project("ts", ["package.json"]), [BACKEND]],
  ["python", project("py", ["pyproject.toml"]), [BACKEND]],
  ["java gradle kts", project("java", ["build.gradle.kts"]), [BACKEND]],
  ["marker only under node_modules is ignored", project("nm", ["node_modules/package.json"].map((f) => (fs.mkdirSync(path.join(root, "nm", "node_modules"), { recursive: true }), f))), []],
  ["empty", project("empty", [], "a/b/c"), []],
];

let failed = 0;
for (const [name, cwd, expected] of cases) {
  try {
    assert.deepEqual(banners(run(cwd)), expected);
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

// malformed stdin must not throw; it falls back to process.cwd() (the repo, which has package-free dirs)
try {
  const out = run(root, "not json");
  if (out.trim()) JSON.parse(out);
  console.log("ok   malformed stdin");
} catch (e) {
  failed++;
  console.log(`FAIL malformed stdin: ${e.message}`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
