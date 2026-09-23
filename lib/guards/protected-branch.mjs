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

/**
 * A push and a HEAD-writing op ask different questions of the same unknown.
 *
 * A refspec can name any ref on the remote, so when kiln cannot tell which checkout a push
 * runs in, every checkout's branch is a genuine candidate and blocking on any of them is a
 * conservative over-approximation — the direction D33 chooses when it cannot tell.
 *
 * `merge`, `commit`, `rebase`, `reset`, `revert` and `cherry-pick` write to exactly one
 * branch: the one HEAD is on, in the one repository the command runs in. "Every checkout"
 * is not a superset of that — it is a different set, and judging against it blocks branches
 * the command could never have touched.
 *
 * Measured on a real monorepo: `git merge origin/v3-master` from a module standing on
 * `feature/v3/#1864` was refused as a write to `v3-master`, because the superproject was on
 * `v3-master` and the directory was not readable from the command text. `v3-master` was the
 * merge's *source*. The user worked around the guard by merging the commit SHA instead,
 * which is the outcome a false block always buys.
 *
 * So an unresolved directory means kiln does not know the target, and not knowing the target
 * of a one-branch write is not a reason to name every branch. D7 item 1 is "never **pushes**
 * to a protected branch"; the push half keeps the over-approximation, which is the half the
 * promise is made of, and it has git's own `pre-push` under it as well.
 */
function targetsFor(args, repo) {
  const [subcommand] = args;
  if (subcommand === "push") return pushTargets(args, repo);
  if (WRITE_OPS.has(subcommand)) return repo.resolved === false ? [] : repo.branches;
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
  const forPart = repoFor ?? (() => ({ branches: [currentBranch], resolved: true, resolveRef }));
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
