import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, deepMerge, parseJsonText } from "./config.mjs";
import { detectModules } from "./modules.mjs";
import { UNDETECTED, loadStack } from "./stack.mjs";

const TMP_IGNORE = ".kiln/tmp/";

export const RULES_INDEX = `# Project rules

Every file in this directory must appear in the table below.
**Unrouted is dead weight: route it, or do not add it.**

| Trigger — a path glob | Rule file |
|---|---|
| _(none yet)_ | — |

A trigger is a path glob and nothing else: \`*\` stops at a slash, \`**\` crosses one, \`?\` is
one character. \`src/auth/**\`, \`**/*.sql\`, \`package.json\`.

There is no "applies when the topic comes up" trigger, deliberately. That kind is matched by
the model reading a description, which is unverifiable — nothing can tell you afterwards
whether the rule was applied — and it is where every report of a rule being silently ignored
comes from.

## Adding one

\`kiln rules add <file>.md --trigger "<glob>"\` writes the file and the row together, refuses
a name or a glob that would not resolve, and runs the checks below. Editing this table by
hand works too — the table is the contract, not the command.

## What reads this

\`kiln rules <id>\` matches the globs above against the files the stage names, and prints the
rules that match. It runs twice:

- at **PLAN**, against the change preview, so a rule shapes the plan;
- at **REVIEW**, against the diff that actually happened, so a rule still reaches a file the
  plan never predicted.

What it handed over is recorded in the work's \`state.json\`, so *this rule applied* is a fact
rather than a hope.

## Before adding a rule

Every rule line is a token the agent pays on **every later ticket**, and the longer the rules
get the lower its compliance with each one — so adding a rule to force compliance can
backfire. Three questions before you keep one:

1. Can it merge into a rule that already exists? Prefer editing the old file to adding a new
   one.
2. Can an equivalent passage be deleted? Total volume stays flat; it does not grow once per
   incident.
3. Is it routed in the table above?

\`kiln rules add\` answers all three where you write the rule: it names what already covers
the same files, prints the line count before and after, and routes it.

\`kiln doctor\` mechanizes two of the three: it names every row that does not resolve — a
half-filled row, a rule file that is not here, a glob that matches nothing in this project —
and it compares the total against \`rules.budget_lines\` in \`.kiln/config.json\`. Whether a rule
could have merged is judgment, and stays with the reviewer.
`;

