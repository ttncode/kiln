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

/**
 * `git push origin HEAD` was ALLOWED while standing on a protected branch, and so were
 * `@`, `-u origin HEAD`, `--force origin HEAD` and `+main`. The scan compared refspecs as
 * text, and `HEAD` is text that means "the branch I am on" — the very value this function
 * already holds. `git push origin` was allowed for a third reason: the remote was read as
 * a refspec, so the list was never empty and the current branch was never consulted.
 *
 * A refspec with a colon names its destination outright, and that destination is a ref on
 * the remote — comparing it as text is right, and resolving it locally would be wrong.
 * Without a colon the name is local, so `resolveRef` hands it to git. Injected rather than
 * called, because D35 wants this decision testable as a table without spawning anything.
 */
function pushTargets(args, { branches, resolveRef }) {
  const positional = args.filter((token) => !token.startsWith("-")).slice(1);
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) return branches;

  return refspecs.map((spec) => {
    const bare = spec.replace(/^\+/, "");
    if (bare.includes(":")) return bare.split(":").pop();
    return resolveRef(bare) ?? bare;
  });
}

function targetsFor(args, repo) {
  const [subcommand] = args;
  if (subcommand === "push") return pushTargets(args, repo);
  if (WRITE_OPS.has(subcommand)) return repo.branches;
  return [];
}

function violationIn(part, context) {
  const tokens = tokenize(part);
  if (tokens[0] !== "git") return null;
  const args = afterGlobalFlags(tokens);
  const [subcommand] = args;
  if (!subcommand || READ_OPS.has(subcommand)) return null;

  const hit = targetsFor(args, context.repoFor(part, context.index))
    .filter(Boolean)
    .find((target) => context.protectedBranches.includes(target.replace(/^refs\/heads\//, "")));
  return hit ? { subcommand, branch: hit } : null;
}

/**
 * Pure, so the decision can be tested as a table without spawning anything — the idiom
 * D35 asks of every guard. `repoFor` is how the impure half arrives: one call per command
 * segment, answering which branches that segment could be writing to and how to resolve a
 * ref inside it. A single `currentBranch` is the shorthand for the one-repository case.
 */
export function protectedBranchViolation({ command, protectedBranches = [], currentBranch = null, resolveRef = () => null, repoFor = null }) {
  if (!command || !command.includes("git")) return null;
  const forPart = repoFor ?? (() => ({ branches: [currentBranch], resolveRef }));
  const parts = splitCommands(command);
  for (let index = 0; index < parts.length; index += 1) {
    const found = violationIn(parts[index], { protectedBranches, repoFor: forPart, index });
    if (found) return found;
  }
  return null;
}

export function protectedBranchMessage(violation) {
  return `kiln blocked \`git ${violation.subcommand}\`: ${violation.branch} is a protected branch.
Work on a branch and open a pull request. To change what is protected, edit vcs.protected in .kiln/config.json.`;
}
