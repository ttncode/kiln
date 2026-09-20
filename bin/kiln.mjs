#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { STATUS, runChecks, worstStatus } from "../lib/doctor.mjs";
import { applyInit, planInit, proposeConfig, unsatisfiedSteps } from "../lib/init.mjs";
import { actualChanged, grepBlastRadius, reconcile, reconciliationLine, reconcileVerdict } from "../lib/blast.mjs";
import { canRatchet, ceremonyFor, ratchetRefusal, renderAutoRuled } from "../lib/ceremony.mjs";
import { claimConflicts } from "../lib/guards/context.mjs";
import { effectiveSteps, loadStack } from "../lib/stack.mjs";
import { isGreen, planSteps, runPhase } from "../lib/steps.mjs";
import { recordFullVerified, recordVerify } from "../lib/state.mjs";
import { join } from "node:path";
import { DECISION, classifyAnswer, reAskFor } from "../lib/gate.mjs";
import { resolveArgument } from "../lib/resolve.mjs";
import { newWork, readState, recordGate, writeState } from "../lib/state.mjs";
import { gitOutput } from "../lib/init.mjs";
import { listWork } from "../lib/work.mjs";

const USAGE = `kiln — one unit of work to a reviewed pull request

  kiln init [--propose] [--set <key>=<value> ...]
      Detect the stack and write .kiln/. Overwrites nothing.
      --propose  print the proposed config and its questions; write nothing.
      --set      override one dotted key, e.g. --set stack.cmd.test="npm test".

  kiln resolve [<arg>]
      Decide what <arg> means - a URL, a work in progress, a ticket ref, or a
      description - and print the decision as JSON. Writes nothing.

  kiln open <id> [--session <session-id>] [--path bounded]
      Create the work directory and record the commit it starts from.

  kiln gate <id> <key> --answer "<their words>" [--artifact <path>] [--auto]
      Classify what the user said, hash the artifact, and record what was observed.
      You supply only --answer; every other field is measured here.

  kiln doctor
      Check this project's setup and say what would stop a run.

  kiln verify <id> [--phase fast|full]
      Run the stack's steps for that phase, record every exit code, and stop at
      the first failure with the tool's own output.

  kiln blast <term> [<term> ...]
      Tier-0 blast radius: which files mention these terms.

  kiln scope <id>
      Reconcile what the plan predicted against what the diff actually touched.

  kiln ratchet <id> <spike|bounded|full>
      Move this work up a rung. Prints the uncommitted diff it found and stops;
      it never touches the working tree.

  kiln report <id>
      Print the run's report, including what auto mode decided on your behalf.

  kiln list
      Show work in progress.

The three commands a user types are /kiln init, /kiln <arg> and /kiln doctor.
The verbs here are what the orchestrator skill calls to serve them.
`;

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/** Config is a file the agent may not write (D48), so answers arrive as arguments. */
export function setPath(target, assignment) {
  const separator = assignment.indexOf("=");
  if (separator < 1) throw new Error(`--set expects <key>=<value>, got: ${assignment}`);
  const keys = assignment.slice(0, separator).split(".");
  const raw = assignment.slice(separator + 1);
  const leaf = keys.pop();

  let node = target;
  for (const key of keys) {
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[leaf] = raw.includes(",") ? raw.split(",").map((part) => part.trim()) : raw;
  return target;
}

function applyOverrides(config, argv) {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === "--set") setPath(config, argv[i + 1]);
  }
  return config;
}

function reportInit(result) {
  for (const path of result.kept) out(`  kept    ${path}`);
  for (const path of result.written) out(`  wrote   ${path}`);
  out(result.written.length > 0 ? "\nRun `kiln doctor` to check it." : "\nAlready set up. Run `kiln doctor --write` to repair paths.");
}

function warnUnsatisfied(config) {
  const gaps = unsatisfiedSteps({ steps: effectiveSteps(loadStack(config.stack.id), config) }, config.stack.cmd);
  for (const gap of gaps) {
    process.stderr.write(`note: step "${gap.step}" needs stack.cmd.${gap.key}, which is not set. It will refuse to run until you set it, or remove the step.\n`);
  }
  return 0;
}

function runInit(argv) {
  const root = process.cwd();
  const { config, questions, detected } = proposeConfig(root);
  if (argv.includes("--propose")) {
    out(JSON.stringify({ config, questions, detected }, null, 2));
    return 0;
  }
  out(`stack: ${detected.stack.id}${detected.stack.evidence ? ` (${detected.stack.evidence})` : ""}`);
  out(`integration branch: ${detected.vcs.integration_branch}`);
  out(`${planInit(root).missing.length} file(s) to write`);
  reportInit(applyInit(root, applyOverrides(config, argv)));
  return warnUnsatisfied(config);
}