function readJsonIfPresent(path) {
  try {
    return parseJsonText(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Never throws: a directory with no git is a supported starting point (D60.5). */
export function gitOutput(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * D40: three real Node projects use three different linters, so there is no correct
 * default. A lint step exists only when the project already declares one.
 */
function nodeCommands(pkg, root) {
  const scripts = pkg.scripts ?? {};
  const cmd = { test: scripts.test ? "npm test" : "" };
  if (existsSync(join(root, "tsconfig.json"))) cmd.typecheck = "tsc --noEmit";
  if (scripts.lint) cmd.lint = "npm run lint";
  return cmd;
}

/** One step per command detected, in the order they should run. */
const GENERIC_ORDER = ["typecheck", "lint", "unit"];

/**
 * D86: init writes the steps it can satisfy. The adapter's own list comes first when
 * there is one — php-ci3's `migrate` has no equivalent in the generic order, so deriving
 * only from the generic order silently drops it — and each step is kept only if every
 * `${cmd.x}` it names is set.
 */
export function stepsFor(cmd, stack = null) {
  return [...fastSteps(cmd), ...fullSteps(cmd, stack)];
}

function fullSteps(cmd, stack) {
  const declared = (stack?.steps ?? []).filter((step) => unsatisfiedSteps({ steps: [step] }, cmd).length === 0);
  if (declared.length > 0) return declared;

  const keyFor = (id) => (id === "unit" ? "test" : id);
  return GENERIC_ORDER.filter((id) => cmd[keyFor(id)]).map((id) => ({ id, run: `\${cmd.${keyFor(id)}}` }));
}

/**
 * The fast phase is what `kiln verify --phase fast` runs after every task, and no shipped
 * adapter could fill it: php-ci3 offered only `migrate`, which init drops on a project with
 * no migrate command, and node offered nothing. So on a real PHP project the phase was
 * empty, the per-task call refused, and the work reached IMPLEMENT with `verify: []` — eight
 * watched red/green cycles and not one of them in kiln's ledger.
 *
 * No adapter can supply this. jest has --onlyChanged, vitest --changed, pytest --lf, phpunit
 * --filter, go a package path; there is no portable spelling to ship, and inventing one
 * would bake a single project's convention into every project's config. So it is asked (D92)
 * — and a blank answer is a real answer, leaving the phase honestly empty.
 */
function fastSteps(cmd) {
  return cmd.test_fast ? [{ id: "unit-fast", phase: "fast", run: "${cmd.test_fast}" }] : [];
}

/**
 * Only a stack kiln can load may be named. Detection answered `php` for a composer project
 * without CodeIgniter, `init` wrote it, and `kiln doctor` then failed with `no stack named
 * "php"` — a config that cannot work, produced by the command whose job is to produce one
 * that does. An id with no adapter is `unknown`, which asks the user (D92) instead.
 */
function servable(id) {
  try {
    loadStack(id);
    return true;
  } catch {
    return false;
  }
}

function candidatesIn(dir, label) {
  const found = [];
  const pkg = readJsonIfPresent(join(dir, "package.json"));
  if (pkg) found.push({ id: "node", cmd: nodeCommands(pkg, dir), evidence: `${label}package.json` });

  const composer = readJsonIfPresent(join(dir, "composer.json"));
  if (composer) found.push({ id: phpFlavour(dir, composer), cmd: {}, evidence: `${label}composer.json` });
  return found.filter((row) => servable(row.id));
}

/**
 * CodeIgniter 3 predates composer and is normally vendored into the tree, so a project can
 * be CI3 with an empty `require` — which is exactly what a real one turned out to be, and
 * reading only the manifest called it plain `php`. `system/core/CodeIgniter.php` is the
 * framework's own file and is there either way.
 */
function phpFlavour(dir, composer) {
  if (JSON.stringify(composer.require ?? {}).includes("codeigniter")) return "php-ci3";
  return existsSync(join(dir, "system", "core", "CodeIgniter.php")) ? "php-ci3" : "php";
}

function scan(root) {
  const here = candidatesIn(root, "");
  if (here.length > 0) return here;
  return Object.values(detectModules(root)).flatMap((path) => candidatesIn(join(root, path), `${path}/`));
}

/** `php-ci3` describes a project `php` also describes, so on a tie the narrower one leads. */
function specificity(id) {
  return id.includes("-") ? 1 : 0;
}

/**
 * Two honest answers and one dishonest one. A superproject usually holds no manifest of its
 * own, so reading only the root answered "unknown" for a checkout with four `composer.json`
 * files in it. Reading the modules and taking the first hit then answered "node" for a
 * CodeIgniter application that also builds its own assets — worse, because "unknown" makes a
 * user look and a wrong name makes them nod.
 *
 * So a tie is reported as a tie. `alternatives` is what `init` prints and asks about, and
 * the winner is the stack seen in the most places rather than the one whose manifest kiln
 * happens to check first.
 */
export function detectStack(root) {
  const found = scan(root);
  if (found.length === 0) return { id: UNDETECTED, cmd: {}, evidence: null, alternatives: [] };

  const ranked = [...new Set(found.map((row) => row.id))]
    .map((id) => ({ id, seen: found.filter((row) => row.id === id).length }))
    .sort((left, right) => right.seen - left.seen || specificity(right.id) - specificity(left.id) || left.id.localeCompare(right.id));

  const winner = found.find((row) => row.id === ranked[0].id);
  return { ...winner, alternatives: ranked.slice(1).map((row) => row.id) };
}

function providerFor(remoteUrl) {
  if (!remoteUrl) return DEFAULTS.vcs.provider;
  if (remoteUrl.includes("gitlab")) return "gitlab";
  return "github";
}

/**
 * `symbolic-ref` answers on an unborn branch, where `rev-parse HEAD` has nothing to
 * resolve. Guessing "main" there would protect a branch that does not exist and leave
 * the real one open.
 */
function currentBranch(root) {
  const named = gitOutput(root, ["symbolic-ref", "--short", "HEAD"]);
  if (named) return named;
  const detached = gitOutput(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return detached && detached !== "HEAD" ? detached : null;
}

/**
 * The branch the project ships from, which is the remote's default — not wherever the
 * user happens to be standing. Reading the current branch instead protects the feature
 * branch someone made to try kiln out and leaves the real one wide open, which is D7
 * item 1 defeated by the ordinary act of running init on a branch.
 */
export function defaultBranch(root) {
  const remoteHead = gitOutput(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead.replace(/^refs\/remotes\/origin\//, "");
  return currentBranch(root);
}

function remoteHead(dir) {
  const head = gitOutput(dir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  return head ? head.replace(/^refs\/remotes\/origin\//, "") : null;
}

/**
 * A superproject often has no remote of its own — every one belongs to a submodule. Reading
 * only the root then answered `github` and `main` for a checkout whose four modules all sit
 * on `gitlab.unioss.jp`, and `kiln doctor` had to come back and correct both. Detection had
 * the modules by then; it just was not looking at them.
 *
 * What still cannot be read is marked `guessed`, so `init` can ask instead of pretending.
 * `defaultBranch` answers with the branch you are standing on when `origin/HEAD` is unset,
 * which is a reasonable fallback and a terrible fact.
 */
export function detectVcs(root) {
  const checkouts = [root, ...Object.values(detectModules(root)).map((path) => join(root, path))];
  const remote = checkouts.map((dir) => gitOutput(dir, ["remote", "get-url", "origin"])).find(Boolean);
  const head = checkouts.map(remoteHead).find(Boolean);
  const integration = head ?? defaultBranch(root) ?? DEFAULTS.vcs.integration_branch;
  return {
    provider: providerFor(remote),
    integration_branch: integration,
    protected: [integration],
    remote: remote ?? null,
    guessed: !head,
  };
}

/**
 * The three questions §3b allows, each carrying the answer kiln would use anyway,
 * so a user who reads none of them still gets a working config.
 */
export function proposeConfig(root) {
  const stack = detectStack(root);
  const vcs = detectVcs(root);
  const modules = detectModules(root);
  const config = deepMerge(DEFAULTS, {
    repo: Object.keys(modules).length > 0 ? { kind: "multi", root: null, modules } : { kind: "single", root: null },
    vcs: { provider: vcs.provider, integration_branch: vcs.integration_branch, protected: vcs.protected, branch_pattern: DEFAULTS.vcs.branch_pattern },
    tracker: { provider: vcs.provider },
    stack: { id: stack.id, cmd: stack.cmd, steps: stepsFor(stack.cmd) },
  });
  return { config, questions: questionsFor(config, { stack, vcs }), detected: { stack, vcs } };
}

/**
 * D92: a question is asked when detection has no answer, not because a list said three.
 * Two are always asked — what must never be pushed to, and what runs the tests — because
 * neither is ever readable from disk. The rest appear only on the projects that need them:
 * a checkout that looks like several stacks, a repository where nothing names a default
 * branch, a remote that names no forge.
 *
 * On a real setup the fixed three did not reduce the questions; it moved them. `init` never
 * asked which branch pull requests target, wrote `main` for a project shipping `v3-master`,
 * and `kiln doctor` asked the same thing afterwards with the file already on disk.
 */
function questionsFor(config, { stack, vcs }) {
  return [
    ...(stack.alternatives?.length > 0
      ? [{ key: "stack.id", ask: "This checkout looks like more than one stack. Which one does kiln verify?", default: stack.id, options: [stack.id, ...stack.alternatives] }]
      : []),
    ...(vcs.guessed
      ? [{ key: "vcs.integration_branch", ask: "Nothing here names a default branch, so this is a guess. Which branch do pull requests target?", default: config.vcs.integration_branch }]
      : []),
    { key: "vcs.protected", ask: "Which branches must never be pushed to?", default: config.vcs.protected },
    { key: "stack.cmd.test", ask: "What runs your tests?", default: stack.cmd.test ?? "" },
    { key: "stack.cmd.test_fast", ask: "What runs a fast subset of them, for the check after each task? Blank if there is none.", default: stack.cmd.test_fast ?? "" },
    ...(vcs.provider === DEFAULTS.vcs.provider && !vcs.remote
      ? [{ key: "tracker.provider", ask: "No remote names a forge. Which tracker, if any?", default: config.tracker.provider }]
      : []),
  ];
}

/**
 * D40 rejected "skip a step whose script does not exist", and D60.1 makes an unset
 * ${cmd.x} refuse to run. Both are right, and together they mean the gap has to be
 * reported here — at the one moment the user is looking — not at the first verify.
 */
export function unsatisfiedSteps(stack, cmd) {
  const referenced = (step) => [...String(step.run).matchAll(/\$\{cmd\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
  return (stack.steps ?? [])
    .flatMap((step) => referenced(step).map((key) => ({ step: step.id, key })))
    .filter((row) => !cmd?.[row.key]);
}

export function initTargets(root) {
  return [
    { path: join(root, ".kiln", "config.json"), kind: "config" },
    { path: join(root, ".kiln", "rules", "index.md"), kind: "rules" },
    { path: join(root, ".gitignore"), kind: "gitignore" },
  ];
}

/** Reports before it writes, because D60.4's whole point is that init overwrites nothing. */
export function planInit(root) {
  const existing = [];
  const missing = [];
  for (const target of initTargets(root)) {
    (existsSync(target.path) ? existing : missing).push(target);
  }
  return { existing, missing };
}

function ensureTmpIgnored(path) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split("\n").some((line) => line.trim() === TMP_IGNORE)) return false;
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${current}${separator}${TMP_IGNORE}\n`, "utf8");
  return true;
}

function writeIfMissing(path, contents) {
  if (existsSync(path)) return false;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return true;
}

/**
 * Appending to .gitignore is the one exception to "writes only what is missing": the
 * file usually exists, and the line inside it is what has to be there.
 */
export function applyInit(root, config) {
  const written = [];
  const kept = [];
  const body = `${JSON.stringify(config, null, 2)}\n`;
  const record = (target, didWrite) => (didWrite ? written : kept).push(target.path);

  for (const target of initTargets(root)) {
    if (target.kind === "gitignore") record(target, ensureTmpIgnored(target.path));
    else record(target, writeIfMissing(target.path, target.kind === "config" ? body : RULES_INDEX));
  }
  return { written, kept };
}
