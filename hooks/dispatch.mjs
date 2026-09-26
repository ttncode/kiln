#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { loadConfig, resolveRoot } from "../lib/config.mjs";
import { protectedBranchesFor } from "../lib/modules.mjs";
import { gitOutput } from "../lib/init.mjs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PathError, isInside, isSymlink, resolveEntry, resolveTarget } from "../lib/paths.mjs";
import { destructiveTargets, opensPullRequest, permissionTargets, removalTargets, segmentsOf, stagesEverything, writeTargets } from "../lib/guards/bash-targets.mjs";
import { GuardStateError, claimOwner, claimUnbound, displacedFrom, workForSession } from "../lib/guards/context.mjs";
import { gateMessage, shipVerdict, sourceEditVerdict } from "../lib/guards/gate.mjs";
import { branchesFor, cwdChain, dirOf } from "../lib/guards/git-repo.mjs";
import { sweptPaths } from "../lib/guards/git-sweeps.mjs";
import { protectedBranchMessage, protectedBranchViolation } from "../lib/guards/protected-branch.mjs";
import { interpreterMessage, interpreterReach, shellPrograms } from "../lib/guards/interpreter.mjs";
import { holdsControl, isJudged, sandboxMessage, sandboxVerdict } from "../lib/guards/sandbox.mjs";
import { disarmAttempt, disarmMessage, isVerificationFile } from "../lib/guards/verification.mjs";
import { StackError, UNDETECTED, guardsFor, loadStack } from "../lib/stack.mjs";

const BLOCK = 2;
const ALLOW = 0;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // fail-open: input that is not JSON means the harness is broken, not that a write is
    // happening; refusing every call then bricks the session and protects nothing.
    return {};
  }
}

function block(message) {
  process.stderr.write(`${message}\n`);
  return BLOCK;
}

/**
 * Every directory this call touches: where it runs, the file it edits, the directories its
 * command moves into, and the paths it writes or removes. kiln drives a project when one of
 * them sits under a `.kiln/config.json` — not only when the session happens to stand in one.
 */
/**
 * D180: each target is resolved from where its own command runs. `cd .kiln && cp tmp/x dna/y`
 * writes `.kiln/dna/y`, and resolved from the session's directory it read as a harmless
 * `dna/y` — the store's guard was walked past that way. cc-safety-net keeps an effective
 * working directory per segment for the same reason; kiln already had one (`cwdChain`, for
 * git) and now reads its writes through it too. A `cd` it cannot follow — a variable, a `||`
 * — leaves the session's directory, as before.
 */
function located(command, { cwd, extract }) {
  const dirs = cwdChain(command, cwd);
  return segmentsOf(command).flatMap((part, index) => extract(part).map((path) => ({ path, cwd: dirs[index] ?? cwd })));
}

const allTargets = (part) => [...writeTargets(part), ...removalTargets(part), ...destructiveTargets(part)];

function touchedDirs(payload, cwd) {
  const file = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  const command = payload.tool_input?.command;
  const dirs = [cwd, ...(file ? [dirname(resolve(cwd, file))] : [])];
  if (!command) return dirs;
  const moved = [...cwdChain(command, cwd), ...segmentsOf(command).map((part) => dirOf(part, cwd))];
  const paths = located(command, { cwd, extract: allTargets });
  return [...dirs, ...moved.filter(Boolean), ...paths.map((at) => dirname(resolve(at.cwd, at.path))), ...namedDirs(command)];
}

const MAX_NAMED = 20;

/**
 * Every absolute path the command text names, wherever it sits: a git-dir option, a GIT_DIR
 * assignment, `pushd /proj`, `(cd /proj && …)`, or a path inside an inline program. The
 * structured readings above know the common spellings; this is what keeps a spelling they do
 * not know from carrying a call into a kiln project unjudged. Bounded, because each one is a
 * walk up the filesystem on the hook's hot path.
 */