function runResolve(argv) {
  const { root, config } = loadConfig(process.cwd());
  out(JSON.stringify(resolveArgument({ arg: argv[0], root, config }), null, 2));
  return 0;
}

function runList() {
  const { root } = loadConfig(process.cwd());
  const rows = listWork(root);
  if (rows.length === 0) return out("No work in progress.") ?? 0;
  for (const row of rows) out(`  ${row.id}\t${row.status}\t${row.stage}\tpass ${row.pass}`);
  return 0;
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

/**
 * No verb sets a gate. This one reads an answer, measures the artifact, classifies
 * what was said, and records only that — the shape task-done uses (D65, D71).
 */
function runGate(argv) {
  const [id, key, ...rest] = argv;
  const { root } = loadConfig(process.cwd());
  const answer = flag(rest, "--answer") ?? "";
  const decision = rest.includes("--auto") ? DECISION.approved : classifyAnswer(answer);

  if (decision === DECISION.notAYes) {
    out(JSON.stringify({ recorded: false, ...reAskFor(key) }, null, 2));
    return 2;
  }
  const claimed = (flag(rest, "--predicted") ?? "").split(",").map((path) => path.trim()).filter(Boolean);
  const conflicts = claimConflicts(root, { paths: claimed, forId: id });
  if (conflicts.length > 0) {
    process.stderr.write(`${describeConflicts(conflicts)}\n`);
    return 2;
  }
  return writeGate(root, { id, key, decision, answer, claimed, rest });
}

function writeGate(root, { id, key, decision, answer, claimed, rest }) {
  const by = rest.includes("--auto") ? "auto" : "user";
  const recorded = recordGate(readState(root, id), { key, decision, artifactPath: flag(rest, "--artifact"), answer, by });
  const next = claimed.length > 0 ? { ...recorded, predicted: claimed.map((path) => ({ path })) } : recorded;
  writeState(root, next);
  out(JSON.stringify({ recorded: true, gate: key, claimed: claimed.length, ...next.gates[key] }, null, 2));
  return 0;
}

/**
 * D72: the refusal belongs where the claim is made. Two overlapping claims that first
 * meet at write time block each other, which is a deadlock with two messages rather
 * than the clear conflict BMAD #2849 asks for.
 */
function describeConflicts(conflicts) {
  const rows = conflicts.map((row) => `  ${row.path} — claimed by work ${row.owner}`).join("\n");
  return `this plan claims paths another active work already claimed:\n${rows}\nFinish or park that work first. kiln will not split a file between two runs.`;
}

const MARK = { ok: " ok ", warn: "warn", fail: "FAIL" };

/**
 * Exits non-zero on a failure so a wrapper can gate on it. A warning is a thing to know,
 * not a thing to stop for.
 */
function runDoctor() {
  const loaded = loadConfig(process.cwd());
  const results = runChecks(loaded.root, loaded);
  for (const row of results) out(`  [${MARK[row.status]}] ${row.title}: ${row.detail}`);

  const worst = worstStatus(results);
  out(worst === STATUS.fail ? "\nSomething here would stop a run. Fix the FAIL lines." : "\nReady.");
  return worst === STATUS.fail ? 1 : 0;
}

function reportStep(entry) {
  if (entry.skipped) return out(`  skip  ${entry.id} — ${entry.skipped}`);
  return out(`  ${entry.exit === 0 ? "pass" : "FAIL"}  ${entry.id}  exit ${entry.exit}  ${entry.ms}ms`);
}

/**
 * The task-done shape: run the thing, read the real exit code, record what was
 * observed. A failing run records the failure and stops; it never records a pass.
 */
function runVerify(argv) {
  const [id, ...rest] = argv;
  const { root, config } = loadConfig(process.cwd());
  const phase = flag(rest, "--phase") ?? "full";
  const state = readState(root, id);
  const head = gitOutput(root, ["rev-parse", "HEAD"]) ?? state.base;
  const planned = planSteps(effectiveSteps(loadStack(config.stack.id), config), { phase, effects: effectsInPlay(rest) });

  const result = runPhase(planned, {
    cwd: root,
    cmd: config.stack.cmd,
    tmpDir: join(root, ".kiln", "tmp", id, "steps"),
    range: `${state.base}..${head}`,
  });
  return recordRun({ root, state, phase, head, result });
}

function effectsInPlay(rest) {
  return (flag(rest, "--effects") ?? "").split(",").map((effect) => effect.trim()).filter(Boolean);
}

function recordRun({ root, state, phase, head, result }) {
  // The raw output goes to a log file, never into state: a record you can grep for the
  // word "passed" is a record someone will eventually read for a verdict (D29).
  const stored = result.entries.map(({ output, ...entry }) => entry);
  let next = stored.reduce((acc, entry) => recordVerify(acc, entry), state);
  if (isGreen(result, phase)) next = recordFullVerified(next, head);
  writeState(root, next);

  result.entries.forEach(reportStep);
  if (!result.failed) {
    out(phase === "full" ? "green" : "fast pass — not green; the project's suite defines that");
    return 0;
  }
  process.stderr.write(`${result.failed.output}\n`);
  return 1;
}

function runBlast(argv) {
  const { root } = loadConfig(process.cwd());
  const rows = grepBlastRadius(root, argv);
  if (rows.length === 0) return out("No file mentions those terms.") ?? 0;
  for (const row of rows.slice(0, 20)) out(`  ${row.hits}\t${row.path}`);
  return 0;
}

function runScope(argv) {
  const { root } = loadConfig(process.cwd());
  const state = readState(root, argv[0]);
  const result = reconcile({
    predicted: state.predicted,
    actual: actualChanged(root, state.last_verified),
    dirtyAtOpen: state.dirty_at_open,
  });
  out(reconciliationLine(result));
  if (result.beyond.length > 0) out(`  beyond: ${result.beyond.slice(0, 8).join(" · ")}`);

  const verdict = reconcileVerdict(result);
  if (!verdict.halt) return 0;
  process.stderr.write(`HALT: ${verdict.reason}\n`);
  return 2;
}

/** Records the base it observed rather than being told one. */
function runOpen(argv) {
  const [id, ...rest] = argv;
  const { root } = loadConfig(process.cwd());
  const base = gitOutput(root, ["rev-parse", "HEAD"]);
  if (!base) {
    process.stderr.write("no commit to start from. Make one first — a run needs a base.\n");
    return 1;
  }
  const state = newWork({
    id,
    sessionId: flag(rest, "--session") ?? null,
    base,
    path: flag(rest, "--path") ?? "bounded",
    dirtyAtOpen: actualChanged(root, base),
  });
  out(writeState(root, state));
  return 0;
}

/**
 * Halts and records; it does not move a byte. A spike's source is uncommitted, so
 * deleting it would be D7 item 2 performed by kiln, and carrying it silently would
 * launder pre-plan code past a gate record for a different artifact (D78).
 */
function runRatchet(argv) {
  const [id, to] = argv;
  const { root } = loadConfig(process.cwd());
  const state = readState(root, id);
  if (!canRatchet(state.path, to)) {
    process.stderr.write(`${ratchetRefusal(state.path, to)}\n`);
    return 1;
  }
  // `git diff` shows tracked modifications only, and a spike's output is usually new
  // files. Reporting "clean" over an untracked probe is the one thing this must not do.
  const pending = gitOutput(root, ["status", "--short"]) ?? "";
  out(`ratcheting ${state.path} → ${to}. ${ceremonyFor(to).gates.length} gate(s) on the new path.`);
  out(pending.trim() === "" ? "Working tree is clean." : `Uncommitted work kiln will not touch:\n${pending}`);
  out("Anything you keep will surface at REVIEW as beyond prediction. That is the reconciliation working.");
  writeState(root, {
    ...state,
    path: to,
    gates: {},
    carry_over: [...state.carry_over, { from_pass: state.pass, kind: "ratchet", text: `${state.path} → ${to}` }],
  });
  return 0;
}

function runReport(argv) {
  const { root } = loadConfig(process.cwd());
  const state = readState(root, argv[0]);
  const auto = renderAutoRuled(state);
  out(`${state.id} · ${state.path} · ${state.status} · pass ${state.pass}`);
  out(auto ?? "No gate was ruled on your behalf.");
  return 0;
}

const COMMANDS = {
  init: runInit,
  open: runOpen,
  resolve: runResolve,
  list: runList,
  gate: runGate,
  ratchet: runRatchet,
  report: runReport,
  blast: runBlast,
  scope: runScope,
  verify: runVerify,
  doctor: runDoctor,
};

/**
 * kiln's own errors are answers to the user, so they print as a sentence. Anything
 * else is a bug in kiln, and a stack trace is the only useful thing to hand over.
 */
const EXPECTED = new Set(["ConfigError", "StateError", "StackError", "StepError", "ResolveError", "CeremonyError"]);

function reportFailure(error) {
  const named = error instanceof Error && EXPECTED.has(error.constructor.name);
  process.stderr.write(named ? `${error.message}\n` : `kiln failed unexpectedly. This is a bug in kiln.\n${error?.stack ?? error}\n`);
  return 1;
}

export function main(argv) {
  const [command, ...rest] = argv;
  const run = COMMANDS[command];
  if (!run) {
    out(USAGE);
    return command === undefined || command === "--help" ? 0 : 1;
  }
  try {
    return run(rest);
  } catch (error) {
    return reportFailure(error);
  }
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
