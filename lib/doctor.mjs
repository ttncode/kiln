import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { integrationBranch } from "./config.mjs";
import { defaultBranch, unsatisfiedSteps } from "./init.mjs";
import { effectiveSteps, loadStack } from "./stack.mjs";
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

function checkStack(config) {
  let stack;
  try {
    stack = loadStack(config.stack.id);
  } catch (error) {
    return [check(FAIL, { title: "stack", detail: error.message })];
  }
  const gaps = unsatisfiedSteps({ steps: effectiveSteps(stack, config) }, config.stack.cmd);
  if (gaps.length === 0) return [check(OK, { title: "stack", detail: `${config.stack.id} — every step has its command` })];
  return gaps.map((gap) =>
    check(FAIL, { title: "stack", detail: `step "${gap.step}" needs stack.cmd.${gap.key}; it will refuse to run until you set it` }),
  );
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
 * The failure this catches: init run from a feature branch protected that branch and
 * left the branch the project actually ships from open to a push.
 */
function checkProtected(root, config) {
  const shipsFrom = defaultBranch(root);
  if (!shipsFrom) return check(OK, { title: "protected branches", detail: config.vcs.protected.join(", ") });
  if (config.vcs.protected.includes(shipsFrom)) {
    return check(OK, { title: "protected branches", detail: config.vcs.protected.join(", ") });
  }
  return check(FAIL, {
    title: "protected branches",
    detail: `this repository ships from "${shipsFrom}", which is not in vcs.protected — a push to it would be allowed`,
  });
}

/**
 * D81 lets `integration_branch` be a per-module map, and v1 has nothing that names a
 * module: every reader asks for the scalar. So a map is stored faithfully and resolved
 * by nobody, which is the silent-wrongness this project exists to refuse — it is said
 * out loud here instead.
 */
function checkIntegrationBranch(config) {
  const declared = config.vcs.integration_branch;
  if (typeof declared === "string") return check(OK, { title: "integration branch", detail: declared });
  if (config.repo.kind !== "multi") {
    return check(FAIL, {
      title: "integration branch",
      detail: `a per-module map needs repo.kind "multi"; this config says "${config.repo.kind}", so nothing resolves it`,
    });
  }
  return check(WARN, {
    title: "integration branch",
    detail: `map accepted, and no v1 command reads it per module — every reader gets "${integrationBranch(config)}". The drift check that uses the map arrives with the Knowledge tier (D81)`,
  });
}

function checkWork(root) {
  const unreadable = listWork(root).filter((row) => row.status === "unreadable");
  if (unreadable.length === 0) return check(OK, { title: "work", detail: `${listWork(root).length} work director(ies)` });
  return check(FAIL, { title: "work", detail: `state unreadable, which blocks every guarded write: ${unreadable.map((r) => r.id).join(", ")}` });
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
  ];
}

/**
 * The only finding doctor can repair without guessing. An unrouted rule cannot be routed
 * for you and an unset command cannot be invented — but a repository whose shipping
 * branch is unprotected has exactly one right answer, and it is a safety answer.
 */
export function repairs(root, config) {
  const shipsFrom = defaultBranch(root);
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
