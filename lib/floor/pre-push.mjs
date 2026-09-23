#!/usr/bin/env node
/**
 * Copied into a project as `.kiln/hooks/pre-push.mjs` and run by git, not by kiln.
 *
 * git has already resolved every ref by the time this runs: stdin carries one line per
 * ref as `<local ref> <local sha> <remote ref> <remote sha>`, after `HEAD`, `@`, `+`,
 * `push.default`, aliases, `-C` and the working directory have all been worked out. So
 * this file parses no command line — that is the entire reason it exists.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function findRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".kiln", "config.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Found and unreadable is not the same as absent. The first version parsed inside the walk,
 * so a config with a byte-order mark or a syntax error was skipped as if it were not there,
 * the walk found nothing, and the push went through — the floor failing open on exactly the
 * file it exists to obey.
 */
function readConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, ".kiln", "config.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/**
 * The same set the PreToolUse guard enforces: what the user declared, plus every branch the
 * project ships from. The floor read `vcs.protected` alone, so on a project shipping from
 * `v3-master` the layer that cannot be talked out of anything protected less than the one
 * that can.
 */
export function protectedBranches(config) {
  const declared = config?.vcs?.protected ?? ["main"];
  const ships = config?.vcs?.integration_branch;
  const shipsFrom = typeof ships === "string" ? [ships] : Object.values(ships ?? {});
  return [...new Set([...declared, ...shipsFrom])];
}

export function refusal(line, branches) {
  const remoteRef = line.split(/\s+/)[2] ?? "";
  const branch = remoteRef.replace(/^refs\/heads\//, "");
  return branches.includes(branch) ? { branch, remoteRef } : null;
}

export function message({ branch, remoteRef }) {
  return `kiln blocked this push: ${branch} is a protected branch.
git resolved the destination to ${remoteRef}, whatever the command line said.
Work on a branch and open a pull request. To change what is protected, edit vcs.protected in .kiln/config.json.`;
}

function main() {
  // No config means kiln is not driving this repository, and kiln does not police
  // repositories it is not driving (D33).
  const root = findRoot(process.cwd());
  if (!root) return 0;
  const config = readConfig(root);
  if (!config) {
    process.stderr.write(`kiln blocked this push: ${join(root, ".kiln", "config.json")} cannot be read, so kiln cannot tell which branches are protected.
Fix the file (\`kiln doctor\` names the problem) and push again.
`);
    return 1;
  }
  const branches = protectedBranches(config);
  for (const line of readFileSync(0, "utf8").split("\n").filter(Boolean)) {
    const hit = refusal(line, branches);
    if (hit) {
      process.stderr.write(`${message(hit)}\n`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1]?.endsWith("pre-push.mjs")) process.exit(main());
