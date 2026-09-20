#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { applyInit, planInit, proposeConfig } from "../lib/init.mjs";
import { canRatchet, ceremonyFor, ratchetRefusal, renderAutoRuled } from "../lib/ceremony.mjs";
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
  return 0;
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
  const by = rest.includes("--auto") ? "auto" : "user";
  const next = recordGate(readState(root, id), { key, decision, artifactPath: flag(rest, "--artifact"), answer, by });
  writeState(root, next);
  out(JSON.stringify({ recorded: true, gate: key, ...next.gates[key] }, null, 2));
  return 0;
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
  const state = newWork({ id, sessionId: flag(rest, "--session") ?? null, base, path: flag(rest, "--path") ?? "bounded" });
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
};

export function main(argv) {
  const [command, ...rest] = argv;
  const run = COMMANDS[command];
  if (run) return run(rest);
  out(USAGE);
  return command === undefined || command === "--help" ? 0 : 1;
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
