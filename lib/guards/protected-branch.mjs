/**
 * Write operations whose target is the branch you are standing on. `push` is absent:
 * it names its own target and is handled separately.
 */
const WRITE_OPS = new Set(["commit", "merge", "rebase", "reset", "revert", "cherry-pick"]);

/** Reading and moving around are always allowed; the guard exists to stop writes. */
const READ_OPS = new Set([
  "checkout", "pull", "fetch", "status", "log", "diff", "show", "remote",
  "rev-parse", "symbolic-ref", "stash", "switch", "restore", "ls-files", "blame",
]);

const GLOBAL_FLAGS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

function splitCommands(command) {
  return command.split(/&&|\|\||;|\n/).map((part) => part.trim()).filter(Boolean);
}

function tokenize(part) {
  return part.split(/\s+/).filter(Boolean);
}

/** `git -C /elsewhere push` still pushes; the flag moves the repo, not the risk. */
function afterGlobalFlags(tokens) {
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith("-")) {
    index += GLOBAL_FLAGS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
  }
  return tokens.slice(index);
}

/** `git push origin HEAD:v3-master` targets v3-master whatever branch you are on. */
function pushTargets(args, currentBranch) {
  const refspecs = args.filter((token) => !token.startsWith("-")).slice(1);
  if (refspecs.length === 0) return [currentBranch];
  return refspecs.map((spec) => (spec.includes(":") ? spec.split(":").pop() : spec));
}

function targetsFor(args, currentBranch) {
  const [subcommand] = args;
  if (subcommand === "push") return pushTargets(args, currentBranch);
  if (WRITE_OPS.has(subcommand)) return [currentBranch];
  return [];
}

function violationIn(part, context) {
  const tokens = tokenize(part);
  if (tokens[0] !== "git") return null;
  const args = afterGlobalFlags(tokens);
  const [subcommand] = args;
  if (!subcommand || READ_OPS.has(subcommand)) return null;

  const hit = targetsFor(args, context.currentBranch)
    .filter(Boolean)
    .find((target) => context.protectedBranches.includes(target.replace(/^refs\/heads\//, "")));
  return hit ? { subcommand, branch: hit } : null;
}

/**
 * Pure, so the decision can be tested as a table without spawning anything — the idiom
 * D35 asks of every guard.
 */
export function protectedBranchViolation({ command, protectedBranches = [], currentBranch = null }) {
  if (!command || !command.includes("git")) return null;
  for (const part of splitCommands(command)) {
    const found = violationIn(part, { protectedBranches, currentBranch });
    if (found) return found;
  }
  return null;
}

export function protectedBranchMessage(violation) {
  return `kiln blocked \`git ${violation.subcommand}\`: ${violation.branch} is a protected branch.
Work on a branch and open a pull request. To change what is protected, edit vcs.protected in .kiln/config.json.`;
}
