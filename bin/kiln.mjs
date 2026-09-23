#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync } from "node:fs";
import { configPath, integrationBranch, loadConfig } from "../lib/config.mjs";
import { STATUS, repairs, runChecks, worstStatus } from "../lib/doctor.mjs";
import { floorStatus, installFloor } from "../lib/floor.mjs";
import { renderShipPlan, shipPlan } from "../lib/ship.mjs";
import { applyInit, planInit, proposeConfig, stepsFor, unsatisfiedSteps } from "../lib/init.mjs";
import { actualChanged, anchorVerdict, grepBlastRadius, offBranchMessage, pathsOf, statusPaths, reconcile, reconciliationLine, reconcileVerdict } from "../lib/blast.mjs";
import { STAGES, addRoute, rulesReport } from "../lib/rules.mjs";
import { DEFAULT_TYPE, PATHS, TYPES, autoEligible, canRatchet, ceremonyFor, nextMove, ratchetRefusal, renderAutoRuled, taskPosition } from "../lib/ceremony.mjs";
import { activeWorks, claimConflicts } from "../lib/guards/context.mjs";
import { effectiveSteps, loadStack } from "../lib/stack.mjs";
import { isGreen, planSteps, ranSteps, runPhase } from "../lib/steps.mjs";
import { recordFullVerified, recordRules, recordVerify } from "../lib/state.mjs";
import { join } from "node:path";
import { DECISION, classifyAnswer, reAskFor } from "../lib/gate.mjs";
import { resolveArgument } from "../lib/resolve.mjs";
import { STATUS as WORK_STATUS, adoptSession, newWork, readState, recordGate, statePath, writeState } from "../lib/state.mjs";
import { gitOutput } from "../lib/init.mjs";
import { listWork } from "../lib/work.mjs";
import { protectedBranchesFor } from "../lib/modules.mjs";

