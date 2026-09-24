#!/usr/bin/env node
// What tps-project-dna has changed since kiln took its method (D167) — the release-checklist step
// the DNA copy costs, as D69 made it for the superpowers fork: read upstream from the fork
// point forward, and adopt what is worth adopting as a decision entry, never as a merge.
//
// Reads a local checkout of the source repository; reaches no network.
//
// Usage: node scripts/dna-upstream.mjs <claude_skill checkout>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { METHODOLOGY_COMMIT, METHODOLOGY_VERSION } from "../lib/dna/contract.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SKILL = "plugins/tps-project-dna/skills/tps-project-dna";
const PAGES = ["glossary", "id-schemes", "quality-gates", "agent-orchestration", "bootstrap-playbook", "update-playbook", "dna-store", "dna-erd", "bpm-alignment"];
const ASSETS = ["explorer.html", "laneflow.js"];

// Which kiln code carries each ported script; a change upstream is a question for these files.
const PORTED = {
  "scripts/build_dna_store.py": "lib/dna/contract.mjs, derive.mjs, gates.mjs, apply.mjs (D153)",
  "scripts/check_gates.py": "lib/dna/gates.mjs (D153)",
  "scripts/bootstrap_infra_map.py": "lib/dna/infra.mjs (D156)",
  "scripts/context_footprint.py": "lib/dna/footprint.mjs (D165)",
  "scripts/reconcile_5a.py": "lib/dna/reconcile.mjs (D166)",
  "scripts/apply_taxonomy_split.py": "lib/dna/remap.mjs (D164)",
  "scripts/apply_stage_layout.py": "lib/dna/remap.mjs (D164)",
  "scripts/check_explorer_compat.py": "tests/helpers/explorer-harness.mjs (D160)",
};

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** kiln's copy without the three-line note it added under the title. */
function vendoredBody(page) {
  const lines = readFileSync(join(ROOT, "skills", "kiln-dna", `${page}.md`), "utf8").split("\n");
  return [lines[0], ...lines.slice(5)].join("\n");
}

function changedSinceFork(repo) {
  const names = git(repo, ["diff", "--name-only", `${METHODOLOGY_COMMIT}..HEAD`, "--", SKILL]);
  return names ? names.split("\n").map((path) => path.slice(SKILL.length + 1)) : [];
}

function report(repo) {
  const changed = changedSinceFork(repo);
  const head = git(repo, ["log", "-1", "--format=%h %cs %s", "HEAD"]);
  const commits = Number(git(repo, ["rev-list", "--count", `${METHODOLOGY_COMMIT}..HEAD`, "--", SKILL]));
  const lines = [`kiln took tps-project-dna ${METHODOLOGY_VERSION} at ${METHODOLOGY_COMMIT.slice(0, 12)}; the checkout is at ${head}.`, `${commits} commit(s) since then touch the skill.`];
  const pages = PAGES.filter((page) => vendoredBody(page) !== readFileSync(join(repo, SKILL, "references", `${page}.md`), "utf8"));
  const assets = ASSETS.filter((name) => sha256(join(ROOT, "vendor", "dna-explorer", name)) !== sha256(join(repo, SKILL, "assets", name)));
  const scripts = Object.keys(PORTED).filter((path) => changed.includes(path));
  lines.push(...pages.map((page) => `  page differs:  skills/kiln-dna/${page}.md — re-copy it verbatim, keeping kiln's note`));
  lines.push(...assets.map((name) => `  asset differs: vendor/dna-explorer/${name} — re-copy, update the hash in NOTICE, rerun the explorer test`));
  lines.push(...scripts.map((path) => `  script changed: ${path} — read the diff against ${PORTED[path]}`));
  const carried = new Set([...PAGES.map((page) => `references/${page}.md`), ...ASSETS.map((name) => `assets/${name}`), ...Object.keys(PORTED)]);
  const others = changed.filter((path) => !carried.has(path));
  if (others.length > 0) lines.push(`  also changed, not carried by kiln: ${others.join(", ")}`);
  const drift = pages.length + assets.length + scripts.length;
  lines.push(drift === 0 ? "Nothing kiln carries has changed." : "Adopt what is worth adopting as a decision entry, never as a merge (D69, D167).");
  return { lines, drift };
}

const repo = process.argv[2];
if (!repo || !existsSync(join(repo, SKILL))) {
  console.error("usage: node scripts/dna-upstream.mjs <claude_skill checkout>");
  process.exit(2);
}
const { lines, drift } = report(repo);
for (const line of lines) process.stdout.write(`${line}\n`);
process.exit(drift === 0 ? 0 : 1);
