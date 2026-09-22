#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { loadConfig } from "../lib/config.mjs";
import { protectedBranchesFor } from "../lib/modules.mjs";
import { gitOutput } from "../lib/init.mjs";
import { relative } from "node:path";
import { resolveTarget } from "../lib/paths.mjs";
import { destructiveTargets, opensPullRequest, removalTargets, stagesEverything, writeTargets } from "../lib/guards/bash-targets.mjs";
import { GuardStateError, claimOwner, claimUnbound, displacedFrom, workForSession } from "../lib/guards/context.mjs";
import { gateMessage, shipVerdict, sourceEditVerdict } from "../lib/guards/gate.mjs";
import { branchesFor, cwdChain, dirOf } from "../lib/guards/git-repo.mjs";
import { protectedBranchMessage, protectedBranchViolation } from "../lib/guards/protected-branch.mjs";
import { interpreterMessage, interpreterReach } from "../lib/guards/interpreter.mjs";
import { isControlFile, sandboxMessage, sandboxVerdict } from "../lib/guards/sandbox.mjs";
import { disarmAttempt, disarmMessage, isVerificationFile } from "../lib/guards/verification.mjs";
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
    return { root, protectedBranches: protectedBranchesFor(config), stackId: config.stack.id };
  } catch {
    return { root: cwd, protectedBranches: ["main", "master"], stackId: null };
  }
}

function context(payload) {
  const cwd = payload.cwd ?? process.cwd();
  const { root, protectedBranches, stackId } = rootAndBranches(cwd);
  const state = workForSession(root, payload.session_id) ?? claimUnbound(root, payload.session_id);
  const takenOver = state ? null : displacedFrom(root, payload.session_id);
  return { cwd, root, protectedBranches, stackId, state, takenOver };
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

/**
 * `resolveRef` is asked for at most one ref per refspec, and only for a push that names
 * one — so an ordinary command adds no subprocess. That budget matters: the hook has a
 * 5-second timeout and a hook that exceeds it ALLOWS, so every git call on this path is
 * bought with the promise it keeps.
 */
function repoFor(part, { root, cwd }) {
  return {
    branches: branchesFor(part, { root, cwd }),
    resolveRef: (spec) => (cwd === null ? null : gitOutput(dirOf(part, cwd), ["rev-parse", "--abbrev-ref", spec])),
  };
}

function guardProtectedBranch(payload, ctx) {
  const command = payload.tool_input?.command;
  if (!command.includes("git")) return ALLOW;
  const chain = cwdChain(command, ctx.cwd);
  const violation = protectedBranchViolation({
    command,
    protectedBranches: ctx.protectedBranches,
    repoFor: (part, index) => repoFor(part, { root: ctx.root, cwd: chain[index] ?? ctx.cwd }),
  });
  return violation ? block(protectedBranchMessage(violation)) : ALLOW;
}

/** D66: ownership, asked of every write, not only of the ones inside a work directory. */
function claimVerdict(target, ctx) {
  const owner = claimOwner(ctx.root, { path: relative(ctx.root, target), excludeId: ctx.state?.id });
  return owner ? `claimed by work ${owner}, which is still active` : null;
}

/** Every write funnels through here — an Edit, a redirect, a `tee` — so the rule is stated once. */
function checkPath(path, ctx) {
  const target = resolveTarget(path, ctx.cwd);
  if (isVerificationFile(target)) {
    return block(sandboxMessage(ctx.root, { target, reason: "this file is part of what enforces the run; the run does not get to edit it" }));
  }
  const verdict = sandboxVerdict(ctx.root, { target, activeId: ctx.state?.id });
  const reason = verdict.blocked ? verdict.reason : claimVerdict(target, ctx);
  return reason ? block(sandboxMessage(ctx.root, { target, reason })) : ALLOW;
}

function guardSandboxFile(payload, ctx) {
  const path = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  return path ? checkPath(path, ctx) : ALLOW;
}

/**
 * Removal verbs are checked against control files only. Widening them to the whole
 * sandbox would re-open the shell parsing D34 refuses; a control file is one resolved
 * path compared by segment, which is what the sandbox already does.
 */
function guardRemovedControlFiles(command, ctx) {
  const hit = removalTargets(command)
    .map((path) => resolveTarget(path, ctx.cwd))
    .find((target) => isControlFile(ctx.root, target) || isVerificationFile(target));
  return hit ? block(sandboxMessage(ctx.root, { target: hit, reason: "this file is part of what enforces the run; deleting one is not an edit you get to make" })) : ALLOW;
}

/**
 * An inline program is a door the write-target scan cannot see through, and #95 widened it:
 * a `>` inside quotes is now data, so `sh -c "echo x > path"` no longer trips the redirect
 * scan by accident. The door is named here rather than left to luck.
 */
function guardInterpreter(payload) {
  const reach = interpreterReach(payload.tool_input?.command);
  return reach ? block(interpreterMessage(reach)) : ALLOW;
}

function guardVerification(payload) {
  const attempt = disarmAttempt(payload.tool_input?.command);
  return attempt ? block(disarmMessage(attempt)) : ALLOW;
}

function guardSandboxBash(payload, ctx) {
  const command = payload.tool_input?.command;
  if (guardRemovedControlFiles(command, ctx) === BLOCK) return BLOCK;
  const paths = [...destructiveTargets(command), ...writeTargets(command)];
  return paths.map((path) => checkPath(path, ctx)).find((verdict) => verdict === BLOCK) ?? ALLOW;
}

function guardGateFile(payload, ctx) {
  const path = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  if (!path) return ALLOW;
  if (ctx.takenOver) {
    return block(gateMessage("a source edit", `work ${ctx.takenOver.id} was taken over by another session`));
  }
  const verdict = sourceEditVerdict(ctx.root, { state: ctx.state, target: resolveTarget(path, ctx.cwd) });
  return verdict.blocked ? block(gateMessage("a source edit", verdict.reason)) : ALLOW;
}

function guardGateBash(payload, ctx) {
  const command = payload.tool_input?.command;
  if (ctx.state && stagesEverything(command)) {
    return block(gateMessage("a broad `git add`", "this run stages its own files by name, never the whole tree"));
  }
  if (opensPullRequest(command)) {
    const verdict = shipVerdict(ctx.root, ctx.state);
    if (verdict.blocked) return block(gateMessage("opening a pull request", verdict.reason));
  }
  return writeTargets(command)
    .map((path) => guardGateFile({ tool_input: { file_path: path } }, ctx))
    .find((verdict) => verdict === BLOCK) ?? ALLOW;
}

const CHAINS = {
  "pre-bash": [guardInterpreter, guardVerification, guardProtectedBranch, guardSandboxBash, guardGateBash],
  "pre-edit": [guardSandboxFile, guardGateFile],
  "post-edit": [],
};

/**
 * A state kiln cannot read may be a gate record someone damaged, so it blocks (D33). The
 * conversion lives here rather than only in main(), so the decision is the dispatcher's and
 * the same whichever entry point called it.
 */
function contextOrBlock(payload) {
  try {
    return context(payload);
  } catch (error) {
    if (!(error instanceof GuardStateError)) throw error;
    return block(`${error.message}\nDelete that directory or restore the file; \`kiln list\` shows which work it is.`);
  }
}

/** Core guards first, fixed order, hardcoded. Stack guards only after all of them. */
export async function dispatch(phase, payload) {
  if (!CHAINS[phase]) return ALLOW;
  if (phase !== "pre-edit" && phase !== "post-edit" && !payload.tool_input?.command) return ALLOW;

  const ctx = contextOrBlock(payload);
  if (ctx === BLOCK) return BLOCK;
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