function namedDirs(command) {
  const found = String(command).match(/\/[^\s'"`()<>;|&=]+/g) ?? [];
  return found.slice(0, MAX_NAMED).flatMap((path) => [path, dirname(path)]);
}

/**
 * D148: no project kiln drives is anywhere in this call, so there is nothing to protect —
 * D33's proven branch. The guard used to fall back to protecting `main` and `master` on
 * every repository on the machine, so installing the plugin refused `git push origin main`
 * in projects that had never run `kiln init` — a false block wherever the user worked.
 *
 * Asking every directory the call touches, rather than only the session's cwd, is what keeps
 * this from being a way around: `git -C /proj push --no-verify` from another directory, or a
 * write to `/proj/.kiln/config.json` from outside it, lands in a kiln project and is judged
 * by that project's config.
 */
function drivenRoot(payload) {
  const cwd = payload.cwd ?? process.cwd();
  for (const dir of touchedDirs(payload, cwd)) {
    const root = resolveRoot(dir);
    if (root) return root;
  }
  return null;
}

/**
 * Config broken falls back to a hardcoded list and still blocks. It never falls back to
 * allow: a guard that opens when it cannot read its own settings makes the promise it exists
 * to keep a paper one (D33).
 */
function rootAndBranches(found) {
  try {
    const { root, config } = loadConfig(found);
    return { root, protectedBranches: protectedBranchesFor(config), stackId: config.stack.id, unreadable: null };
  } catch (error) {
    // fail-closed: recorded as unreadable, and unreadableConfig blocks every write on it.
    return { root: found, protectedBranches: FALLBACK_PROTECTED, stackId: null, unreadable: error.message };
  }
}

const FALLBACK_PROTECTED = ["main", "master"];

/**
 * A config that is there and cannot be read is not a project without one. Treating the two
 * alike ran no stack guard — `stackId` came back null — so on a php-ci3 project a corrupted
 * or half-written config let `DROP COLUMN` into a migration the same guard refuses with the
 * file intact. Writes stop until the file reads; reading, and `kiln doctor`, carry on.
 */
function unreadableConfig(payload, ctx) {
  if (!ctx.unreadable) return ALLOW;
  const command = payload.tool_input?.command;
  const writes = command === undefined || [...writeTargets(command), ...removalTargets(command), ...destructiveTargets(command)].length > 0;
  return writes ? block(`kiln blocked this write: .kiln/config.json cannot be read, so the guards it configures cannot run.
${ctx.unreadable}
Fix the file yourself — \`kiln doctor\` names the problem — and this clears.`) : ALLOW;
}

function context(payload, found) {
  const cwd = payload.cwd ?? process.cwd();
  const { root, protectedBranches, stackId, unreadable } = rootAndBranches(found);
  const state = workForSession(root, payload.session_id) ?? claimUnbound(root, payload.session_id);
  const takenOver = state ? null : displacedFrom(root, payload.session_id);
  return { cwd, root, protectedBranches, stackId, unreadable, state, takenOver };
}

/**
 * D33 has no exemption for project-contributed code: a stack guard that crashes blocks,
 * and the message names the file so the user can fix theirs rather than kiln's.
 */
async function runStackGuard(guard, payload) {
  try {
    const module = await import(guard.path);
    // A guard file with no `check` is a guard that never runs, and a promise it returns is a
    // verdict that arrives after this function has answered. Both are the project's guard
    // silently not running, which D33 refuses to call an allow.
    if (typeof module.check !== "function") throw new Error("it exports no check(payload) function");
    return (await module.check(payload)) ?? null;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    return { blocked: true, reason: `stack guard "${guard.id}" failed.\n${guard.path}\n${detail}\nRun \`kiln doctor\`.` };
  }
}

/**
 * A stack kiln cannot load is two different situations, and treating them alike made the
 * common one fatal. `unknown` is the sentinel `init` writes when detection recognised
 * nothing (D92) — there is no `stacks/unknown.json` and there is not meant to be, so
 * looking one up threw `StackError`, the throw reached main()'s catch-all, and **every
 * edit in the project** was refused with "This is a bug in kiln, not in your change. Run
 * `kiln doctor`" — while doctor, correctly, named the config line. D103's shape again: a
 * remedy that does not exist, over a state kiln itself wrote. Any project outside the two
 * shipped stacks got it on its first edit after `init`.
 *
 * A stack named and missing is the other situation, and it stays fatal: that is the
 * project's own guards silently not running, which is what D33 refuses to fail open on.
 * The message names the config line instead of blaming kiln.
 */
async function runStackGuards(payload, { phase, stackId }) {
  if (!stackId || stackId === UNDETECTED) return ALLOW;
  let stack;
  try {
    stack = loadStack(stackId);
  } catch (error) {
    if (!(error instanceof StackError)) throw error;
    return block(`kiln blocked this: ${error.message}
\`stack.id\` in .kiln/config.json names a stack that is not there, so the guards it contributes cannot run. Run \`kiln doctor\`.`);
  }
  for (const guard of guardsFor(stack, phase)) {
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
  for (const at of located(command, { cwd: ctx.cwd, extract: writeTargets })) {
    const synthetic = { ...payload, tool_input: { file_path: resolveTarget(at.path, at.cwd), content: command } };
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
    ...branchesFor(part, { root, cwd }),
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
    // An unknown directory stays unknown. Falling back to the session's cwd turned "cannot
    // tell which checkout" into "this one", which allowed a push from a submodule standing on
    // a protected branch and refused a commit in a directory nobody could name.
    repoFor: (part, index) => repoFor(part, { root: ctx.root, cwd: chain[index] }),
  });
  return violation ? block(protectedBranchMessage(violation)) : ALLOW;
}

/** D66: ownership, asked of every write, not only of the ones inside a work directory. */
function claimVerdict(target, ctx) {
  const owner = claimOwner(ctx.root, { path: relative(ctx.root, target), excludeId: ctx.state?.id });
  return owner ? `claimed by work ${owner}, which is still active` : null;
}

/**
 * A symlink is refused rather than followed — following one is the arbitrary-file-overwrite
 * primitive agent-skills #295 rates High, and D52 settled it. What was never deliberate is
 * how the refusal was *reported*: `resolveTarget` throws, the throw reached the catch-all,
 * and the agent was told "This is a bug in kiln, not in your change. Run `kiln doctor`" —
 * which is false, and doctor then says `Ready.` A remedy that does not exist is the shape
 * this project keeps meeting.
 *
 * Measured on a clone of zod, whose `README.md` is a symlink into `packages/`. Editing a
 * README is an ordinary thing to be asked for, and the agent was told the tool was broken.
 */
function pathRefusal(path, cwd) {
  const at = isAbsolute(path) ? path : join(cwd, path);
  if (!isSymlink(at)) {
    return `kiln could not resolve ${at}, so it cannot say whether that write lands inside the project. Nothing was written.`;
  }
  let points;
  try {
    points = `Write to the file it points at: ${realpathSync(at)}`;
  } catch {
    // fail-closed: only the wording of a block that is already happening depends on this.
    points = "It points at something that does not exist, so there is nothing to write to.";
  }
  return `kiln blocked a write to ${at}: it is a symlink, and kiln does not follow one — a write through a symlink lands wherever it points, which is how an edit leaves the project.
${points}`;
}

/** Every write funnels through here — an Edit, a redirect, a `tee` — so the rule is stated once. */
function checkPath(path, ctx) {
  let target;
  try {
    target = resolveTarget(path, ctx.cwd);
  } catch (error) {
    if (!(error instanceof PathError)) throw error;
    return block(pathRefusal(path, ctx.cwd));
  }
  if (isVerificationFile(target)) {
    return block(sandboxMessage(ctx.root, { target, activeId: ctx.state?.id, reason: "this file is part of what enforces the run; the run does not get to edit it" }));
  }
  const verdict = sandboxVerdict(ctx.root, { target, activeId: ctx.state?.id });
  const reason = verdict.blocked ? verdict.reason : claimVerdict(target, ctx);
  return reason ? block(sandboxMessage(ctx.root, { target, reason, activeId: ctx.state?.id })) : ALLOW;
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
/**
 * A permission change is judged narrower than a removal. `chmod -R u+w .` touches the project
 * root, which holds `.kiln/`, and refusing it as if the root were a control file was a false
 * block; `chmod 000 .kiln/work/<id>` is the one that hides a gate record, and it is inside.
 */
function isControlled(ctx, target) {
  return isJudged(ctx.root, { target, activeId: ctx.state?.id }) || isVerificationFile(target);
}

function lockedAway(ctx, target) {
  const kiln = join(ctx.root, ".kiln");
  return isControlled(ctx, target) || (isInside(kiln, target) && !isInside(join(kiln, "tmp"), target));
}

/**
 * A glob reaches whatever it matches, which the text does not say: `rm .kiln/work/<id>/*` names
 * no control file and removes one. It is judged by the directory it expands in.
 */
function removedEntry(path, cwd) {
  const glob = path.search(/[*?[]/);
  if (glob === -1) return resolveEntry(path, cwd);
  const stem = path.slice(0, glob);
  return resolveEntry(stem.endsWith("/") || stem === "" ? stem || "." : dirname(stem), cwd);
}

function guardRemovedControlFiles(command, ctx) {
  const swept = located(command, { cwd: ctx.cwd, extract: (part) => [part] }).flatMap((at) => sweptPaths(at.path, at.cwd));
  const removed = [...located(command, { cwd: ctx.cwd, extract: removalTargets }).map((at) => removedEntry(at.path, at.cwd)), ...swept];
  const locked = located(command, { cwd: ctx.cwd, extract: permissionTargets }).map((at) => resolveEntry(at.path, at.cwd));
  const hit = removed.find((target) => isControlled(ctx, target) || holdsControl(ctx.root, target)) ?? locked.find((target) => lockedAway(ctx, target));
  return hit ? block(sandboxMessage(ctx.root, { target: hit, activeId: ctx.state?.id, reason: "this file is part of what enforces the run; deleting one is not an edit you get to make" })) : ALLOW;
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
  const paths = located(command, { cwd: ctx.cwd, extract: (part) => [...destructiveTargets(part), ...writeTargets(part)] });
  return paths.map((at) => checkPath(at.path, { ...ctx, cwd: at.cwd })).find((verdict) => verdict === BLOCK) ?? ALLOW;
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
  return located(command, { cwd: ctx.cwd, extract: writeTargets })
    .map((at) => guardGateFile({ tool_input: { file_path: at.path } }, { ...ctx, cwd: at.cwd }))
    .find((verdict) => verdict === BLOCK) ?? ALLOW;
}

const CHAINS = {
  "pre-bash": [unreadableConfig, guardInterpreter, guardVerification, guardProtectedBranch, guardSandboxBash, guardGateBash],
  "pre-edit": [unreadableConfig, guardSandboxFile, guardGateFile],
  "post-edit": [],
};

/**
 * A state kiln cannot read may be a gate record someone damaged, so it blocks (D33). The
 * conversion lives here rather than only in main(), so the decision is the dispatcher's and
 * the same whichever entry point called it.
 */
function contextOrBlock(payload, found) {
  try {
    return context(payload, found);
  } catch (error) {
    if (!(error instanceof GuardStateError)) throw error;
    return block(`${error.message}\nDelete that directory or restore the file; \`kiln list\` shows which work it is.`);
  }
}

const NESTING_LIMIT = 3;

/**
 * A shell program inside the command — `bash -c "…"`, a heredoc fed to `sh` — is judged by
 * the same chain as the command around it. Bounded, because a guard that recursed without
 * limit on crafted input would run past the hook's timeout, and a timed-out hook allows.
 */
function guardNestedPrograms(payload, ctx) {
  const depth = ctx.depth ?? 0;
  if (depth >= NESTING_LIMIT) return ALLOW;
  for (const program of shellPrograms(payload.tool_input.command)) {
    const nested = { ...payload, tool_input: { command: program } };
    if (CHAINS["pre-bash"].some((guard) => guard(nested, ctx) === BLOCK)) return BLOCK;
    if (guardNestedPrograms(nested, { ...ctx, depth: depth + 1 }) === BLOCK) return BLOCK;
  }
  return ALLOW;
}

/** Nothing to judge: an unknown phase, or a shell call with no command. */
function nothingToJudge(phase, payload) {
  if (!CHAINS[phase]) return true;
  return phase !== "pre-edit" && phase !== "post-edit" && !payload.tool_input?.command;
}

/** Core guards first, fixed order, hardcoded. Stack guards only after all of them. */
export async function dispatch(phase, payload) {
  if (nothingToJudge(phase, payload)) return ALLOW;
  const found = drivenRoot(payload);
  if (!found) return ALLOW;

  const ctx = contextOrBlock(payload, found);
  if (ctx === BLOCK) return BLOCK;
  for (const guard of CHAINS[phase]) {
    if (guard(payload, ctx) === BLOCK) return BLOCK;
  }
  if (phase === "pre-bash" && guardNestedPrograms(payload, ctx) === BLOCK) return BLOCK;
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
