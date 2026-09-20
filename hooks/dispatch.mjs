#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { loadConfig } from "../lib/config.mjs";
import { gitOutput } from "../lib/init.mjs";
import { relative } from "node:path";
import { resolveTarget } from "../lib/paths.mjs";
import { destructiveTargets, opensPullRequest, writeTargets } from "../lib/guards/bash-targets.mjs";
import { claimOwner, workForSession } from "../lib/guards/context.mjs";
import { gateMessage, shipVerdict, sourceEditVerdict } from "../lib/guards/gate.mjs";
import { protectedBranchMessage, protectedBranchViolation } from "../lib/guards/protected-branch.mjs";
import { sandboxMessage, sandboxVerdict } from "../lib/guards/sandbox.mjs";
import { guardsFor, loadStack } from "../lib/stack.mjs";

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
function rootAndBranches(cwd) {
  try {
    const { root, config } = loadConfig(cwd);
    return { root, protectedBranches: config.vcs.protected, stackId: config.stack.id };
  } catch {
    return { root: cwd, protectedBranches: ["main", "master"], stackId: null };
  }
}

function context(payload) {
  const cwd = payload.cwd ?? process.cwd();
  const { root, protectedBranches, stackId } = rootAndBranches(cwd);
  return { cwd, root, protectedBranches, stackId, state: workForSession(root, payload.session_id) };
}

/**
 * D33 has no exemption for project-contributed code: a stack guard that crashes blocks,
 * and the message names the file so the user can fix theirs rather than kiln's.
 */
async function runStackGuard(guard, payload) {
  try {
    const module = await import(guard.path);
    return module.check?.(payload) ?? null;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    return { blocked: true, reason: `stack guard "${guard.id}" failed.\n${guard.path}\n${detail}\nRun \`kiln doctor\`.` };
  }
}

async function runStackGuards(payload, { phase, stackId }) {
  if (!stackId) return ALLOW;
  for (const guard of guardsFor(loadStack(stackId), phase)) {
    const verdict = await runStackGuard(guard, payload);
    if (verdict?.blocked) return block(verdict.reason);
  }
  return ALLOW;
}

/**
 * A stack's pre-edit guards have to see a shell write too, or `DROP COLUMN` lands by
 * redirect while the same line is blocked through Write — D64's door, left open for
 * project-contributed guards. The command text stands in for the content, because that
 * is where a redirect's payload actually is. What it cannot see is content that never
 * appears in the command (`cat template > file`), which is the same residue as the
 * interpreter ceiling and is named rather than claimed closed.
 */
async function stackGuardsOnBashWrites(payload, ctx) {
  const command = payload.tool_input?.command;
  for (const path of writeTargets(command)) {
    const synthetic = { ...payload, tool_input: { file_path: resolveTarget(path, ctx.cwd), content: command } };
    const verdict = await runStackGuards(synthetic, { phase: "pre-edit", stackId: ctx.stackId });
    if (verdict === BLOCK) return BLOCK;
  }
  return ALLOW;
}

function guardProtectedBranch(payload, ctx) {
  const command = payload.tool_input?.command;
  if (!command.includes("git")) return ALLOW;
  const currentBranch = gitOutput(ctx.cwd, ["symbolic-ref", "--short", "HEAD"]);
  const violation = protectedBranchViolation({ command, protectedBranches: ctx.protectedBranches, currentBranch });
  return violation ? block(protectedBranchMessage(violation)) : ALLOW;
}

/** D66: ownership, asked of every write, not only of the ones inside a work directory. */
function claimVerdict(target, ctx) {
  const owner = claimOwner(ctx.root, { path: relative(ctx.root, target), excludeId: ctx.state?.id });
  return owner ? `claimed by work ${owner}, which is still active` : null;
}

function checkPath(path, ctx) {
  const target = resolveTarget(path, ctx.cwd);
  const verdict = sandboxVerdict(ctx.root, { target, activeId: ctx.state?.id });
  const reason = verdict.blocked ? verdict.reason : claimVerdict(target, ctx);
  return reason ? block(sandboxMessage(ctx.root, { target, reason })) : ALLOW;
}

function guardSandboxFile(payload, ctx) {
  const path = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  return path ? checkPath(path, ctx) : ALLOW;
}

function guardSandboxBash(payload, ctx) {
  const command = payload.tool_input?.command;
  const paths = [...destructiveTargets(command), ...writeTargets(command)];
  return paths.map((path) => checkPath(path, ctx)).find((verdict) => verdict === BLOCK) ?? ALLOW;
}

function guardGateFile(payload, ctx) {
  const path = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  if (!path) return ALLOW;
  const verdict = sourceEditVerdict(ctx.root, { state: ctx.state, target: resolveTarget(path, ctx.cwd) });
  return verdict.blocked ? block(gateMessage("a source edit", verdict.reason)) : ALLOW;
}

function guardGateBash(payload, ctx) {
  const command = payload.tool_input?.command;
  if (opensPullRequest(command)) {
    const verdict = shipVerdict(ctx.root, ctx.state);
    if (verdict.blocked) return block(gateMessage("opening a pull request", verdict.reason));
  }
  return writeTargets(command)
    .map((path) => guardGateFile({ tool_input: { file_path: path } }, ctx))
    .find((verdict) => verdict === BLOCK) ?? ALLOW;
}

const CHAINS = {
  "pre-bash": [guardProtectedBranch, guardSandboxBash, guardGateBash],
  "pre-edit": [guardSandboxFile, guardGateFile],
  "post-edit": [],
};

/** Core guards first, fixed order, hardcoded. Stack guards only after all of them. */
export async function dispatch(phase, payload) {
  if (!CHAINS[phase]) return ALLOW;
  if (phase !== "pre-edit" && phase !== "post-edit" && !payload.tool_input?.command) return ALLOW;

  const ctx = context(payload);
  for (const guard of CHAINS[phase]) {
    if (guard(payload, ctx) === BLOCK) return BLOCK;
  }
  if (phase === "pre-bash") return stackGuardsOnBashWrites(payload, ctx);
  return runStackGuards(payload, { phase, stackId: ctx.stackId });
}

/**
 * One try/catch, and its only exit is 2. A non-2 exit is a NON-BLOCKING error in this
 * harness — the tool runs — so an uncaught throw here would fail open. What this cannot
 * reach is named rather than hidden: node absent from PATH, a syntax error in this file,
 * OOM, or a hook timeout all fail open, because the process never arrives at a branch.
 */
async function main() {
  try {
    return await dispatch(process.argv[2], readStdin());
  } catch (error) {
    return block(`kiln guard failed: ${error instanceof Error ? error.message : String(error)}
This is a bug in kiln, not in your change. Run \`kiln doctor\`.`);
  }
}

if (process.argv[1]?.endsWith("dispatch.mjs")) process.exit(await main());
