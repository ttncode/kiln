import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { integrationBranch } from "./config.mjs";
import { PATHS, autoEligible } from "./ceremony.mjs";
import { floorStatus } from "./floor.mjs";
import { modulesOf, protectedBranchesFor } from "./modules.mjs";
import { trackedUnder } from "./guards/git-repo.mjs";
import { gitOutput, unsatisfiedSteps } from "./init.mjs";
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
  return check(WARN, { title: "config schema", detail: `file is at ${foundVersion}; kiln read it as current but did not rewrite it` });
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
 * D81 lets `integration_branch` be a per-module map, and v1 has nothing that names a
 * module: every reader asks for the scalar. So a map is stored faithfully and resolved
 * by nobody, which is the silent-wrongness this project exists to refuse — it is said
 * out loud here instead.
 */
/**
 * The map used to be stored faithfully and resolved by nobody, which doctor said out loud
 * because a config that looks in force and is not is the silent wrongness this project
 * refuses. It has a reader now: every module's shipping branch is protected, so what this
 * check reports is which branch each module ships from.
 */
function checkIntegrationBranch(config) {
  const declared = config.vcs.integration_branch;
  if (typeof declared === "string" && Object.keys(modulesOf(config)).length === 0) {
    return check(OK, { title: "integration branch", detail: declared });
  }
  if (typeof declared !== "string" && config.repo.kind !== "multi") {
    return check(FAIL, {
      title: "integration branch",
      detail: `a per-module map needs repo.kind "multi"; this config says "${config.repo.kind}", so nothing resolves it`,
    });
  }
  const rows = Object.keys(modulesOf(config)).map((name) => `${name} → ${integrationBranch(config, name)}`);
  return check(OK, { title: "integration branch", detail: [`. → ${integrationBranch(config)}`, ...rows].join(", ") });
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

function activeWorkIds(root) {
  return listWork(root).filter((row) => row.status === "in_progress" || row.status === "halted").map((row) => row.id);
}

function readStateQuietly(root, id) {
  try {
    return JSON.parse(readFileSync(join(root, ".kiln", "work", id, "state.json"), "utf8"));
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
    ...checkStack(loaded.config),
    checkProtected(root, loaded.config),
    checkIntegrationBranch(loaded.config),
    ...checkRouting(root),
    checkBudget(root, loaded.config.rules.budget_lines),
    checkWork(root),
    checkBound(root),
    ...checkFloor(root),
    checkAuto(loaded.config),
  ];
}

/**
 * The only finding doctor can repair without guessing. An unrouted rule cannot be routed
 * for you and an unset command cannot be invented — but a repository whose shipping
 * branch is unprotected has exactly one right answer, and it is a safety answer.
 */
export function repairs(config) {
  const shipsFrom = integrationBranch(config);
  if (!shipsFrom || config.vcs.protected.includes(shipsFrom)) return null;
  return {
    what: `add "${shipsFrom}" to vcs.protected`,
    config: { ...config, vcs: { ...config.vcs, protected: [...config.vcs.protected, shipsFrom] } },
  };
}

export function worstStatus(results) {
  if (results.some((row) => row.status === FAIL)) return FAIL;
  return results.some((row) => row.status === WARN) ? WARN : OK;
}

export const STATUS = Object.freeze({ ok: OK, warn: WARN, fail: FAIL });