const USAGE = `kiln — one unit of work to a reviewed pull request

  kiln init [--propose] [--set <key>=<value> ...]
      Detect the stack and write .kiln/. Overwrites nothing.
      --propose  print the proposed config and its questions; write nothing.
      --set      override one dotted key, e.g. --set stack.cmd.test="npm test".

  kiln config set <key>=<value> [<key>=<value> ...]
      Change a value after init. A change may tighten what is enforced or
      re-aim it, never loosen it.

  kiln resolve [<arg>]
      Decide what <arg> means - a URL, a work in progress, a ticket ref, or a
      description - and print the decision as JSON. Writes nothing.

  kiln open <id> [--session <session-id>] [--path bounded] [--type fix] [--auto]
      Create the work directory and record the commit it starts from.

  kiln gate <id> <key> --answer "<their words>" [--artifact <path>] [--auto]
      Classify what the user said, hash the artifact, and record what was observed.
      You supply only --answer; every other field is measured here.

  kiln doctor [--write]
      Check this project's setup and say what would stop a run.
      --write  repair what can be repaired without guessing.

  kiln verify <id> [--phase fast|full]
      Run the stack's steps for that phase, record every exit code, and stop at
      the first failure with the tool's own output.

  kiln blast <term> [<term> ...]
      Tier-0 blast radius: which files mention these terms.

  kiln rules add <file.md> --trigger "<glob>" [--text "<the rule>"]
      Write a project rule and route it. Adds only: it never rewrites or
      removes one, which is why a run may call it.

  kiln rules <id> [--stage plan|review] [--predicted <a,b,c>]
      Print the project rules routed to the files this stage names, and record
      which ones the run was handed. At --stage plan the files are the ones
      you pass: the approved claim does not exist until the gate.

  kiln scope <id>
      Reconcile what the plan predicted against what the diff actually touched.

  kiln halt <id> --reason "<why>"
      Stop this work and record why. Source edits block until it is resumed.

  kiln resume <id> --answer "<what you decided>"
      End a halt. The answer is recorded beside the question it answers.

  kiln ratchet <id> <spike|bounded|full>
      Move this work up a rung. Prints the uncommitted diff it found and stops;
      it never touches the working tree.

  kiln ship <id>
      Group this work's diff by repository and print what has to be opened:
      one pull request per repository, all carrying the work id as their topic.

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

/**
 * A value takes the shape already at its key, because the schema is what declares the
 * shape and a flag only supplies the contents.
 *
 * Splitting on a comma instead meant one branch was not a list: `--set
 * vcs.protected=v3-master` stored the string, `protectedBranchesFor` spread it into
 * ["v","3","-","m",…], and a push to v3-master was ALLOWED — D7 item 1, through the
 * documented flag. Booleans went the same way, which is why `--set auto.bounded=true`
 * stored "true" and could never have switched auto on.
 */
function shapedLike(current, raw) {
  if (Array.isArray(current)) return raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (typeof current === "boolean") return raw === "true";
  if (typeof current === "number") return Number(raw);
  return raw.includes(",") ? raw.split(",").map((part) => part.trim()) : raw;
}

/**
 * A value the caller wrote as JSON is taken as JSON. Inferring the shape from the value
 * already there is right for a scalar and wrong for a structure: `--set stack.steps=[{...},
 * {...}]` was split on its commas into a string array, and kiln wrote a corrupt
 * .kiln/config.json into a real project. The repair took `node -e`, which is a direct write
 * to the one file D48 says the agent may not write.
 *
 * `git config` settles this by never guessing: --type is declared or no canonicalization
 * happens, and a multi-valued key is built with --add rather than by splitting a string.
 *
 * Opening with `[` or `{` is the declaration here. A value that opens that way and does not
 * parse is refused, because falling back to the comma split is how the corrupt file was
 * written in the first place.
 */
function structuredValue(raw) {
  const text = raw.trim();
  if (!text.startsWith("[") && !text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not a structure");
    return parsed;
  } catch (error) {
    throw new Error(`the value for this key starts with "${text[0]}", so kiln read it as JSON, and it does not parse: ${error.message}`);
  }
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
  node[leaf] = structuredValue(raw) ?? shapedLike(node[leaf], raw);
  return target;
}

/**
 * `steps` is derived from `cmd`, and D86 has init write only the steps it can satisfy —
 * but the derivation ran inside `proposeConfig`, against the commands *detection* found,
 * before `--set` was read. So a project whose commands kiln cannot detect (`make test`,
 * a migrate endpoint) got them recorded under `cmd` and `"steps": []` beside them, which
 * is the config a real setup run produced and `kiln verify` then reported green over.
 *
 * Re-deriving only when the answer is still empty keeps a hand-written `--set
 * stack.steps=...` authoritative.
 */
function applyOverrides(config, argv) {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === "--set") setPath(config, argv[i + 1]);
  }
  if (config.stack.steps.length === 0) config.stack.steps = stepsFor(config.stack.cmd, stackOrNull(config.stack.id));
  return config;
}

/** `--set stack.id=` may name a stack that does not exist; that is doctor's finding to report. */
function stackOrNull(id) {
  try {
    return loadStack(id);
  } catch {
    return null;
  }
}

/** An ambiguity the user cannot see is one they cannot correct. */
/** `--set` on a project init will not overwrite was read and dropped, silently. */
function refuseLateSet() {
  process.stderr.write("this project already has a .kiln/config.json, and init overwrites nothing — so --set would be read and dropped.\nUse `kiln config set <key>=<value>` to change a value.\n");
  return 1;
}

function reportDetection(stack) {
  out(`stack: ${stack.id}${stack.evidence ? ` (${stack.evidence})` : ""}`);
  if (stack.alternatives?.length > 0) {
    out(`  this checkout also looks like: ${stack.alternatives.join(", ")} — set stack.id if that is the one to verify`);
  }
}

/**
 * A question kiln prepared and nobody answered became a value nobody chose, silently. It is
 * named here so a person running the CLI directly sees what was decided for them, and so an
 * agent that skipped `--propose` still leaves the user something to correct.
 *
 * Only on a first init. Run again on a configured project, it described a **proposal** —
 * defaults kiln would have used — while the file on disk held something else entirely.
 */
function reportUnasked(questions, argv) {
  const answered = new Set(argv.filter((_, index) => argv[index - 1] === "--set").map((pair) => pair.split("=")[0]));
  const open = questions.filter((question) => !answered.has(question.key));
  if (open.length === 0) return;
  out("\nkiln decided these for you. `--set <key>=<value>` to change one:");
  for (const question of open) out(`  ${question.key} = ${JSON.stringify(question.default)}   ${question.ask}`);
}

function reportInit(result) {
  for (const path of result.kept) out(`  kept    ${path}`);
  for (const path of result.written) out(`  wrote   ${path}`);
}

/**
 * Last, after everything that was written and everything that was decided. It used to sit
 * inside `reportInit`, which printed it before the floor and before the questions kiln had
 * answered on the user's behalf — a closing line in the middle closes nothing.
 *
 * And it names the entry point, because `/kiln:kiln "<sentence>"` is not guessable from a
 * command called `init`. That is the one line `git init` and `cargo new` do not need and a
 * scaffolder does. `--auto` is deliberately absent: `kiln open` already names it at the
 * moment it means something, and the first ten minutes should not teach the way past a gate
 * before the user has met one.
 */
function reportNext(wrote) {
  const start = '/kiln:kiln "<what you want done>"';
  out(wrote
    ? `\nNext: ${start}   ·   kiln doctor to check this setup`
    : `\nAlready set up. ${start} to start, or kiln doctor to check it.`);
}

/**
 * A project kiln cannot identify is a supported starting point — `stack.id` is `unknown`
 * and the user sets it. Loading that stack threw, so `kiln init` ended in a StackError and
 * exit 1 on exactly the projects that most needed it to finish. Naming the gap is doctor's
 * job either way.
 */
function warnUnsatisfied(config) {
  const stack = stackOrNull(config.stack.id);
  if (!stack) return 0;
  const gaps = unsatisfiedSteps({ steps: effectiveSteps(stack, config) }, config.stack.cmd);
  for (const gap of gaps) {
    process.stderr.write(`note: step "${gap.step}" needs stack.cmd.${gap.key}, which is not set. It will refuse to run until you set it, or remove the step.\n`);
  }
  return 0;
}

function runInit(argv) {
  const root = process.cwd();
  // `kiln init --help` wrote a whole .kiln/ into whatever directory it was run from —
  // on the first real setup, the plugin's own cache. A flag asking what a command does
  // must not be the command doing it.
  if (argv.includes("--help")) {
    out(USAGE);
    return 0;
  }
  const configured = existsSync(configPath(root));
  if (configured && argv.includes("--set")) return refuseLateSet();

  const { config, questions, detected } = proposeConfig(root);
  if (argv.includes("--propose")) {
    out(JSON.stringify({ config, questions, detected }, null, 2));
    return 0;
  }
  reportDetection(detected.stack);
  out(`integration branch: ${integrationBranch(detected)}`);
  out(`${planInit(root).missing.length} file(s) to write`);
  return writeInit(root, { config, questions, argv, configured });
}

function writeInit(root, { config, questions, argv, configured }) {
  const final = applyOverrides(config, argv);
  const result = applyInit(root, final);
  reportInit(result);
  for (const path of installFloor(root)) out(`  wrote   ${path}`);
  if (!configured) reportUnasked(questions, argv);
  const code = warnUnsatisfied(final);
  reportNext(result.written.length > 0);
  return code;
}

/**
 * D48 keeps `.kiln/config.json` out of the agent's reach, because it holds the terms the
 * run is judged by. Which left no way to change a value after `init`: the guard refuses the
 * edit, `init` overwrites nothing, and there was no verb — so a user who said "the
 * integration branch is v3-master" was told to edit JSON by hand. That happened three times.
 *
 * The resolution is #68's, applied to a durable change instead of a per-run one: the
 * authorization is in the user's own words, and what matters is the **direction**. A change
 * may tighten enforcement or re-aim it. It may never loosen it, and it may never hand the
 * gates to auto mode — which is the one thing the harness itself refuses by name, as
 * `[Self-Modification]`.
 *
 * `kiln config set <key>=<value>` is the shape `git config`, `npm config set` and
 * `gh config set` already taught everyone.
 */
const LOOSENS = "vcs.protected";

function configRefusal({ before, after, keys }) {
  if (keys.some((key) => key.startsWith("auto."))) {
    return "auto mode rules gates on your behalf, so it stays your own edit — add `--auto` to a request instead, or set it in the file yourself.";
  }
  const lost = protectedBranchesFor(before).filter((branch) => !protectedBranchesFor(after).includes(branch));
  return lost.length > 0
    ? `this would stop protecting ${lost.join(", ")}. A config change may tighten what is enforced or re-aim it, never loosen it — edit ${LOOSENS} yourself if you mean to.`
    : null;
}

function runConfig(argv) {
  const [verb, ...assignments] = argv;
  const { root, config } = loadConfig(process.cwd());
  if (verb !== "set" || assignments.length === 0) {
    process.stderr.write("usage: kiln config set <key>=<value> [<key>=<value> ...]\n");
    return 1;
  }
  const next = assignments.reduce((draft, assignment) => setPath(draft, assignment), JSON.parse(JSON.stringify(config)));
  const keys = assignments.map((pair) => pair.split("=")[0]);
  const refusal = configRefusal({ before: config, after: next, keys });
  if (refusal) {
    process.stderr.write(`kiln refused that config change: ${refusal}\n`);
    return 2;
  }
  writeFileSync(configPath(root), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  for (const key of keys) out(`  ${key}: ${JSON.stringify(valueAt(config, key))} → ${JSON.stringify(valueAt(next, key))}`);
  out("Run `kiln doctor` to check it.");
  return 0;
}

function valueAt(config, key) {
  return key.split(".").reduce((node, part) => (node === undefined || node === null ? undefined : node[part]), config);
}

function runResolve(argv) {
  const { root, config } = loadConfig(process.cwd());
  out(JSON.stringify(resolveArgument({ arg: argv[0], root, config }), null, 2));
  return 0;
}

const LIST_HEADER = ["ID", "STATUS", "STAGE", "PASS"];

/** An unreadable state reports `pass` as "-", so every cell is taken as text. */
function alignRows(rows) {
  const widths = LIST_HEADER.map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const pad = (cell, column) => (column === LIST_HEADER.length - 1 ? cell : cell.padEnd(widths[column]));
  return rows.map((row) => `  ${row.map(pad).join("  ")}`);
}

function runList() {
  const { root } = loadConfig(process.cwd());
  const rows = listWork(root);
  if (rows.length === 0) return out("No work in progress.") ?? 0;

  const cells = rows.map((row) => [row.id, row.status, row.stage, String(row.pass)]);
  for (const line of alignRows([LIST_HEADER, ...cells])) out(line);
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
/**
 * `--auto` used to mean "record approved, no questions asked", and the rule saying when
 * that is allowed lived in `autoEligible` with no caller outside the tests. A flag that
 * approves on request is not auto mode; it is a way past the gate. So the rule is asked
 * here, where the record is written, and the caller cannot skip it.
 */
function autoRefusal(root, { id, config }) {
  const state = readState(root, id);
  if (state.status === WORK_STATUS.halted) return `this work is halted — auto mode does not rule past a halt`;
  const verdict = autoEligible(state.path, { config, state });
  return verdict.eligible ? null : verdict.reason;
}

const AUTO_ANSWER = "ruled by auto mode, not by the user";

function runGate(argv) {
  const [id, key, ...rest] = argv;
  const { root, config } = loadConfig(process.cwd());
  const auto = rest.includes("--auto");
  const refusal = auto ? autoRefusal(root, { id, config }) : null;
  if (refusal) return refuseAuto(key, refusal);
  const answer = auto ? AUTO_ANSWER : flag(rest, "--answer") ?? "";
  const decision = auto ? DECISION.approved : classifyAnswer(answer);

  if (decision === DECISION.notAYes) {
    out(JSON.stringify({ recorded: false, ...reAskFor(key) }, null, 2));
    return 2;
  }
  const claimed = claimedPaths(rest);
  const conflicts = claimConflicts(root, { paths: claimed, forId: id });
  if (conflicts.length > 0) {
    process.stderr.write(`${describeConflicts(conflicts)}\n`);
    return 2;
  }
  return writeGate(root, { id, key, decision, answer, claimed, rest });
}

function refuseAuto(key, refusal) {
  process.stderr.write(`kiln refused an auto ruling on the ${key} gate: ${refusal}.\nAsk the user.\n`);
  return 2;
}

/**
 * Recording a gate is the evidence its stage finished, so the stage moves with it.
 * Nothing else writes `stage`, which is why the first real run ended at INVESTIGATE
 * having gone all the way to a merge request — and would have resumed from the start.
 */
const STAGE_AFTER = { probe: "IMPLEMENT", spec: "PLAN", plan: "IMPLEMENT", review: "VERIFY", ship: "SHIP" };

function writeGate(root, { id, key, decision, answer, claimed, rest }) {
  const by = rest.includes("--auto") ? "auto" : "user";
  const opened = recordGate(readState(root, id), { key, decision, artifactPath: flag(rest, "--artifact"), answer, by });
  const recorded = decision === "approved" ? { ...opened, stage: STAGE_AFTER[key] ?? opened.stage } : opened;
  // Re-approving without --predicted keeps the claim set rather than clearing it, so
  // the count reported is what the work now claims, not what this call passed in.
  const next = claimed.length > 0 ? { ...recorded, predicted: claimed.map((path) => ({ path })) } : recorded;
  writeState(root, next);
  out(JSON.stringify({ recorded: true, gate: key, claimed: next.predicted.length, ...next.gates[key] }, null, 2));
  // A rejection is evidence and is kept, but it is not a gate that opened. Exit 0 made it
  // indistinguishable from an approval to anything reading the status — and since every
  // menu now ends in "Stop here", this is the common way a user says no.
  return decision === DECISION.approved ? 0 : 2;
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

/** Writes config, which no tool may edit — so kiln's own code is the only writer (D48). */
function applyRepairs({ root, config }) {
  const installed = installFloor(root);
  for (const path of installed) out(`repaired: installed ${path}`);
  const repair = repairs(config);
  if (!repair) return out(installed.length > 0 ? "Done." : "Nothing to repair.") ?? 0;
  writeFileSync(configPath(root), `${JSON.stringify(repair.config, null, 2)}\n`, "utf8");
  out(`repaired: ${repair.what}`);
  return 0;
}

/**
 * Exits non-zero on a failure so a wrapper can gate on it. A warning is a thing to know,
 * not a thing to stop for.
 */
/**
 * "Ready." over a warning is right for most warnings — a rule budget, a map nobody reads.
 * It was wrong for one: a missing push floor means D7 item 1 has lost a whole layer, and on
 * a husky project that was the state of every run while the last line said Ready.
 */
function summaryFor(worst, results) {
  if (worst === STATUS.fail) return "Something here would stop a run. Fix the FAIL lines.";
  const warnings = results.filter((row) => row.status === STATUS.warn);
  if (warnings.length === 0) return "Ready.";
  return `Ready, with ${warnings.length} warning(s): ${warnings.map((row) => row.title).join(", ")}.`;
}

function runDoctor(argv) {
  const loaded = loadConfig(process.cwd());
  if (argv.includes("--write")) return applyRepairs(loaded);
  const results = runChecks(loaded.root, loaded);
  for (const row of results) out(`  [${MARK[row.status]}] ${row.title}: ${row.detail}`);

  const worst = worstStatus(results);
  out(`\n${summaryFor(worst, results)}`);
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
  const step = taskPosition(flag(rest, "--task"));
  const head = gitOutput(root, ["rev-parse", "HEAD"]) ?? state.base;
  const planned = planSteps(effectiveSteps(loadStack(config.stack.id), config), { phase, effects: effectsInPlay(rest) });
  if (planned.length === 0) return refuseEmptyPhase(config, { phase, step });

  const result = runPhase(planned, {
    cwd: root,
    cmd: config.stack.cmd,
    tmpDir: join(root, ".kiln", "tmp", id, "steps"),
    range: `${state.base}..${head}`,
  });
  return recordRun({ root, state: { ...state, step }, phase, head, result });
}

/** The refusal still says what comes next: a phase kiln cannot run is not a reason to stop. */
function refuseEmptyPhase(config, { phase, step }) {
  process.stderr.write(`${noStepsMessage(config, phase)}\n`);
  if (step) process.stderr.write(`${nextMove(step)}\n`);
  return 1;
}

/**
 * A step whose `${cmd.x}` is unset refuses to run rather than skipping quietly (D60.1).
 * No steps at all is the same law one level up: it printed `green`, exit 0, on a real
 * project whose config had `"steps": []` — a pass nobody earned and nobody could see was
 * empty.
 */
/**
 * Every step skipped is the same emptiness as no steps at all, and it reads as success
 * unless it is said out loud. The reasons are printed because the fix is in them: a
 * `requires` nothing satisfies is either a missing `--effects` or a preset that chained a
 * step behind an effect it should only have been ordered after.
 */
function nothingRanMessage(result) {
  const reasons = result.entries.map((entry) => `  ${entry.id} — ${entry.skipped}`);
  return `kiln will not call this green: every step was skipped, so nothing verified anything.
${reasons.join("\n")}
Declare the effect this change produces with --effects, or fix the step's \`requires\` if it is ordering rather than a precondition.`;
}

/**
 * The message claimed `"steps" is empty` for a config holding one step in another phase,
 * and sent the reader to `kiln init` "in a project kiln has not configured yet" — on a
 * project that was already configured, by init, minutes earlier. Both halves were false,
 * which is the shape this project keeps re-meeting: a message naming a remedy that does
 * not exist.
 *
 * What is true is the phase, so the phase is what it reports, with the steps that do exist
 * listed beside it.
 */
function noStepsMessage(config, phase) {
  const steps = config.stack.steps ?? [];
  const elsewhere = steps.map((step) => `  ${step.id} — phase ${step.phase ?? "full"}`);
  const inventory = steps.length === 0
    ? 'stack.steps is empty, so no phase has anything to run.'
    : `stack.steps holds ${steps.length}, none of them ${phase}:\n${elsewhere.join("\n")}`;

  return `kiln will not report a result for a phase with no steps.
stack "${config.stack.id}" has no ${phase} step in .kiln/config.json.
${inventory}
${remedyFor(phase)}`;
}

/**
 * Only a remedy that works from here. `kiln config set` is the verb that changes a written
 * config; `kiln init` is not, and it overwrites nothing.
 */
function remedyFor(phase) {
  return phase === "fast"
    ? 'Set the command it runs: `kiln config set stack.cmd.test_fast="<command>"` — or verify with --phase full, which is the phase that decides green.'
    : 'Set the steps: `kiln config set \'stack.steps=[{"id":"unit","run":"${cmd.test}"}]\'`.';
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
  if (!result.failed && ranSteps(result).length === 0) {
    process.stderr.write(`${nothingRanMessage(result)}\n`);
    return 1;
  }
  if (!result.failed) {
    out(phase === "full" ? "green" : "fast pass — not green; the project's suite defines that");
    // The turn after a task ends where the agent last read an instruction. Prose in a skill
    // loaded five hours ago is not that place; the output of the call it just made is.
    if (state.step) out(nextMove(state.step));
    return 0;
  }
  process.stderr.write(`${result.failed.output}\n`);
  return 1;
}

const BLAST_ROW_LIMIT = 20;

function runBlast(argv) {
  const { root } = loadConfig(process.cwd());
  const rows = grepBlastRadius(root, argv);
  if (rows.length === 0) return out("No file mentions those terms.") ?? 0;

  for (const row of rows.slice(0, BLAST_ROW_LIMIT)) out(`  ${row.hits}\t${row.path}`);
  // No tab in the notice: a caller splitting this output into paths must not pick it up
  // as one. It counts files rather than hits, because `hits` counts matched terms.
  if (rows.length > BLAST_ROW_LIMIT) {
    out(`  … ${rows.length - BLAST_ROW_LIMIT} more of ${rows.length} files not shown — narrow the terms.`);
  }
  return 0;
}

function runScope(argv) {
  const { root } = loadConfig(process.cwd());
  const state = readState(root, argv[0]);
  const anchor = anchorVerdict(root, state.last_verified);
  if (!anchor.ok) {
    process.stderr.write(`${offBranchMessage(state.id, { base: state.last_verified, reason: anchor.reason })}\n`);
    return 1;
  }
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

/**
 * The stage decides which files the rules are matched against, and the two are genuinely
 * different questions. At `plan` they meet the change preview, so a rule shapes the plan
 * instead of being remembered after it. At `review` they meet the diff that actually
 * happened — which is how a rule reaches a file the plan never predicted, the case a router
 * that only sees what is already in context cannot cover.
 */
/** One spelling of `--predicted`, shared by the gate that claims them and the router that reads them. */
function claimedPaths(argv) {
  return (flag(argv, "--predicted") ?? "").split(",").map((path) => path.trim()).filter(Boolean);
}

/**
 * At PLAN the paths come from the caller, because `state.predicted` does not exist yet.
 *
 * D31 puts the claim at the gate on purpose — `predicted[]` is the *approved* preview, and
 * D72 registers cross-work claims from it. So the plan-stage router was reading a field that
 * is empty until after the gate it was supposed to inform, and every real run got "The plan
 * names no files yet". Measured on the owner's run, where the agent diagnosed it itself and
 * then matched the rules by hand — routing around the verb, which is D112 a third time.
 *
 * Passing the paths in is a read, not a claim: the agent wrote the plan, so it knows which
 * files the preview names. The claim still happens at the gate, where approval is.
 */
function stagePaths(root, { state, stage, predicted }) {
  if (stage === "plan") return predicted.length > 0 ? predicted : pathsOf(state.predicted);
  const anchor = anchorVerdict(root, state.last_verified);
  if (anchor.ok) return actualChanged(root, state.last_verified);
  process.stderr.write(`${offBranchMessage(state.id, { base: state.last_verified, reason: anchor.reason })}\n`);
  return null;
}

/**
 * D48 answered "the agent may not write this file" with a verb, and after D102 a project rule
 * is in the same position. Hand-editing a markdown table is where every comparable tool
 * breaks — Cursor's most-reported rules failure is a malformed file skipped in silence, and
 * Cursor answers it with a command rather than with documentation.
 *
 * Add-only, which is what keeps D102 intact: an agent can capture a decision as a rule, and
 * cannot weaken or delete one.
 */
function runRulesAdd(argv) {
  const [file, ...rest] = argv;
  const { root, config } = loadConfig(process.cwd());
  const added = addRoute(root, { file, trigger: flag(rest, "--trigger"), text: flag(rest, "--text"), budget: config.rules.budget_lines });
  for (const line of added) {
    out(`  ${line}`);
  }
  out("");
  for (const row of runChecks(root, loadConfig(root)).filter((check) => check.title.startsWith("rules"))) {
    out(`  [${MARK[row.status]}] ${row.title}: ${row.detail}`);
  }
  return 0;
}

const RULES_USAGE = `kiln rules — the project's own rules, routed by path glob

  kiln rules add <file>.md --trigger "<glob>" [--text "<the rule>"]
      Write a rule and route it. Adds only; it never rewrites or removes one.

  kiln rules <id> [--stage plan|review]
      Print the rules routed to the files that stage names.

In a session you do not type either: say what the rule is, and the orchestrator
calls the first one for you.`;

function runRules(argv) {
  if (argv.length === 0) return out(RULES_USAGE) ?? 0;
  if (argv[0] === "add") return runRulesAdd(argv.slice(1));
  const [id, ...rest] = argv;
  const stage = flag(rest, "--stage") ?? "plan";
  if (!STAGES.includes(stage)) {
    process.stderr.write(`"${stage}" is not a stage kiln routes rules for. Use one of: ${STAGES.join(", ")}.\n`);
    return 1;
  }
  const { root } = loadConfig(process.cwd());
  const state = readState(root, id);
  const paths = stagePaths(root, { state, stage, predicted: claimedPaths(rest) });
  if (paths === null) return 1;

  const report = rulesReport({ root, stage, id: state.id, paths });
  out(report.text);
  writeState(root, recordRules(state, { stage, files: report.files }));
  return 0;
}

/**
 * Opening a work that already exists is a handover, not a mistake: this session takes
 * over, and says so. The session it replaced is recorded, so its next guarded write is
 * blocked rather than allowed by a guard that could not tell it had been replaced.
 */
/**
 * Claiming an unowned work and taking one from a live session are different events, and
 * saying the second when the first happened is a false alarm: "took over work X from
 * session none. The previous session's next source edit will be blocked" warned a user
 * about a session that did not exist.
 */
/**
 * `open` on a work that exists, with no `--session`, is not a takeover — there is nobody to
 * hand it to. It used to adopt `undefined` anyway: the owner was wiped, pushed into
 * `displaced`, and its very next source edit was refused. Measured, and it happened twice
 * in one real run because the skill re-opens a work to change its path.
 */
function adoptionLine(id, { before, now }) {
  if (before === now) return `work ${id} is already yours. Nothing changed.`;
  return before
    ? `took over work ${id} from session ${before}. That session's next source edit will be blocked.`
    : `claimed work ${id}, which had no session. Nothing was taken from anyone.`;
}

function adoptExisting(root, { id, sessionId, base }) {
  const before = readState(root, id);
  if (base) return reanchor(root, { state: before, base });
  if (!sessionId) {
    out(before.session_id
      ? `work ${id} already exists and is driven by session ${before.session_id}. Nothing changed.`
      : `work ${id} already exists and has no session yet. Nothing changed.`);
    return 0;
  }
  writeState(root, adoptSession(before, sessionId));
  out(adoptionLine(id, { before: before.session_id, now: sessionId }));
  return 0;
}

/**
 * Re-anchoring shrinks what every count afterwards measures, which is why it is typed by a
 * person and written into `carry_over` where `kiln report` shows it. A work whose base the
 * branch never grew from reports a number belonging to someone else's ticket; a work whose
 * base was quietly moved forward reports a number belonging to nobody. The second is worse,
 * so the move is on the record.
 */
function reanchor(root, { state, base }) {
  const commit = gitOutput(root, ["rev-parse", `${base}^{commit}`]);
  if (!commit) {
    process.stderr.write(`"${base}" does not name a commit in this checkout.\n`);
    return 1;
  }
  const moved = {
    ...state,
    base: commit,
    last_verified: commit,
    carry_over: [...state.carry_over, { from_pass: state.pass, kind: "reanchor", text: `${String(state.base).slice(0, 9)} → ${commit.slice(0, 9)}` }],
  };
  out(writeState(root, moved));
  out(`base moved to ${commit.slice(0, 9)}. Every scope and ship count from here measures from there, and \`kiln report\` says so.`);
  return 0;
}

/** Records the base it observed rather than being told one. */
/**
 * A session drives one unit of work. With two, `workForSession` returns whichever the
 * filesystem lists first — so which work's gates authorise an edit becomes arbitrary, and
 * `claimOwner` checks the wrong claim set. Measured: two works shared one session and the
 * guard picked by directory order.
 *
 * `claimUnbound` already refuses to guess when two works are unowned. This is the same law
 * from the other side, and it is refused here rather than at the first edit, where the
 * answer would arrive after the work had started.
 */
function alreadyDriving(root, { id, sessionId }) {
  if (!sessionId) return null;
  // Only a running work drives the session. A halted one is parked, which is what the
  // refusal tells you to do — a remedy that did not release the session would be the
  // deadlock shape again, with the way out named and shut.
  const other = activeWorks(root)
    .filter((state) => state.status === WORK_STATUS.inProgress)
    .find((state) => state.session_id === sessionId && state.id !== id);
  return other
    ? `this session already drives work ${other.id}. A session drives one unit of work, or kiln cannot tell which gate authorises an edit.
Finish it, or park it with \`kiln halt ${other.id} --reason "<why>"\`.`
    : null;
}

function refuseOpen(reason) {
  process.stderr.write(`${reason}\n`);
  return 1;
}

function openRefusal(root, { id, rest }) {
  const taken = alreadyDriving(root, { id, sessionId: flag(rest, "--session") });
  if (taken) return taken;
  const path = flag(rest, "--path") ?? "bounded";
  if (!PATHS.includes(path)) return `no ceremony path named "${path}". One of: ${PATHS.join(", ")}.`;
  const type = flag(rest, "--type") ?? DEFAULT_TYPE;
  if (!TYPES.includes(type)) return `"${type}" is not a change type. One of: ${TYPES.join(", ")}.`;
  return gitOutput(root, ["rev-parse", "HEAD"]) ? null : "no commit to start from. Make one first — a run needs a base.";
}

function runOpen(argv) {
  const [id, ...rest] = argv;
  const { root, config } = loadConfig(process.cwd());
  const refusal = openRefusal(root, { id, rest });
  if (refusal) return refuseOpen(refusal);
  if (existsSync(statePath(root, id))) {
    return adoptExisting(root, { id, sessionId: flag(rest, "--session"), base: flag(rest, "--base") });
  }

  const state = newWork(openedAt(root, { id, rest }));
  out(writeState(root, state));
  const floor = floorWarning(root);
  if (floor) process.stderr.write(`${floor}\n`);
  out(autoLine(state.path, { config, state }));
  return 0;
}

/**
 * `/plugin update kiln` replaces the plugin and touches nothing in the project, so a
 * checkout that already had the floor keeps the hook the older version wrote. `kiln doctor`
 * reports that as `stale` — but only if somebody runs doctor, and the one instruction kiln
 * gives about updating said `/plugin update kiln`. That is all.
 *
 * Measured on a real monorepo after rc.19: five checkouts all reporting `stale`, having run
 * the whole of rc.18 with the submodule bug rc.19 fixed. The floor was degraded and every
 * run said `Ready.`
 *
 * Said at `open` because it is once per run, it is the moment the run's safety is being
 * established, and it costs two git calls per checkout rather than one per tool call. It
 * warns rather than blocks: an absent floor is what D54 calls a thing nothing at runtime
 * can notice, and refusing to start work over it would be kiln policing its own upgrade.
 */
function floorWarning(root) {
  const broken = floorStatus(root).filter((row) => row.state === "stale" || row.state === "missing" || row.state === "no-runner");
  if (broken.length === 0) return null;
  return `kiln: the push floor is not armed in ${broken.length} checkout(s) — ${broken.map((row) => row.state).join(", ")}.
Run \`kiln doctor --write\` to install it. Until then D7 item 1 rests on the PreToolUse guard alone.`;
}

function openedAt(root, { id, rest }) {
  const head = gitOutput(root, ["rev-parse", "HEAD"]);
  return {
    id,
    sessionId: flag(rest, "--session") ?? null,
    base: head,
    path: flag(rest, "--path") ?? "bounded",
    type: flag(rest, "--type") ?? DEFAULT_TYPE,
    auto: rest.includes("--auto"),
    dirtyAtOpen: actualChanged(root, head),
  };
}

/**
 * The path is chosen here, and whether kiln will rule a gate on the user's behalf follows
 * from it. Said at `open` because that is the moment the answer becomes knowable, and
 * because a run that decides for someone without telling them first is the failure the
 * gates exist to prevent.
 */
function autoLine(path, { config, state }) {
  const verdict = autoEligible(path, { config, state });
  return verdict.eligible
    ? `auto mode is ON for ${path} (${verdict.from}): kiln will rule its gates and say so in \`kiln report\`.`
    : `auto mode is off for ${path} (${verdict.reason}) — every gate stops for you.`;
}

/**
 * Halts and records; it does not move a byte. A spike's source is uncommitted, so
 * deleting it would be D7 item 2 performed by kiln, and carrying it silently would
 * launder pre-plan code past a gate record for a different artifact (D78).
 */
/** Nothing to launder past a gate: no gate, and no change attributable to this work. */
function nothingRecorded(root, state) {
  return Object.keys(state.gates ?? {}).length === 0 && actualChanged(root, state.base).length === 0;
}

function runRatchet(argv) {
  const [id, to] = argv;
  const { root } = loadConfig(process.cwd());
  const state = readState(root, id);
  if (!canRatchet(state.path, { to, untouched: nothingRecorded(root, state) })) {
    process.stderr.write(`${ratchetRefusal(state.path, to)}\n`);
    return 1;
  }
  // `git diff` shows tracked modifications only, and a spike's output is usually new
  // files. Reporting "clean" over an untracked probe is the one thing this must not do —
  // and a submodule collapses to its own directory name unless statusPaths expands it.
  const pending = statusPaths(root);
  out(`ratcheting ${state.path} → ${to}. ${ceremonyFor(to).gates.length} gate(s) on the new path.`);
  out(pending.length === 0 ? "Working tree is clean." : `Uncommitted work kiln will not touch:\n${pending.join("\n")}`);
  out("Anything you keep will surface at REVIEW as beyond prediction. That is the reconciliation working.");
  writeState(root, {
    ...state,
    path: to,
    gates: {},
    carry_over: [...state.carry_over, { from_pass: state.pass, kind: "ratchet", text: `${state.path} → ${to}` }],
  });
  return 0;
}

/**
 * `resolve` branches on `halted` and `guard-gate` blocks on it, and until now nothing
 * could set it — a state two components read and none could write. A halt is a thing
 * that happened, so recording it is the side effect of stopping (D65).
 */
function runHalt(argv) {
  const [id, ...rest] = argv;
  const { root } = loadConfig(process.cwd());
  const reason = flag(rest, "--reason") ?? "";
  if (!reason) {
    process.stderr.write("a halt without a reason is a stop nobody can act on. Pass --reason.\n");
    return 1;
  }
  const state = readState(root, id);
  writeState(root, {
    ...state,
    status: WORK_STATUS.halted,
    carry_over: [...state.carry_over, { from_pass: state.pass, kind: flag(rest, "--kind") ?? "halt", text: reason }],
  });
  out(`halted ${id}: ${reason}\nSource edits are blocked until \`kiln resume ${id} --answer "<what you decided>"\`.`);
  return 0;
}

/**
 * A halt is a question, and a question needs an answer to end. `kiln halt` said "blocked
 * until this is resumed" and nothing could resume it: `resolve` presents a halt, it does
 * not clear one, and only a ship opened the next pass. So a work whose blocking unknown the
 * user had answered stayed blocked for good — the third time this session a message named a
 * remedy that did not exist.
 *
 * The answer is recorded beside the halt it answers, because a halt resolved without a
 * written reason is a stop nobody can audit, which is the same argument `--reason` won.
 */
function resumeRefusal(id, { answer, state }) {
  if (!answer) return 'a halt is a question. Say what was decided: --answer "<what you decided>".';
  return state.status === WORK_STATUS.halted ? null : `work ${id} is ${state.status}, not halted. Nothing to resume.`;
}

function runResume(argv) {
  const [id, ...rest] = argv;
  const { root } = loadConfig(process.cwd());
  const answer = flag(rest, "--answer") ?? "";
  const state = answer ? readState(root, id) : null;
  const refusal = resumeRefusal(id, { answer, state });
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    return 1;
  }
  writeState(root, {
    ...state,
    status: WORK_STATUS.inProgress,
    carry_over: [...state.carry_over, { from_pass: state.pass, kind: "resume", text: answer }],
  });
  out(`resumed ${id} at ${state.stage}: ${answer}`);
  return 0;
}

/** Prints; writes nothing. What the run has to open, and what kiln cannot promise about it. */
function runShip(argv) {
  const { root, config } = loadConfig(process.cwd());
  const state = readState(root, argv[0]);
  out(renderShipPlan(shipPlan(root, { config, state }), config.vcs.branch_pattern));
  return 0;
}

/**
 * A work can ship having verified nothing — the user says "no need to run the suite" and
 * the gate records their words, which is their call to make. What is not their call is
 * finding out later. `verify: []` said nothing here, so the only account of it was
 * whatever the agent chose to mention.
 */
function verifiedLine(state) {
  const ran = (state.verify ?? []).filter((entry) => !entry.skipped);
  if (ran.length === 0) return "Verified: never — no step has run for this work.";
  // Greenness is in the entries. Inferring it from `last_verified !== base` said "not
  // green" after a run that was green, because the two are equal until something is
  // committed — and verifying before committing is the ordinary case.
  const green = ran.every((entry) => entry.exit === 0);
  return `Verified: ${ran.length} step(s) ran${green ? ` · green at ${String(state.last_verified).slice(0, 9)}` : " · not green"}.`;
}

function runReport(argv) {
  const { root } = loadConfig(process.cwd());
  const state = readState(root, argv[0]);
  out(`${state.id} · ${state.path} · ${state.status} · pass ${state.pass}`);
  out(verifiedLine(state));
  out(renderAutoRuled(state) ?? "No gate was ruled on your behalf.");
  return 0;
}

const COMMANDS = {
  init: runInit,
  open: runOpen,
  config: runConfig,
  resolve: runResolve,
  list: runList,
  gate: runGate,
  ratchet: runRatchet,
  halt: runHalt,
  resume: runResume,
  report: runReport,
  ship: runShip,
  blast: runBlast,
  rules: runRules,
  scope: runScope,
  verify: runVerify,
  doctor: runDoctor,
};

/**
 * kiln's own errors are answers to the user, so they print as a sentence. Anything
 * else is a bug in kiln, and a stack trace is the only useful thing to hand over.
 */
const EXPECTED = new Set(["ConfigError", "StateError", "StackError", "StepError", "ResolveError", "CeremonyError", "RulesError"]);

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
