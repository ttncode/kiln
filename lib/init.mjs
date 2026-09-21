import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, deepMerge, parseJsonText } from "./config.mjs";

const TMP_IGNORE = ".kiln/tmp/";

export const RULES_INDEX = `# Project rules

Every file in this directory must appear in the table below.
**Unrouted is dead weight: route it, or do not add it.**

| Trigger — a path glob or a topic | Rule file |
|---|---|
| _(none yet)_ | — |

## Before adding a rule

1. Can it merge into a rule that already exists?
2. Can an equivalent passage be deleted? Total volume stays flat; it does not grow once per
   incident.
3. Is it routed in the table above?

\`kiln doctor\` mechanizes two of the three: it lists files missing from the table, and it
compares the total against \`rules.budget_lines\` in \`.kiln/config.json\`. Whether a rule could
have merged is judgment, and stays with the reviewer.
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
  const declared = (stack?.steps ?? []).filter((step) => unsatisfiedSteps({ steps: [step] }, cmd).length === 0);
  if (declared.length > 0) return declared;

  const keyFor = (id) => (id === "unit" ? "test" : id);
  return GENERIC_ORDER.filter((id) => cmd[keyFor(id)]).map((id) => ({ id, run: `\${cmd.${keyFor(id)}}` }));
}

export function detectStack(root) {
  const pkg = readJsonIfPresent(join(root, "package.json"));
  if (pkg) return { id: "node", cmd: nodeCommands(pkg, root), evidence: "package.json" };

  const composer = readJsonIfPresent(join(root, "composer.json"));
  if (composer) {
    const isCi3 = JSON.stringify(composer.require ?? {}).includes("codeigniter");
    return { id: isCi3 ? "php-ci3" : "php", cmd: {}, evidence: "composer.json" };
  }
  return { id: "unknown", cmd: {}, evidence: null };
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

export function detectVcs(root) {
  const remote = gitOutput(root, ["remote", "get-url", "origin"]);
  const integration = defaultBranch(root) ?? DEFAULTS.vcs.integration_branch;
  return { provider: providerFor(remote), integration_branch: integration, protected: [integration] };
}

/**
 * The three questions §3b allows, each carrying the answer kiln would use anyway,
 * so a user who reads none of them still gets a working config.
 */
export function proposeConfig(root) {
  const stack = detectStack(root);
  const vcs = detectVcs(root);
  const config = deepMerge(DEFAULTS, {
    repo: { kind: "single", root: null },
    vcs: { ...vcs, branch_pattern: DEFAULTS.vcs.branch_pattern },
    tracker: { provider: vcs.provider },
    stack: { id: stack.id, cmd: stack.cmd, steps: stepsFor(stack.cmd) },
  });
  return { config, questions: questionsFor(config, stack), detected: { stack, vcs } };
}

function questionsFor(config, stack) {
  return [
    { key: "vcs.protected", ask: "Which branches must never be pushed to?", default: config.vcs.protected },
    { key: "stack.cmd.test", ask: "What runs your tests?", default: stack.cmd.test ?? "" },
    { key: "tracker.provider", ask: "Which tracker, if any?", default: config.tracker.provider },
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
