import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { unsatisfiedSteps } from "./init.mjs";
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

function checkWork(root) {
  const unreadable = listWork(root).filter((row) => row.status === "unreadable");
  if (unreadable.length === 0) return check(OK, { title: "work", detail: `${listWork(root).length} work director(ies)` });
  return check(FAIL, { title: "work", detail: `state unreadable, which blocks every guarded write: ${unreadable.map((r) => r.id).join(", ")}` });
}

export function runChecks(root, loaded) {
  return [
    checkNode(),
    checkSchema(loaded),
    ...checkStack(loaded.config),
    checkRouting(root),
    checkBudget(root, loaded.config.rules.budget_lines),
    checkWork(root),
  ];
}

export function worstStatus(results) {
  if (results.some((row) => row.status === FAIL)) return FAIL;
  return results.some((row) => row.status === WARN) ? WARN : OK;
}

export const STATUS = Object.freeze({ ok: OK, warn: WARN, fail: FAIL });
