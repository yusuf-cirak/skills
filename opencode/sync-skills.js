#!/usr/bin/env node
// Sync the skills, router plugin and commands into opencode's global config dir.
//
//   node opencode/sync-skills.js          # copy (default, cross-platform safe)
//   node opencode/sync-skills.js --link   # junction/symlink the skill folders (true single-source;
//                                          # re-edits propagate). Plugin and command files are
//                                          # always copied: file symlinks need elevation on Windows.
//
// Every skill under skills/<bucket>/<skill>/ lands flat as ~/.config/opencode/skills/<skill>/,
// keeping its folder name (csharp, csharp-ddd, ..., backend-engineering) so the relative
// cross-skill links (../csharp/references/...) keep resolving.
// Idempotent: re-running overwrites the destination.

const fs = require("fs");
const os = require("os");
const path = require("path");

const link = process.argv.includes("--link");

// repo/skills/<bucket>/<skill>  (this file lives at repo/opencode/sync-skills.js)
const repoRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(repoRoot, "skills");
const configDir = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
const destRoot = path.join(configDir, "skills");

if (!fs.existsSync(srcRoot)) {
  console.error(`Source skills dir not found: ${srcRoot}`);
  process.exit(1);
}

fs.mkdirSync(destRoot, { recursive: true });

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

function subdirs(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name));
}

// bucket dirs -> skill dirs (a skill dir is one that holds a SKILL.md)
const skills = subdirs(srcRoot)
  .flatMap(subdirs)
  .filter((d) => fs.existsSync(path.join(d, "SKILL.md")));

let count = 0;
for (const from of skills) {
  const name = path.basename(from);
  const to = path.join(destRoot, name);
  try {
    if (link) {
      fs.rmSync(to, { recursive: true, force: true });
      fs.symlinkSync(from, to, "junction"); // "junction" works on Windows without elevation for dirs
      console.log(`linked  skill   ${name} -> ${to}`);
    } else {
      copyDir(from, to);
      console.log(`copied  skill   ${name} -> ${to}`);
    }
    count++;
  } catch (err) {
    console.error(`failed  skill   ${name}: ${err.message}`);
  }
}
console.log(`\n${count}/${skills.length} skills synced to ${destRoot}`);

// plugins/ and commands/ hold single files; copy each into the matching opencode dir.
for (const kind of ["plugins", "commands"]) {
  const from = path.join(__dirname, kind);
  if (!fs.existsSync(from)) continue;
  const to = path.join(configDir, kind);
  fs.mkdirSync(to, { recursive: true });
  for (const file of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, file), path.join(to, file));
    console.log(`copied  ${kind.slice(0, -1).padEnd(7)} ${file} -> ${to}`);
  }
}

console.log("\nInvoke in opencode via the skill tool by bare name, e.g. skill({ name: \"csharp\" }).");
console.log("Router plugin loads on the next opencode start; if you also use opencode/AGENTS.md, drop one of the two to avoid a double banner.");
