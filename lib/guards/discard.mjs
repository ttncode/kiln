import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isInside } from "../paths.mjs";
import { argumentsOf, gitCleanTargets, redirectTargets, segmentsOf } from "./bash-targets.mjs";
import { cwdChain } from "./git-repo.mjs";
import { gitInvocation, gitWorkdirs } from "./git-words.mjs";

/**
 * D205: git verbs that throw uncommitted work away. kiln keeps a work's change uncommitted
 * until SHIP (D142), so until then it lives only in the working tree — and on a feature
 * branch nothing refused `git checkout .`, `git reset --hard` or `git restore <path>`.
 * destructive_command_guard (5ed0250) and cc-safety-net (bbade36) refuse these verbs
 * everywhere; kiln takes the union of their lists and refuses them while a work is open.
 */

const GIT_TIMEOUT_MS = 3000;

function longPrefix(token, name) {
  return token.length >= 4 && name.startsWith(token);
}

function shortLetters(token) {
  return /^-[^-]/.test(token) ? token.slice(1) : "";
}

function hasOption(tokens, { short = "", long = [] }) {
  return tokens.some((token) => [...short].some((letter) => shortLetters(token).includes(letter)) || long.some((name) => longPrefix(token.split("=")[0], name)));
}

function isRef(dir, name) {
  const run = spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `${name}^{commit}`], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  return run.status === 0;
}

/** Operands and options, with the values of `valued` options taken out of both. */
function splitArgs(args, valued) {
  const end = args.indexOf("--");
  const head = end === -1 ? args : args.slice(0, end);
  const options = [];
  const operands = [];
  for (let at = 0; at < head.length; at += 1) {
    if (!head[at].startsWith("-") || head[at] === "-") operands.push(head[at]);
    else options.push(head[at]);
    if (valued.has(head[at])) at += 1;
  }
  return { options, operands, paths: end === -1 ? [] : args.slice(end + 1) };
}

const CHECKOUT_VALUED = new Set(["-b", "-B", "--orphan", "--conflict"]);

function checkoutDiscards(args, { dir }) {
  const { options, operands, paths } = splitArgs(args, CHECKOUT_VALUED);
  if (paths.length > 0 || operands.includes(".") || operands.length >= 2) return true;
  if (hasOption(options, { short: "fp", long: ["--force", "--patch", "--pathspec-from-file"] })) return true;
  const [operand] = operands;
  return Boolean(operand) && existsSync(resolve(dir, operand)) && !isRef(dir, operand);
}

function restoreDiscards(args) {
  const { options } = splitArgs(args, new Set(["-s", "--source"]));
  const staged = hasOption(options, { short: "S", long: ["--staged"] });
  return !staged || hasOption(options, { short: "W", long: ["--worktree"] });
}

function mvDiscards(args, { dir }) {
  const { options, operands } = splitArgs(args, new Set());
  if (!hasOption(options, { short: "f", long: ["--force"] }) || operands.length < 2) return false;
  const target = resolve(dir, operands.at(-1));
  return existsSync(target) && !statSync(target).isDirectory();
}

function worktreeDiscards(args, { dir, root }) {
  const { options, operands } = splitArgs(args.slice(1), new Set());
  if (args[0] !== "remove" || !hasOption(options, { short: "f", long: ["--force"] })) return false;
  return operands.some((path) => isInside(root, resolve(dir, path)));
}

function shownOver(args, { dir, part }) {
  const shown = args.filter((token) => /^[^-][^:]*:.+/.test(token)).map((token) => token.slice(token.indexOf(":") + 1));
  const written = redirectTargets(part).map((path) => resolve(dir, path));
  return shown.some((path) => written.some((target) => target === resolve(dir, path) || target.endsWith(`${sep}${path}`)));
}

const ABORTABLE = new Set(["merge", "rebase", "cherry-pick", "revert", "am"]);

const VERBS = {
  reset: (args) => hasOption(args, { long: ["--hard", "--merge"] }),
  checkout: checkoutDiscards,
  switch: (args) => hasOption(args, { short: "f", long: ["--force", "--discard-changes"] }),
  restore: restoreDiscards,
  stash: (args) => args[0] === "drop" || args[0] === "clear",
  mv: mvDiscards,
  "read-tree": (args) => args.includes("-u") && hasOption(args, { short: "m", long: ["--reset"] }),
  worktree: worktreeDiscards,
  submodule: (args) => (args[0] === "deinit" || args[0] === "update") && hasOption(args.slice(1), { short: "f", long: ["--force"] }),
  show: shownOver,
};

function verbDiscards(invocation, where) {
  const [verb, ...args] = invocation.args;
  if (ABORTABLE.has(verb)) return args.some((token) => longPrefix(token, "--abort"));
  if (verb === "clean") return (gitCleanTargets(where.part) ?? []).some((path) => isInside(where.root, resolve(where.cwd, path)));
  return VERBS[verb]?.(args, where) ?? false;
}

function segmentDiscard(part, { cwd, root }) {
  const invocation = gitInvocation(argumentsOf(part));
  if (!invocation) return null;
  const dir = gitWorkdirs(invocation.words).reduce((base, next) => (isAbsolute(next) ? next : join(base, next)), cwd);
  if (!isInside(root, dir)) return null;
  return verbDiscards(invocation, { part, dir, cwd, root }) ? `git ${invocation.args.slice(0, 2).join(" ")}` : null;
}

/** The first segment of `command` that discards uncommitted work under `root`, as `git <verb> …`. */
export function discardIn(command, { cwd, root }) {
  const dirs = cwdChain(command, cwd);
  return segmentsOf(command).map((part, index) => segmentDiscard(part, { cwd: dirs[index] ?? cwd, root })).find(Boolean) ?? null;
}
