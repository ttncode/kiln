#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { loadConfig } from "../lib/config.mjs";
import { gitOutput } from "../lib/init.mjs";
import { protectedBranchMessage, protectedBranchViolation } from "../lib/guards/protected-branch.mjs";

const BLOCK = 2;
const ALLOW = 0;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function block(message) {
  process.stderr.write(`${message}\n`);
  return BLOCK;
}

/**
 * Config missing or broken falls back to a hardcoded list and still blocks. It never
 * falls back to allow: a guard that opens when it cannot read its own settings makes
 * the promise it exists to keep a paper one (D33).
 */
function vcsSettings(cwd) {
  try {
    const { config } = loadConfig(cwd);
    return { protectedBranches: config.vcs.protected, root: cwd };
  } catch {
    return { protectedBranches: ["main", "master"], root: cwd };
  }
}

function guardProtectedBranch(payload) {
  const command = payload.tool_input?.command;
  if (!command || !command.includes("git")) return ALLOW;

  const cwd = payload.cwd ?? process.cwd();
  const { protectedBranches } = vcsSettings(cwd);
  const currentBranch = gitOutput(cwd, ["symbolic-ref", "--short", "HEAD"]);
  const violation = protectedBranchViolation({ command, protectedBranches, currentBranch });
  return violation ? block(protectedBranchMessage(violation)) : ALLOW;
}

const CHAINS = {
  "pre-bash": [guardProtectedBranch],
  "pre-edit": [],
  "post-edit": [],
};

export function dispatch(phase, payload) {
  for (const guard of CHAINS[phase] ?? []) {
    const verdict = guard(payload);
    if (verdict === BLOCK) return BLOCK;
  }
  return ALLOW;
}

/**
 * One try/catch, and its only exit is 2. A non-2 exit is a NON-BLOCKING error in this
 * harness — the tool runs — so an uncaught throw here would fail open. What this cannot
 * reach is named rather than hidden: node absent from PATH, a syntax error in this file,
 * OOM, or a hook timeout all fail open, because the process never arrives at a branch.
 */
function main() {
  try {
    return dispatch(process.argv[2], readStdin());
  } catch (error) {
    return block(`kiln guard failed: ${error instanceof Error ? error.message : String(error)}
This is a bug in kiln, not in your change. Run \`kiln doctor\`.`);
  }
}

if (process.argv[1]?.endsWith("dispatch.mjs")) process.exit(main());
