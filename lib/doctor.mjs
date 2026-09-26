import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION, integrationBranch, parseJsonText } from "./config.mjs";
import { PATHS, autoEligible } from "./ceremony.mjs";
import { floorStatus } from "./floor.mjs";
import { detectModules, modulesOf, protectedBranchesFor } from "./modules.mjs";
import { trackedUnder } from "./guards/git-repo.mjs";
import { gitOutput, ignoredLines, unsatisfiedSteps } from "./init.mjs";
import { readRoutes, rulesDir } from "./rules.mjs";
import { effectiveSteps, loadStack } from "./stack.mjs";
import { unreachableSteps } from "./steps.mjs";
import { listWork } from "./work.mjs";

const OK = "ok";
const WARN = "warn";
const FAIL = "fail";

function check(status, { title, detail }) {
  return { status, title, detail };
}

/**
 * D54's floor: node missing from PATH is the failure no invariant over guard code can
 * reach, because the dispatcher never starts and a hook that never starts is allowed.
 * Nothing can enforce this at runtime, so it is checked here, where a person is looking.
 */
function checkNode() {
  const found = spawnSync("node", ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  if (found.status !== 0) {
    return check(FAIL, { title: "node on PATH", detail: "hooks run `node`; if it is not on PATH they fail open and every guard is off" });
  }
  return check(OK, { title: "node on PATH", detail: found.stdout.trim() });
}

function checkSchema({ migrated, foundVersion }) {
  if (!migrated) return check(OK, { title: "config schema", detail: "current" });
  return check(WARN, { title: "config schema", detail: `file is at ${foundVersion}; kiln read it as ${SCHEMA_VERSION} and did not rewrite it — \`kiln doctor --write\` does` });
}

/** A module path that is not there is a module every per-module answer is wrong about. */
function checkModules(root, config) {
  const lost = Object.entries(modulesOf(config)).filter(([, path]) => !existsSync(join(root, path)));
  if (lost.length === 0) return check(OK, { title: "modules", detail: `${Object.keys(modulesOf(config)).length} module(s), all present` });
  const rows = lost.map(([name, path]) => `${name} → ${path}`).join(", ");
  return check(FAIL, { title: "modules", detail: `repo.modules names paths that are not here: ${rows}. \`kiln doctor --write\` repairs the ones .gitmodules can answer` });
}

function checkIgnored(root, config) {
  const file = join(root, ".gitignore");
  const present = new Set((existsSync(file) ? readFileSync(file, "utf8") : "").split("\n").map((line) => line.trim()));
  const missing = ignoredLines(config).filter((line) => !present.has(line));
  if (missing.length === 0) return check(OK, { title: "gitignore", detail: ignoredLines(config).join(", ") });
  return check(WARN, { title: "gitignore", detail: `${missing.join(", ")} is not ignored, so it can reach a pull request — \`kiln doctor --write\` adds it` });
}

const EMPTY_STEPS = `"steps" in .kiln/config.json is empty, so \`kiln verify\` has nothing to run and refuses rather than reporting a pass nobody earned`;

function strandedFindings(steps) {
  return unreachableSteps(steps).map((row) =>
    check(FAIL, {
      title: "stack",
      detail: `step "${row.step}" requires the effect "${row.effect}", which no ${row.phase}-phase step provides — it can never run, and a phase where everything is skipped verifies nothing`,
    }),
  );
}

function gapFindings(steps, cmd) {
  return unsatisfiedSteps({ steps }, cmd).map((gap) =>
    check(FAIL, { title: "stack", detail: `step "${gap.step}" needs stack.cmd.${gap.key}; it will refuse to run until you set it` }),
  );
}

function checkStack(config) {
  let stack;
  try {
    stack = loadStack(config.stack.id);
  } catch (error) {
    return [check(FAIL, { title: "stack", detail: error.message })];
  }
  const steps = effectiveSteps(stack, config);
  if (steps.length === 0) return [check(FAIL, { title: "stack", detail: EMPTY_STEPS })];

  const findings = [...gapFindings(steps, config.stack.cmd), ...strandedFindings(steps)];
  if (findings.length > 0) return findings;
  return [check(OK, { title: "stack", detail: `${config.stack.id} — every step has its command` })];
}

function ruleFiles(root) {
  try {
    return readdirSync(rulesDir(root)).filter((name) => name.endsWith(".md") && name !== "index.md");
  } catch {
    return [];
  }
}

/**
 * A row the router cannot resolve is named, never dropped. Cursor's rules are skipped
 * silently when their frontmatter is malformed — no warning, no log — and the resulting
 * reports all read the same way: the rule exists, it is routed, and the agent behaves as
 * though it were not there. There is no symptom to debug, which is what makes it expensive.
 */
const BROKEN_ROW = {
  half: (row) => `"${row.trigger || row.file}" fills one of the two columns, so it routes nothing`,
  escapes: (row) => `"${row.file}" is not a file in .kiln/rules/ — a rule kiln reads may not be a symlink or sit behind one`,
  missing: (row) => `"${row.file}" is routed from "${row.trigger}" and is not in .kiln/rules/`,
  "no-table": () => "index.md has rows but no `|---|---|` separator, so it is not a table and nothing in it routes",
};

function brokenRows(root) {
  return readRoutes(root)
    .filter((row) => BROKEN_ROW[row.state])
    .map((row) => check(FAIL, { title: "rules routing", detail: BROKEN_ROW[row.state](row) }));
}

function orphanFinding(root) {
  const routed = new Set(readRoutes(root).map((row) => row.file));
  const orphans = ruleFiles(root).filter((name) => !routed.has(name));
  if (orphans.length === 0) return null;
  return check(FAIL, { title: "rules routing", detail: `unrouted, so dead weight: ${orphans.join(", ")}` });
}

/**
 * A trigger matching nothing is the other half of "unrouted is dead weight": the file is
 * routed, the route is well-formed, and it still reaches no file in this project. git is
 * asked what the project contains rather than the filesystem walked, so ignored and
 * untracked paths do not make a dead route look live.
 */
function deadRoutes(root) {
  const paths = trackedUnder(root);
  if (paths.length === 0) return [];
  return readRoutes(root)
    .filter((row) => row.state === "route" && !paths.some((path) => row.match.test(path)))
    .map((row) => check(WARN, { title: "rules routing", detail: `"${row.trigger}" matches no file here, so ${row.file} reaches no stage` }));
}

function checkRouting(root) {
  const findings = [...brokenRows(root), orphanFinding(root), ...deadRoutes(root)].filter(Boolean);
  if (findings.length > 0) return findings;
  const routed = readRoutes(root).filter((row) => row.state === "route").length;
  return [check(OK, { title: "rules routing", detail: `${ruleFiles(root).length} rule file(s), ${routed} route(s), all resolved` })];
}

/** The goal is flat total volume, not a volume that grows once per incident. */
function checkBudget(root, budget) {
  const lines = [...ruleFiles(root), "index.md"]
    .filter((name) => existsSync(join(rulesDir(root), name)))
    .reduce((sum, name) => sum + readFileSync(join(rulesDir(root), name), "utf8").split("\n").length, 0);
  const status = lines > budget ? WARN : OK;
  return check(status, { title: "rules budget", detail: `${lines} of ${budget} lines` });
}

/**
 * The branch a project ships from is the one its config declares. `defaultBranch` is
 * init's detection fallback: when `refs/remotes/origin/HEAD` is unset — common in a
 * submodule superproject — it answers with whatever branch you are standing on. Reading
 * that as authority told a real repository it ships from the feature branch the previous
 * run had created, while `integration_branch` said otherwise two lines above. So the
 * remote is read here directly, and an unset `origin/HEAD` means no second opinion
 * rather than a wrong one.
 *
 * A config that declares a shipping branch it does not protect is the actual error — the
 * shape init produces when run from a feature branch. A remote whose default differs from
 * the declaration is worth a word, not a failure: shipping to a staging branch is a
 * legitimate thing to do, and a false FAIL teaches an agent to route around blocks.
 */
function remoteDefaultBranch(root) {
  const head = gitOutput(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  return head ? head.replace(/^refs\/remotes\/origin\//, "") : null;
}

function checkProtected(root, config) {
  const effective = protectedBranchesFor(config);
  const remote = remoteDefaultBranch(root);
  if (remote && !effective.includes(remote)) {
    return check(WARN, {
      title: "protected branches",
      detail: `the remote's default is "${remote}", which is not protected`,
    });
  }
  return check(OK, { title: "protected branches", detail: effective.join(", ") });
}

/**
 * The map used to be stored faithfully and resolved by nobody, which doctor said out loud
 * because a config that looks in force and is not is the silent wrongness this project
 * refuses. It has a reader now: every module's shipping branch is protected, so what this
 * check reports is which branch each module ships from.
 */
function branchRows(config) {
  const declared = config.vcs.integration_branch;
  const modules = Object.keys(modulesOf(config));
  if (typeof declared === "string" && modules.length === 0) return declared;
  return [`. → ${integrationBranch(config)}`, ...modules.map((name) => `${name} → ${integrationBranch(config, name)}`)].join(", ");
}

const hasCommit = (dir, ref) => Boolean(gitOutput(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));

/**
 * git run in a module directory that was never initialised answers for the repository above
 * it, so that module would be judged by its parent's branches — the rule `checkedOut` in the
 * DNA scan applies.
 */
function isOwnCheckout(dir) {
  const top = gitOutput(dir, ["rev-parse", "--show-toplevel"]);
  return Boolean(top) && realpathSync(top) === realpathSync(dir);
}

/** Why a checkout cannot give its integration branch, or null when it can or has nothing to judge. */
function branchProblem(dir, { branch, module }) {
  if (!existsSync(dir)) return null;
  if (module && !isOwnCheckout(dir)) return "is not a checkout of its own (git submodule update --init)";
  if (!hasCommit(dir, "HEAD") || [`origin/${branch}`, branch].some((ref) => hasCommit(dir, ref))) return null;
  return `has no ${branch} — neither origin/${branch} nor a local one`;
}

/** D171: the refs `kiln dna` pins from (D80) and a pull request targets. A checkout with no commit yet is not judged. */
function branchProblems(root, config) {
  const repos = [{ path: ".", branch: integrationBranch(config) }, ...Object.entries(modulesOf(config)).map(([name, path]) => ({ path, branch: integrationBranch(config, name), module: true }))];
  return repos.map((repo) => ({ path: repo.path, problem: branchProblem(join(root, repo.path), repo) })).filter((row) => row.problem);
}

function checkIntegrationBranch(root, config) {
  const title = "integration branch";
  if (typeof config.vcs.integration_branch !== "string" && config.repo.kind !== "multi") {
    return check(FAIL, { title, detail: `a per-module map needs repo.kind "multi"; this config says "${config.repo.kind}", so nothing resolves it` });
  }
  const problems = branchProblems(root, config);
  if (problems.length === 0) return check(OK, { title, detail: branchRows(config) });
  const named = problems.map((row) => `${row.path} ${row.problem}`).join("; ");
  return check(WARN, { title, detail: `${named}. kiln dna cannot pin it (D80) and a pull request has no base; give each checkout its own branch with a per-module map (D81). Configured: ${branchRows(config)}` });
}

const WORK_FINDING = {
  unreadable: (ids) => `state unreadable, which blocks every guarded write: ${ids}`,
  invalid: (ids) => `a directory here cannot be a work id, so no command can address it — rename or delete it: ${ids}`,
  unopened: (ids) => `artifacts but no state.json, so nothing enforces a gate on them — run \`kiln open\` for it, or delete the directory: ${ids}`,
};

function checkWork(root) {
  const rows = listWork(root);
  const found = ["unreadable", "invalid", "unopened"].map((status) => [status, rows.filter((row) => row.status === status)]);
  const [status, hits] = found.find(([, matches]) => matches.length > 0) ?? [];
  if (!status) return check(OK, { title: "work", detail: `${rows.length} work director(ies)` });
  return check(status === "unreadable" ? FAIL : WARN, { title: "work", detail: WORK_FINDING[status](hits.map((row) => row.id).join(", ")) });
}


/** An unowned work is one no guard can match, so its gate is not enforced on anything. */
function checkBound(root) {
  const unbound = activeWorkIds(root).filter((id) => !readStateQuietly(root, id)?.session_id);
  if (unbound.length === 0) return check(OK, { title: "work is owned", detail: "every active work has a session" });
  if (unbound.length === 1) {
    return check(WARN, { title: "work is owned", detail: `${unbound[0]} has no session yet; the next guarded call in a session claims it` });
  }
  return check(FAIL, {
    title: "work is owned",
    detail: `${unbound.length} works have no session, so none can be claimed automatically and guard-gate enforces nothing: ${unbound.join(", ")}`,
  });
}

const STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_STATUSES = new Set(["in_progress", "reviewed", "halted"]);

function daysUntouched(root, id) {
  return Math.floor((Date.now() - statSync(join(root, ".kiln", "work", id, "state.json")).mtimeMs) / DAY_MS);
}

/**
 * An open work gates edits and claims files until it ships or is closed, and one left open
 * by an abandoned run — or by a release that had no `kiln close` — does so for good. Only the
 * user can say it is over, so doctor names it and the command, and closes nothing.
 */
function checkStale(root) {
  const stale = listWork(root)
    .filter((row) => OPEN_STATUSES.has(row.status))
    .map((row) => ({ id: row.id, days: daysUntouched(root, row.id) }))
    .filter((row) => row.days >= STALE_DAYS);
  if (stale.length === 0) return check(OK, { title: "open work is current", detail: `nothing open and untouched for ${STALE_DAYS}+ days` });
  const listed = stale.map((row) => `${row.id} (${row.days} days)`).join(", ");
  return check(WARN, { title: "open work is current", detail: `still open, untouched: ${listed}. If it is over, the user closes it: kiln close <id> --answer "<why>"` });
}

function activeWorkIds(root) {
  return listWork(root).filter((row) => row.status === "in_progress" || row.status === "halted").map((row) => row.id);
}

function readStateQuietly(root, id) {
  try {
    return parseJsonText(readFileSync(join(root, ".kiln", "work", id, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The floor is the only layer that sees a push after git has resolved it, and it is
 * switched off by being absent as easily as by `--no-verify`. Nothing at runtime can
 * notice a hook that was never installed, so it is checked here — the same reason D54
 * puts `node on PATH` in this list.
 */
function checkFloor(root) {
  const rows = floorStatus(root).filter((row) => row.state !== "not-a-repo");
  const problems = rows.filter((row) => row.state !== "installed");
  if (problems.length === 0) {
    return [check(OK, { title: "push floor", detail: `pre-push installed in ${rows.length} checkout(s)` })];
  }
  return problems.map((row) => check(WARN, { title: "push floor", detail: floorDetail(row) }));
}

const FOREIGN_LINE = 'exec node "$(git rev-parse --show-superproject-working-tree || git rev-parse --show-toplevel)/.kiln/hooks/pre-push.mjs" "$@"';

const FLOOR_DETAIL = {
  missing: "no pre-push hook; run `kiln doctor --write` to install one",
  // The old text handed out `--show-toplevel`, which inside a submodule is the submodule —
  // the exact line that made every submodule push fail.
  foreign: `a pre-push hook is already here and kiln will not replace it — add \`${FOREIGN_LINE}\` to it`,
  elsewhere: "core.hooksPath points outside this checkout, so kiln cannot install there — the floor is absent",
  stale: "the pre-push hook here was written by an older kiln; run `kiln doctor --write` to replace it",
  "no-runner": "a pre-push hook is installed but no .kiln/hooks/pre-push.mjs exists above this checkout, so it checks nothing — run `kiln doctor --write` at the project root",
};

function floorDetail(row) {
  return `${row.checkout}: ${FLOOR_DETAIL[row.state]}`;
}

/**
 * Auto mode rules gates on the user's behalf, and it is off by default — so the one thing
 * that must never happen is finding out afterwards. It is reported whichever way it is set.
 */
function checkAuto(config) {
  const on = PATHS.filter((path) => autoEligible(path, { config }).eligible);
  if (on.length === 0) return check(OK, { title: "auto mode", detail: "off by default — add `--auto` to a request to turn it on for that run" });
  return check(WARN, {
    title: "auto mode",
    detail: `ON for ${on.join(", ")} — kiln rules those gates itself; \`kiln report <id>\` lists what it decided`,
  });
}

export function runChecks(root, loaded) {
  return [
    checkNode(),
    checkSchema(loaded),
    checkModules(root, loaded.config),
    checkIgnored(root, loaded.config),
    ...checkStack(loaded.config),
    checkProtected(root, loaded.config),
    checkIntegrationBranch(root, loaded.config),
    ...checkRouting(root),
    checkBudget(root, loaded.config.rules.budget_lines),
    checkWork(root),
    checkBound(root),
    checkStale(root),
    ...checkFloor(root),
    checkAuto(loaded.config),
  ];
}

/**
 * What doctor can repair without guessing. An unrouted rule cannot be routed for you and an
 * unset command cannot be invented — but each of these has exactly one right answer: a
 * shipping branch that is unprotected, a module path `.gitmodules` names differently (D39,
 * inherited from unioss's `scan --write`), and a file an older kiln wrote.
 */
export function repairs({ root, config, migrated = false }) {
  return [protectBranch, relocateModules, currentSchema].reduce((done, repair) => {
    const next = repair({ root, config: done.config, migrated });
    return next ? { config: next.config, what: [...done.what, next.what] } : done;
  }, { config, what: [] });
}

function protectBranch({ config }) {
  const shipsFrom = integrationBranch(config);
  if (!shipsFrom || config.vcs.protected.includes(shipsFrom)) return null;
  return {
    what: `add "${shipsFrom}" to vcs.protected`,
    config: { ...config, vcs: { ...config.vcs, protected: [...config.vcs.protected, shipsFrom] } },
  };
}

function relocateModules({ root, config }) {
  const declared = modulesOf(config);
  const detected = detectModules(root);
  const moved = Object.entries(declared).filter(([name, path]) => !existsSync(join(root, path)) && detected[name]);
  if (moved.length === 0) return null;
  const modules = { ...declared, ...Object.fromEntries(moved.map(([name]) => [name, detected[name]])) };
  return { what: moved.map(([name]) => `repo.modules.${name} → ${detected[name]}`).join(", "), config: { ...config, repo: { ...config.repo, modules } } };
}

function currentSchema({ config, migrated }) {
  return migrated ? { what: `schema_version → ${SCHEMA_VERSION}`, config: { ...config, schema_version: SCHEMA_VERSION } } : null;
}

export function worstStatus(results) {
  if (results.some((row) => row.status === FAIL)) return FAIL;
  return results.some((row) => row.status === WARN) ? WARN : OK;
}

export const STATUS = Object.freeze({ ok: OK, warn: WARN, fail: FAIL });
