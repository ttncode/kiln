import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class StepError extends Error {}

const PLACEHOLDER = /\$\{cmd\.([A-Za-z0-9_]+)\}/g;

/**
 * D60.1: a missing key refuses rather than skipping. D40 rejected "skip when the script
 * does not exist", and a silent skip here is the same question from the other side —
 * a step nobody notices did not run is worse than one that failed.
 */
export function interpolate(template, cmd) {
  return String(template).replace(PLACEHOLDER, (_match, key) => {
    const value = cmd?.[key];
    if (!value) throw new StepError(`step references \${cmd.${key}}, which is not set in .kiln/config.json`);
    return value;
  });
}

function phaseOf(step) {
  return step.phase ?? "full";
}

/**
 * `requires` is a precondition, not an ordering edge: an effect this change does not
 * produce means the step is skipped with a reason, never failed (D29).
 */
export function planSteps(steps, { phase, effects = [] }) {
  return (steps ?? [])
    .filter((step) => phaseOf(step) === phase)
    .map((step) => {
      const missing = (step.requires ?? []).filter((effect) => !effects.includes(effect));
      return missing.length > 0 ? { step, skipped: `requires ${missing.join(", ")}` } : { step };
    });
}

function logPath(tmpDir, id) {
  mkdirSync(tmpDir, { recursive: true });
  return join(tmpDir, `${id}.log`);
}

/**
 * The verdict is the exit code and nothing else. Parsing stdout for a word like
 * "passed" is exactly how D7 item 3 happens, so the output is written to a file and
 * never read for a decision.
 */
export function runStep(step, ctx) {
  const cmd = interpolate(step.run, ctx.cmd);
  const startedAt = Date.now();
  const result = spawnSync(cmd, { cwd: ctx.cwd, shell: true, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(logPath(ctx.tmpDir, step.id), output, "utf8");
  return { id: step.id, cmd, exit: result.status ?? 1, ms: Date.now() - startedAt, range: ctx.range, output };
}

function skippedEntry(step, reason) {
  return { id: step.id, cmd: null, exit: null, ms: 0, skipped: reason };
}

/**
 * Declaration order is the order — no sort, no graph. A failing step stops the run and
 * hands back the tool's own output, because improvising an alternate command is how a
 * broken environment becomes a wrong diagnosis.
 */
export function runPhase(planned, ctx) {
  const entries = [];
  for (const { step, skipped } of planned) {
    if (skipped) {
      entries.push(skippedEntry(step, skipped));
      continue;
    }
    const entry = runStep(step, ctx);
    entries.push(entry);
    if (entry.exit !== 0) return { entries, failed: entry };
  }
  return { entries, failed: null };
}

/** A fast pass ran only what the change touched, so it is never the project's green. */
export function isGreen(result, phase) {
  return phase === "full" && result.failed === null;
}
