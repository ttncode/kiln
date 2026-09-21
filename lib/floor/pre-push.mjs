#!/usr/bin/env node
/**
 * Copied into a project as `.kiln/hooks/pre-push.mjs` and run by git, not by kiln.
 *
 * git has already resolved every ref by the time this runs: stdin carries one line per
 * ref as `<local ref> <local sha> <remote ref> <remote sha>`, after `HEAD`, `@`, `+`,
 * `push.default`, aliases, `-C` and the working directory have all been worked out. So
 * this file parses no command line — that is the entire reason it exists.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function findRoot(start) {
  let dir = resolve(start);
  for (;;) {
    try {
      return { root: dir, config: JSON.parse(readFileSync(join(dir, ".kiln", "config.json"), "utf8")) };
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

export function refusal(line, protectedBranches) {
  const remoteRef = line.split(/\s+/)[2] ?? "";
  const branch = remoteRef.replace(/^refs\/heads\//, "");
  return protectedBranches.includes(branch) ? { branch, remoteRef } : null;
}

export function message({ branch, remoteRef }) {
  return `kiln blocked this push: ${branch} is a protected branch.
git resolved the destination to ${remoteRef}, whatever the command line said.
Work on a branch and open a pull request. To change what is protected, edit vcs.protected in .kiln/config.json.`;
}

function main() {
  // No config means kiln is not driving this repository, and kiln does not police
  // repositories it is not driving (D33).
  const found = findRoot(process.cwd());
  if (!found) return 0;

  const branches = found.config?.vcs?.protected ?? [];
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
