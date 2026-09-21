import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { integrationBranch } from "./config.mjs";
import { PATHS, autoEligible } from "./ceremony.mjs";
import { floorStatus } from "./floor.mjs";
import { modulesOf, protectedBranchesFor } from "./modules.mjs";
import { gitOutput, unsatisfiedSteps } from "./init.mjs";
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

function rulesDir(root) {
  return join(root, ".kiln", "rules");
}

function ruleFiles(root) {
  try {
    return readdirSync(rulesDir(root)).filter((name) => name.endsWith(".md") && name !== "index.md");
  } catch {
    return [];
  }
}

/** D20, mechanized: unrouted is dead weight, so an orphan is named rather than tolerated. */
function checkRouting(root) {
  const index = existsSync(join(rulesDir(root), "index.md"))
    ? readFileSync(join(rulesDir(root), "index.md"), "utf8")
    : "";
  const orphans = ruleFiles(root).filter((name) => !index.includes(name));
  if (orphans.length === 0) return check(OK, { title: "rules routing", detail: `${ruleFiles(root).length} rule file(s), all routed` });
  return check(FAIL, { title: "rules routing", detail: `unrouted, so dead weight: ${orphans.join(", ")}` });
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

function checkWork(root) {
  const rows = listWork(root);
  const unreadable = rows.filter((row) => row.status === "unreadable");
  const unopened = rows.filter((row) => row.status === "unopened");
  if (unreadable.length > 0) {
    return check(FAIL, { title: "work", detail: `state unreadable, which blocks every guarded write: ${unreadable.map((r) => r.id).join(", ")}` });
  }
  if (unopened.length > 0) {
    return check(WARN, {
      title: "work",
      detail: `artifacts but no state.json, so nothing enforces a gate on them — run \`kiln open\` for it, or delete the directory: ${unopened.map((r) => r.id).join(", ")}`,
    });
  }
  return check(OK, { title: "work", detail: `${rows.length} work director(ies)` });
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

const FLOOR_DETAIL = {
  missing: "no pre-push hook; run `kiln doctor --write` to install one",
  foreign: "a pre-push hook is already here and kiln will not replace it — chain kiln's `.kiln/hooks/pre-push.mjs` from it",
  shadowed: "core.hooksPath points elsewhere, so a hook written here would never run",
};

function floorDetail(row) {
  return `${row.checkout}: ${FLOOR_DETAIL[row.state]}`;
}

/**
 * Auto mode rules gates on the user's behalf, and it is off by default — so the one thing
 * that must never happen is finding out afterwards. It is reported whichever way it is set.
 */
function checkAuto(config) {
  const on = PATHS.filter((path) => autoEligible(path, config).eligible);
  if (on.length === 0) return check(OK, { title: "auto mode", detail: "off — every gate stops for you" });
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
    checkRouting(root),
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
